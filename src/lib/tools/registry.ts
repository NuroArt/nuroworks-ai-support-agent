import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { escapeHtml, sendMessage } from '@/lib/telegram/api';
import type { PermissionLevel } from '@/generated/prisma/client';
import { agentPermission, decide, toolPolicies } from './permissions';
import { searchKnowledgeBase } from './search-kb';
import { createTicketTool } from './create-ticket';
import { getTicketStatus } from './get-ticket';
import { notifyAdmin } from './notify-admin';
import { escalateToHuman } from './escalate';
import { searchPreviousConversations } from './search-conversations';
import { getSystemStatus } from './system-status';
import { collectLead } from './collect-lead';
import { deleteTicket } from './delete-ticket';
import { banUser } from './ban-user';
import { sendBroadcastMessage } from './broadcast';
import { modifyKnowledgeBase } from './modify-kb';
import { scheduleDemo } from './schedule-demo';
import { muteUser } from './mute-user';
import { manageChannels } from './manage-channels';
import { getConfiguration } from './system-config';
import { lookupUser } from './lookup-user';
import type { ToolCallResult, ToolContext, ToolDefinition } from './types';

export const TOOLS: ToolDefinition[] = [
  // knowledge
  searchKnowledgeBase,
  searchPreviousConversations,
  modifyKnowledgeBase,
  // support
  getTicketStatus,
  createTicketTool,
  notifyAdmin,
  escalateToHuman,
  deleteTicket,
  // sales
  collectLead,
  scheduleDemo,
  // community
  muteUser,
  banUser,
  sendBroadcastMessage,
  manageChannels,
  // system
  getSystemStatus,
  getConfiguration,
  lookupUser,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Approvals do not sit forever; an unanswered one stops being actionable. */
const APPROVAL_TTL_MS = 24 * 3600_000;

function jsonSchemaFor(tool: ToolDefinition) {
  const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete schema.$schema;   // Anthropic rejects unknown top-level keys
  return schema;
}

/**
 * Only tools the agent may actually reach are advertised.
 *
 * A tool above the configured level is never shown to the model — offering a
 * capability and then refusing it wastes a turn and teaches the model to retry.
 * Approval-gated tools *are* advertised, because requesting one is legitimate.
 */
export async function availableTools(): Promise<ToolDefinition[]> {
  const [level, policies] = await Promise.all([agentPermission(), toolPolicies()]);
  return TOOLS.filter((t) => decide(t, level, policies.get(t.name)).verdict !== 'deny');
}

export async function toClaudeTools() {
  const tools = await availableTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.approvalRequired
      ? `${t.description} (An administrator must approve this before it runs.)`
      : t.description,
    input_schema: jsonSchemaFor(t),
  }));
}

export async function toOpenAITools() {
  const tools = await availableTools();
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: jsonSchemaFor(t) },
  }));
}

/** All tools with their current effective policy, for the admin screen. */
export async function toolMatrix() {
  const [level, policies] = await Promise.all([agentPermission(), toolPolicies()]);
  return TOOLS.map((t) => {
    const policy = policies.get(t.name);
    const d = decide(t, level, policy);
    return {
      name: t.name,
      description: t.description,
      category: t.category,
      riskLevel: t.riskLevel,
      requiredPermission: t.requiredPermission,
      approvalRequired: policy?.approvalRequired ?? t.approvalRequired,
      enabled: policy?.enabled ?? true,
      verdict: d.verdict,
      reason: 'reason' in d ? d.reason : null,
    };
  });
}

