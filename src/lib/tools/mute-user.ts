import { z } from 'zod';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { defineTool } from './types';

const MAX_HOURS = 168;   // one week

/**
 * The reversible sibling of BanUser. Because it lapses on its own, it does not
 * need approval — which means the bot has a proportionate response available
 * and is not forced to choose between tolerating abuse and a permanent ban.
 */
export const muteUser = defineTool({
  name: 'MuteUser',
  category: 'community',
  riskLevel: 'medium',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'Temporarily stop responding to a user, for up to one week. Use for spam or abuse that ' +
    'does not warrant a permanent block. The mute lapses by itself. Never mute someone ' +
    'merely for being frustrated about a product problem.',
  schema: z.object({
    telegramId: z.string().regex(/^\d+$/).describe('Numeric Telegram id'),
    hours: z.number().int().min(1).max(MAX_HOURS).describe('How long, 1 to 168 hours'),
    reason: z.string().min(8).max(300).describe('What they did'),
  }),
  async execute({ telegramId, hours, reason }, ctx) {
    const target = await db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!target) return { ok: false, error: `No user with Telegram id ${telegramId}.` };

    // Same guard as BanUser: a hostile message must not be able to talk the bot
    // into silencing its own author.
    if (target.id === ctx.userId) {
      return { ok: false, error: 'A user cannot be muted through their own conversation.' };
    }

    const until = new Date(Date.now() + hours * 3600_000);
    await db.user.update({ where: { id: target.id }, data: { mutedUntil: until } });
    log.warn('user muted', { telegramId, hours, reason });

    return { ok: true, content: `User ${telegramId} muted until ${until.toISOString()}. Reason: ${reason}` };
  },
});
