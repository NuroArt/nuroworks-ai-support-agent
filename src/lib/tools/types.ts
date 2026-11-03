import type { z } from 'zod';
import type { PermissionLevel } from '@/generated/prisma/client';
import type { RiskLevel } from './permissions';

/** Everything a tool is allowed to know about who is asking. */
export type ToolContext = {
  userId: string;
  conversationId: string;
  telegramChatId: number;
  username?: string | null;
};

export type ToolResult =
  | { ok: true; content: string }
  /** `error` is shown to Claude, so it says what went wrong and what to try. */
  | { ok: false; error: string };

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Grouping for the admin screen and the system prompt. */
  category: ToolCategory;
  /** low | medium | high | critical — drives whether sign-off is needed. */
  riskLevel: RiskLevel;
  /** Minimum agent permission level that may call this at all. */
  requiredPermission: PermissionLevel;
  /** When true, every call waits for a human even at SUPER level. */
  approvalRequired: boolean;
  /** One schema serves both Claude's input_schema and runtime validation. */
  schema: S;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** Helper that preserves the inferred input type through the interface. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export const TOOL_CATEGORIES = ['knowledge', 'support', 'sales', 'community', 'system'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  knowledge: 'Knowledge',
  support:   'Support',
  sales:     'Sales',
  community: 'Community',
  system:    'System',
};

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolCallResult = { id: string; name: string; content: string; isError: boolean };
