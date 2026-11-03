import { z } from 'zod';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { defineTool } from './types';

export const banUser = defineTool({
  name: 'BanUser',
  category: 'community',
  riskLevel: 'high',
  requiredPermission: 'SUPER',
  approvalRequired: true,
  description:
    'Block a user so the bot stops responding to them. For abuse or spam only. Always ' +
    'requires an administrator to approve it. Never call this because someone is merely ' +
    'frustrated or rude about a product problem.',
  schema: z.object({
    telegramId: z.string().regex(/^\d+$/).describe('Numeric Telegram id of the user to block'),
    reason: z.string().min(8).max(300).describe('What they did'),
  }),
  async execute({ telegramId, reason }, ctx) {
    const target = await db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!target) return { ok: false, error: `No user with Telegram id ${telegramId}.` };

    // Without this, a hostile message could talk the bot into silencing its author.
    if (target.id === ctx.userId) {
      return { ok: false, error: 'A user cannot be blocked through their own conversation.' };
    }

    await db.user.update({ where: { id: target.id }, data: { isBlocked: true } });
    log.warn('user blocked via approved tool call', { telegramId, reason });

    return { ok: true, content: `User ${telegramId} blocked. Reason: ${reason}` };
  },
});
