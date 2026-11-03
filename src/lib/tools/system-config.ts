import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { defineTool } from './types';

/**
 * Read-only on purpose.
 *
 * The spec's "Configuration" system tool implies writing too. It is not
 * implemented, and that is deliberate: the settings this would edit include the
 * confidence floor and the system prompt — the two controls that decide when
 * the bot is allowed to guess. A model able to lower its own confidence floor
 * can talk itself out of every safety check the floor exists to enforce.
 *
 * Secrets are never exposed here. Only operational settings an admin has set.
 */
export const getConfiguration = defineTool({
  name: 'GetConfiguration',
  category: 'system',
  riskLevel: 'low',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'Read the current operational configuration: which AI provider is active, the ' +
    'confidence floor, and the permission level. Useful when a user or admin asks how the ' +
    'bot is set up. Never returns API keys or secrets.',
  schema: z.object({}),
  async execute() {
    const settings = await db.adminSettings.findUnique({ where: { id: 'singleton' } });
    const e = env();
    return {
      ok: true,
      content: [
        `AI provider: ${e.AI_PROVIDER}`,
        `Chat model: ${e.AI_PROVIDER === 'anthropic' ? e.CHAT_MODEL : e.OPENAI_CHAT_MODEL}`,
        `Fast model: ${e.FAST_MODEL}`,
        `Confidence floor: ${settings?.confidenceFloor ?? 0.28}`,
        `Escalation enabled: ${settings?.escalationEnabled ?? true}`,
        `Agent permission level: ${settings?.agentPermission ?? 'SUPPORT'}`,
        `Custom system prompt: ${settings?.systemPrompt?.trim() ? 'set' : 'using the default'}`,
      ].join('\n'),
    };
  },
});
