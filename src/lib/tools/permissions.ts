import { db } from '@/lib/db';
import type { PermissionLevel } from '@/generated/prisma/client';
import type { ToolDefinition } from './types';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Ordered, so a check is a comparison rather than a lookup table. */
const RANK: Record<PermissionLevel, number> = {
  READ_ONLY: 1,
  SUPPORT: 2,
  OPERATIONS: 3,
  SUPER: 4,
};

export const PERMISSION_LEVELS: PermissionLevel[] = ['READ_ONLY', 'SUPPORT', 'OPERATIONS', 'SUPER'];

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  READ_ONLY:  'Read only — can look things up, cannot change anything',
  SUPPORT:    'Support agent — can open tickets and notify staff',
  OPERATIONS: 'Operations agent — adds escalation and lead capture',
  SUPER:      'Super agent — all approved tools; high-risk ones still need sign-off',
};

export type Decision =
  | { verdict: 'allow' }
  | { verdict: 'needs_approval'; reason: string }
  | { verdict: 'deny'; reason: string };

/** The agent's current ceiling. Defaults to SUPPORT, not SUPER. */
export async function agentPermission(): Promise<PermissionLevel> {
  const settings = await db.adminSettings.findUnique({ where: { id: 'singleton' } });
  return settings?.agentPermission ?? 'SUPPORT';
}

export async function toolPolicies(): Promise<Map<string, { enabled: boolean; approvalRequired: boolean | null }>> {
  const rows = await db.toolPolicy.findMany();
  return new Map(rows.map((r) => [r.toolName, { enabled: r.enabled, approvalRequired: r.approvalRequired }]));
}

/**
 * The single gate every tool call passes through.
 *
 * Order matters: an explicitly disabled tool is denied even to a SUPER agent,
 * because that switch is how an operator stops a misbehaving tool immediately.
 */
export function decide(
  tool: ToolDefinition,
  level: PermissionLevel,
  policy?: { enabled: boolean; approvalRequired: boolean | null },
): Decision {
  if (policy && !policy.enabled) {
    return { verdict: 'deny', reason: `${tool.name} has been switched off by an administrator.` };
  }

  if (RANK[level] < RANK[tool.requiredPermission]) {
    return {
      verdict: 'deny',
      reason:
        `${tool.name} requires the ${tool.requiredPermission} permission level, ` +
        `and the agent is set to ${level}.`,
    };
  }

  const needsApproval = policy?.approvalRequired ?? tool.approvalRequired;
  if (needsApproval) {
    return {
      verdict: 'needs_approval',
      reason: `${tool.name} is ${tool.riskLevel}-risk and needs an administrator to approve it.`,
    };
  }

  return { verdict: 'allow' };
}

export { RANK };
