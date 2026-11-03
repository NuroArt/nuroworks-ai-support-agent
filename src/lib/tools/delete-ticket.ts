import { z } from 'zod';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { defineTool } from './types';

export const deleteTicket = defineTool({
  name: 'DeleteTicket',
  category: 'support',
  riskLevel: 'high',
  requiredPermission: 'SUPER',
  approvalRequired: true,
  description:
    'Permanently delete a support ticket. Use only when a ticket was opened in error or ' +
    'contains information that must not be retained. This cannot be undone and always ' +
    'requires an administrator to approve it.',
  schema: z.object({
    reference: z.string().regex(/^NW-\d{4,}$/i).describe('Ticket reference, e.g. NW-0043'),
    reason: z.string().min(8).max(300).describe('Why this ticket must be removed'),
  }),
  async execute({ reference, reason }) {
    const ticket = await db.ticket.findUnique({ where: { reference: reference.toUpperCase() } });
    if (!ticket) return { ok: false, error: `No ticket ${reference.toUpperCase()}.` };

    await db.ticket.delete({ where: { id: ticket.id } });
    log.warn('ticket deleted via approved tool call', { reference: ticket.reference, reason });

    return { ok: true, content: `Ticket ${ticket.reference} permanently deleted. Reason: ${reason}` };
  },
});