async function requestApproval(
  tool: ToolDefinition,
  call: { id: string; name: string; input: unknown },
  ctx: ToolContext,
): Promise<ToolCallResult> {
  const created = await db.toolApproval.create({
    data: {
      reference: `pending-${crypto.randomUUID()}`,
      toolName: tool.name,
      // Frozen at request time, so approving later runs exactly what was reviewed.
      input: call.input as object,
      riskLevel: tool.riskLevel,
      requestedById: ctx.userId,
      conversationId: ctx.conversationId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
  });

  const approval = await db.toolApproval.update({
    where: { id: created.id },
    data: { reference: `APR-${String(created.number).padStart(4, '0')}` },
    include: { requestedBy: true },
  });

  const adminChat = env().TELEGRAM_ADMIN_CHAT_ID;
  if (adminChat) {
    const who = approval.requestedBy.username
      ? `@${approval.requestedBy.username}`
      : (approval.requestedBy.firstName ?? 'unknown');
    await sendMessage(
      adminChat,
      `⚠️ <b>TOOL APPROVAL REQUIRED</b>\n\n` +
      `Request: <code>${approval.reference}</code>\n` +
      `Tool: <b>${escapeHtml(tool.name)}</b> (${tool.riskLevel} risk)\n` +
      `Requested by: ${escapeHtml(who)}\n\n` +
      `Arguments:\n<pre>${escapeHtml(JSON.stringify(call.input, null, 2).slice(0, 1200))}</pre>`,
      {
        html: true,
        buttons: [[
          { text: '✅ Approve', data: `apr:y:${approval.id}` },
          { text: '❌ Deny', data: `apr:n:${approval.id}` },
        ]],
      },
    );
  } else {
    log.warn('approval requested but no admin chat configured', { reference: approval.reference });
  }

  return {
    id: call.id,
    name: call.name,
    isError: false,
    content:
      `${tool.name} was not run. It is ${tool.riskLevel}-risk and needs an administrator to ` +
      `approve it. Request ${approval.reference} has been raised` +
      (adminChat ? ' and staff have been notified.' : ', but no staff group is configured.') +
      ' Tell the user it is awaiting approval and do not retry this tool.',
  };
}

/**
 * The single gate every tool call passes through.
 *
 * Permission is checked before validation, and validation before execution.
 * Input is model-generated, so nothing reaches a tool body unvalidated, and no
 * tool runs without a decision recorded against the current policy.
 */
export async function executeTool(
  call: { id: string; name: string; input: unknown },
  ctx: ToolContext,
  opts: { bypassApproval?: boolean } = {},
): Promise<ToolCallResult> {
  const tool = BY_NAME.get(call.name);
  if (!tool) {
    log.warn('model called an unknown tool', { name: call.name });
    const visible = await availableTools();
    return {
      id: call.id, name: call.name, isError: true,
      content: `No tool named ${call.name}. Available: ${visible.map((t) => t.name).join(', ')}.`,
    };
  }

  if (!opts.bypassApproval) {
    const [level, policies] = await Promise.all([agentPermission(), toolPolicies()]);
    const d = decide(tool, level, policies.get(tool.name));

    if (d.verdict === 'deny') {
      log.warn('tool call denied by policy', { tool: tool.name, agentLevel: level, reason: d.reason });
      return {
        id: call.id, name: call.name, isError: true,
        content: `${d.reason} Do not retry it. Tell the user you are not able to do that.`,
      };
    }

    if (d.verdict === 'needs_approval') {
      // Validate before raising a request, so an admin never reviews arguments
      // that would have failed anyway.
      const pre = tool.schema.safeParse(call.input);
      if (!pre.success) {
        return {
          id: call.id, name: call.name, isError: true,
          content: `Invalid input for ${call.name} — ${pre.error.issues.map((i) => i.message).join('; ')}.`,
        };
      }
      return requestApproval(tool, call, ctx);
    }
  }

  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    return {
      id: call.id, name: call.name, isError: true,
      content: `Invalid input for ${call.name} — ${detail}. Fix the arguments and try again.`,
    };
  }

  const started = Date.now();
  try {
    const result = await tool.execute(parsed.data, ctx);
    log.info('tool executed', {
      tool: call.name, ok: result.ok, risk: tool.riskLevel,
      ms: Date.now() - started, userId: ctx.userId,
    });
    return result.ok
      ? { id: call.id, name: call.name, content: result.content, isError: false }
      : { id: call.id, name: call.name, content: result.error, isError: true };
  } catch (e) {
    log.error('tool threw', e, { tool: call.name, userId: ctx.userId });
    return {
      id: call.id, name: call.name, isError: true,
      content:
        `${call.name} failed with an internal error. Do not retry it. ` +
        'Tell the user something went wrong and offer to escalate.',
    };
  }
}

/** Called from the Telegram callback when an admin presses Approve or Deny. */
export async function resolveApproval(
  approvalId: string,
  approve: boolean,
  decidedBy: string,
): Promise<{ reference: string; message: string; notifyUserChatId?: string }> {
  const approval = await db.toolApproval.findUnique({
    where: { id: approvalId },
    include: { requestedBy: true },
  });
  if (!approval) return { reference: 'unknown', message: 'That request no longer exists.' };

  if (approval.status !== 'PENDING') {
    return { reference: approval.reference, message: `${approval.reference} was already ${approval.status}.` };
  }
  if (approval.expiresAt < new Date()) {
    await db.toolApproval.update({ where: { id: approval.id }, data: { status: 'EXPIRED' } });
    return { reference: approval.reference, message: `${approval.reference} expired before it was answered.` };
  }

  if (!approve) {
    await db.toolApproval.update({
      where: { id: approval.id },
      data: { status: 'DENIED', decidedBy, decidedAt: new Date() },
    });
    return {
      reference: approval.reference,
      message: `${approval.reference} denied. ${approval.toolName} was not run.`,
      notifyUserChatId: approval.requestedBy.telegramId.toString(),
    };
  }

  const result = await executeTool(
    { id: approval.id, name: approval.toolName, input: approval.input },
    {
      userId: approval.requestedById,
      conversationId: approval.conversationId ?? '',
      telegramChatId: Number(approval.requestedBy.telegramId),
      username: approval.requestedBy.username,
    },
    { bypassApproval: true },
  );

  await db.toolApproval.update({
    where: { id: approval.id },
    data: {
      status: result.isError ? 'DENIED' : 'EXECUTED',
      decidedBy,
      decidedAt: new Date(),
      result: result.content.slice(0, 1000),
    },
  });

  log.warn('approval resolved', {
    reference: approval.reference, tool: approval.toolName, approved: true, ok: !result.isError,
  });

  return {
    reference: approval.reference,
    message: result.isError
      ? `${approval.reference} approved but ${approval.toolName} failed: ${result.content}`
      : `${approval.reference} approved. ${result.content}`,
    notifyUserChatId: approval.requestedBy.telegramId.toString(),
  };
}

export type { ToolContext, ToolCallResult, PermissionLevel };
