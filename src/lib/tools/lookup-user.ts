import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

/**
 * The read half of "User Management". Creating, promoting or deleting users is
 * not implemented — those are account-control operations, and the existing
 * BanUser and MuteUser already cover the moderation cases with their own gates.
 */
export const lookupUser = defineTool({
  name: 'LookupUser',
  category: 'system',
  riskLevel: 'low',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'Look up a user by Telegram id or username: when they first appeared, how many tickets ' +
    'they have, and whether they are blocked or muted. Use when an admin asks about a ' +
    'specific person. Does not return message contents.',
  schema: z.object({
    telegramId: z.string().regex(/^\d+$/).optional(),
    username: z.string().max(64).optional(),
  }).refine((v) => v.telegramId || v.username, { message: 'Give either telegramId or username' }),
  async execute({ telegramId, username }) {
    const user = await db.user.findFirst({
      where: telegramId
        ? { telegramId: BigInt(telegramId) }
        : { username: { equals: username!.replace(/^@/, ''), mode: 'insensitive' } },
      include: { _count: { select: { tickets: true, conversations: true, leads: true } } },
    });

    if (!user) return { ok: false, error: 'No matching user.' };

    const muted = user.mutedUntil && user.mutedUntil > new Date();
    return {
      ok: true,
      content: [
        `Telegram id: ${user.telegramId}`,
        `Username: ${user.username ? `@${user.username}` : 'none'}`,
        `First seen: ${user.createdAt.toISOString().slice(0, 10)}`,
        `Last seen: ${user.lastSeenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        `Tickets: ${user._count.tickets}  Conversations: ${user._count.conversations}  Leads: ${user._count.leads}`,
        `Blocked: ${user.isBlocked ? 'yes' : 'no'}`,
        `Muted: ${muted ? `until ${user.mutedUntil!.toISOString()}` : 'no'}`,
      ].join('\n'),
    };
  },
});
