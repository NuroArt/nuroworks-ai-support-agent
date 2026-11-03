import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { escapeHtml, sendMessage } from '@/lib/telegram/api';
import { defineTool } from './types';

export const notifyAdmin = defineTool({
  name: 'NotifyAdmin',
  category: 'support',
  riskLevel: 'medium',
  requiredPermission: 'SUPPORT',
  approvalRequired: false,
  description:
    'Post a ticket to the staff Telegram group so a human sees it. Call this immediately ' +
    'after CreateTicket. Takes the reference returned by that tool.',
  schema: z.object({
    reference: z.string().regex(/^NW-\d{4,}$/i).describe('Ticket reference, e.g. NW-0043'),
    urgency: z.enum(['normal', 'high']).optional()
      .describe('high only when the user reports data loss, a billing error, or a full outage'),
  }),
  async execute({ reference, urgency }, ctx) {
    const ticket = await db.ticket.findUnique({
      where: { reference: reference.toUpperCase() },
      include: { user: true },
    });
    if (!ticket) return { ok: false, error: `No ticket ${reference.toUpperCase()} to notify about.` };
    if (ticket.userId !== ctx.userId) {
      return { ok: false, error: 'That ticket belongs to a different user.' };
    }
    if (ticket.adminMessageId) {
      return { ok: true, content: `Admins were already notified about ${ticket.reference}.` };
    }

    const adminChat = env().TELEGRAM_ADMIN_CHAT_ID;
    if (!adminChat) {
      log.warn('no admin chat configured', { reference: ticket.reference });
      return {
        ok: false,
        error:
          'No staff group is configured, so nobody was notified. The ticket is still saved. ' +
          'Tell the user it is logged and will be picked up.',
      };
    }

    const who = ticket.user.username ? `@${ticket.user.username}` : (ticket.user.firstName ?? 'unknown');
    const link = env().APP_URL ? `\n\n${env().APP_URL}/admin/tickets` : '';

    const sent = await sendMessage(
      adminChat,
      `${urgency === 'high' ? '🔴 <b>URGENT — ' : '<b>'}NEW SUPPORT REQUEST</b>\n\n` +
      `Ticket: <code>${ticket.reference}</code>\n` +
      `User: ${escapeHtml(who)}\n` +
      `Summary: ${escapeHtml(ticket.summary)}\n` +
      `Status: ${ticket.status}${escapeHtml(link)}`,
      { html: true },
    );

    if (!sent) {
      return {
        ok: false,
        error: 'Telegram rejected the staff-group message. The ticket is saved but nobody was pinged.',
      };
    }

    // Remembering the message id lets a later status change edit the same post.
    await db.ticket.update({
      where: { id: ticket.id },
      data: { adminMessageId: sent.message_id },
    });

    return { ok: true, content: `Admins notified about ${ticket.reference}.` };
  },
});
