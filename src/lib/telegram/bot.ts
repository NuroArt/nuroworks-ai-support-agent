import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { rateLimit } from '@/lib/ratelimit';
import { ai } from '@/lib/ai/ai-service';
import type { ChatMessage } from '@/lib/ai/types';
import { createTicket, formatReference } from '@/lib/tickets';
import { answerCallback, escapeHtml, sendChatAction, sendMessage, type TgUpdate } from './api';

const HISTORY_TURNS = 10;
const FREE_PER_MINUTE = 8;

const BASE_PROMPT = `You are the NuroWorks AI Support Agent.

Your priorities, in order:
1. Solve the customer's problem.
2. Search the knowledge base before answering anything about the product.
3. Create a ticket when the problem needs human work.
4. Escalate when you cannot resolve it confidently.
5. Use tools whenever they improve accuracy.
6. Never invent support information.
7. Always prefer tool results over your own assumptions.

Tool rules:
- Any how-to, setup, configuration, billing or troubleshooting question: call
  SearchKnowledgeBase first. Do not answer product questions from memory.
- If the search comes back below the confidence floor, say you cannot confirm it
  and offer to escalate. Do not fill the gap with a plausible guess.
- Technical failure or bug report: CreateTicket, then NotifyAdmin.
- User asks for a human, or you are stuck: EscalateToHuman. That one tool opens
  the ticket and alerts staff — do not also call CreateTicket or NotifyAdmin.
- Asked about an existing request: GetTicketStatus with the reference.
- Asked whether something is down: GetSystemStatus. Never claim a service is
  healthy without calling it.
- Asked whether this would work for their business: you may call CollectLead,
  but only with details they have actually given you.

Style: plain text, no markdown. Short numbered steps beat paragraphs. Never
invent product names, prices, URLs, commands or steps.`
async function upsertUser(from: NonNullable<TgUpdate['message']>['from']) {
  if (!from) return null;
  return db.user.upsert({
    where: { telegramId: BigInt(from.id) },
    create: {
      telegramId: BigInt(from.id),
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      languageCode: from.language_code ?? null,
    },
    update: {
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastSeenAt: new Date(),
    },
  });
}

async function activeConversation(userId: string) {
  const open = await db.conversation.findFirst({
    where: { userId, isArchived: false },
    orderBy: { createdAt: 'desc' },
  });
  return open ?? db.conversation.create({ data: { userId } });
}

