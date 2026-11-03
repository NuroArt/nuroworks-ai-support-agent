import { z } from 'zod';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { sendMessage } from '@/lib/telegram/api';
import { defineTool } from './types';

const MAX_RECIPIENTS = 2000;

export const sendBroadcastMessage = defineTool({
  name: 'SendBroadcastMessage',
  category: 'community',
  riskLevel: 'high',
  requiredPermission: 'SUPER',
  approvalRequired: true,
  description:
    'Send a message to every user who has talked to the bot. For outage notices and ' +
    'important announcements only. Always requires an administrator to approve it, and ' +
    'the exact text is shown to them before they decide.',
  schema: z.object({
    message: z.string().min(10).max(1000).describe('Exact text to send. It is not rewritten.'),
    activeWithinDays: z.number().int().min(1).max(365).optional()
      .describe('Only users seen in this many days. Omit for everyone.'),
  }),
  async execute({ message, activeWithinDays }) {
    const where = {
      isBlocked: false,
      ...(activeWithinDays
        ? { lastSeenAt: { gte: new Date(Date.now() - activeWithinDays * 86_400_000) } }
        : {}),
    };

    const total = await db.user.count({ where });
    if (total > MAX_RECIPIENTS) {
      return {
        ok: false,
        error:
          `${total} recipients exceeds the ${MAX_RECIPIENTS} cap. Narrow it with ` +
          'activeWithinDays, or run the broadcast from the dashboard instead.',
      };
    }

    const users = await db.user.findMany({ where, select: { telegramId: true } });
    let sent = 0;
    let failed = 0;

    for (const u of users) {
      const result = await sendMessage(u.telegramId.toString(), message);
      if (result) sent++; else failed++;
      // Telegram throttles bulk sends; roughly 25/sec is the practical ceiling.
      await new Promise((r) => setTimeout(r, 40));
    }

    log.warn('broadcast sent via approved tool call', { sent, failed, total });
    return { ok: true, content: `Broadcast delivered to ${sent} users. ${failed} failed.` };
  },
});