async function transcriptOf(conversationId: string): Promise<string> {
  const msgs = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  return msgs.map((m) => `${m.role === 'USER' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
}

async function escalate(chatId: number, userId: string, conversationId: string) {
  const transcript = await transcriptOf(conversationId);
  const lastUser = await db.message.findFirst({
    where: { conversationId, role: 'USER' },
    orderBy: { createdAt: 'desc' },
  });

  const ticket = await createTicket({
    userId,
    conversationId,
    transcript,
    fallbackSummary: lastUser?.content ?? 'Escalated from Telegram',
  });

  await sendMessage(
    chatId,
    `Ticket ${ticket.reference} created. A human has been notified and will reply here.\n\n` +
    `Check progress any time with /status.`,
  );

  const adminChat = env().TELEGRAM_ADMIN_CHAT_ID;
  if (adminChat) {
    const who = ticket.user.username ? `@${ticket.user.username}` : (ticket.user.firstName ?? 'unknown');
    const url = env().APP_URL ? `\n\n${env().APP_URL}/admin/tickets` : '';
    await sendMessage(
      adminChat,
      `<b>NEW SUPPORT REQUEST</b>\n\n` +
      `Ticket: <code>${ticket.reference}</code>\n` +
      `User: ${escapeHtml(who)}\n` +
      `Summary: ${escapeHtml(ticket.summary)}\n` +
      `Status: OPEN${escapeHtml(url)}`,
      { html: true },
    );
  } else {
    log.warn('ticket created but no admin chat configured', { reference: ticket.reference });
  }

  return ticket;
}

async function handleCommand(cmd: string, chatId: number, userId: string): Promise<boolean> {
  switch (cmd) {
    case '/start':
      await sendMessage(
        chatId,
        'NuroWorks Support.\n\n' +
        'Ask me anything about setup, billing, or your account and I will answer from our documentation.\n\n' +
        'If I cannot help, I will open a ticket and bring in a human.\n\n' +
        'Commands: /help /ticket /status /contact',
      );
      return true;

    case '/help':
      await sendMessage(
        chatId,
        '/start - begin\n' +
        '/ticket - open a support ticket now\n' +
        '/status - check your open tickets\n' +
        '/contact - reach a human directly\n\n' +
        'Or just describe your problem in your own words.',
      );
      return true;

    case '/contact':
      await sendMessage(chatId, 'Email support@nuroworks.com, or send /ticket to open one here.');
      return true;

    case '/status': {
      const tickets = await db.ticket.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      await sendMessage(
        chatId,
        tickets.length
          ? 'Your recent tickets:\n\n' +
            tickets.map((t) => `${t.reference} - ${t.status}\n${t.summary}`).join('\n\n')
          : 'You have no tickets. Describe a problem, or send /ticket to open one.',
      );
      return true;
    }

    case '/ticket': {
      const convo = await activeConversation(userId);
      await escalate(chatId, userId, convo.id);
      return true;
    }

    case '/admin': {
      const url = env().APP_URL;
      await sendMessage(chatId, url ? `Admin dashboard: ${url}/admin` : 'Dashboard URL is not configured.');
      return true;
    }

    default:
      return false;
  }
}

async function answer(chatId: number, userId: string, text: string) {
  const convo = await activeConversation(userId);
  await db.message.create({ data: { conversationId: convo.id, role: 'USER', content: text } });

  await sendChatAction(chatId);

  const settings = await db.adminSettings.findUnique({ where: { id: 'singleton' } });
  const user = await db.user.findUnique({ where: { id: userId } });

  // Prior turns give the model continuity. Tool blocks from earlier turns are
  // not replayed — only the plain text — because stale tool_use ids are
  // rejected and the results are already reflected in what was said.
  const history = await db.message.findMany({
    where: { conversationId: convo.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TURNS,
  });

  const messages: ChatMessage[] = history
    .reverse()
    .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
    .map((m) => ({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content }));

  const system = settings?.systemPrompt?.trim() || BASE_PROMPT;

  let reply: string;
  let toolsUsed: string[] = [];
  try {
    const result = await ai().runWithTools({
      system,
      messages,
      ctx: {
        userId,
        conversationId: convo.id,
        telegramChatId: chatId,
        username: user?.username ?? null,
      },
      maxTokens: 900,
      // Sonnet defaults to high effort. Support answers grounded in retrieved
      // context do not need it, and high effort multiplies latency and cost.
      effort: 'medium',
    });
    reply = result.text;
    toolsUsed = result.toolsUsed;
  } catch (e) {
    log.error('tool loop failed', e, { userId });
    await sendMessage(
      chatId,
      'Something went wrong on my end. Send /ticket and a human will pick it up.',
    );
    return;
  }

  if (!reply) {
    // The model used tools but produced no prose. Better to say something than
    // to leave the user staring at nothing.
    await sendMessage(
      chatId,
      toolsUsed.length
        ? 'I looked into that but could not put together a clear answer. Send /ticket to reach a human.'
        : 'I did not get a usable answer. Send /ticket to reach a human.',
    );
    return;
  }

  await db.message.create({
    data: { conversationId: convo.id, role: 'ASSISTANT', content: reply, sources: toolsUsed },
  });
  await sendMessage(chatId, reply);
}

/**
 * Single entry point for both webhook and dev polling, so the two paths cannot
 * drift apart in behaviour.
 */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat.id;
      const user = await upsertUser(cq.from);
      await answerCallback(cq.id);
      if (!chatId || !user) return;

      // Approval buttons come from the staff group, not a user conversation.
      if (cq.data?.startsWith('apr:')) {
        const [, verdict, approvalId] = cq.data.split(':');
        const { resolveApproval } = await import('@/lib/tools/registry');
        const who = cq.from.username ? `@${cq.from.username}` : String(cq.from.id);
        const outcome = await resolveApproval(approvalId, verdict === 'y', who);

        await sendMessage(chatId, `${outcome.message}\n\nDecided by ${who}.`);

        // Close the loop with whoever was waiting on it.
        if (outcome.notifyUserChatId && outcome.notifyUserChatId !== String(chatId)) {
          await sendMessage(
            outcome.notifyUserChatId,
            verdict === 'y'
              ? `Your request ${outcome.reference} was approved and has been actioned.`
              : `Your request ${outcome.reference} was not approved.`,
          );
        }
        return;
      }

      if (cq.data === 'esc:yes') {
        const convo = await activeConversation(user.id);
        await escalate(chatId, user.id, convo.id);
      } else if (cq.data === 'esc:no') {
        await sendMessage(chatId, 'Understood. Ask me something else any time.');
      }
      return;
    }

    const msg = update.message;
    const text = msg?.text?.trim();
    if (!msg || !text) return;

    const user = await upsertUser(msg.from);
    if (!user || user.isBlocked) return;

    // A mute lapses on its own, so this is a comparison rather than a flag the
    // bot would otherwise never clear.
    if (user.mutedUntil && user.mutedUntil > new Date()) return;

    if (!rateLimit(`tg:${user.telegramId}`, FREE_PER_MINUTE, 60_000)) {
      await sendMessage(msg.chat.id, 'Slow down a moment — too many messages. Try again shortly.');
      return;
    }

    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
      if (await handleCommand(cmd, msg.chat.id, user.id)) return;
      await sendMessage(msg.chat.id, 'Unknown command. Send /help.');
      return;
    }

    await answer(msg.chat.id, user.id, text);
  } catch (e) {
    log.error('update handler failed', e, { updateId: update.update_id });
  }
}

export { formatReference };
export type { TgUpdate } from './api';
