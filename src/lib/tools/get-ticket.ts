import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

export const getTicketStatus = defineTool({
  name: 'GetTicketStatus',
  category: 'support',
  riskLevel: 'low',
  requiredPermission: 'READ_ONLY',
  approvalRequired: false,
  description:
    'Look up a support ticket by its reference, for example NW-0043. Returns status and ' +
    'timestamps. Use when the user asks about an existing request.',
  schema: z.object({
    reference: z.string().regex(/^NW-\d{4,}$/i, 'Expected a reference like NW-0043')
      .describe('The ticket reference, e.g. NW-0043'),
  }),
  async execute({ reference }, ctx) {
    const ticket = await db.ticket.findUnique({
      where: { reference: reference.toUpperCase() },
    });

    if (!ticket) {
      return { ok: false, error: `No ticket found with reference ${reference.toUpperCase()}.` };
    }

    // A reference is guessable, so never reveal someone else's ticket.
    if (ticket.userId !== ctx.userId) {
      return {
        ok: false,
        error:
          `Ticket ${reference.toUpperCase()} does not belong to this user. ` +
          'Do not reveal any detail about it. Ask them to check the reference.',
      };
    }

    const parts = [
      `Reference: ${ticket.reference}`,
      `Status: ${ticket.status}`,
      `Summary: ${ticket.summary}`,
      `Opened: ${ticket.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ];
    if (ticket.resolvedAt) {
      parts.push(`Closed: ${ticket.resolvedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    }
    return { ok: true, content: parts.join('\n') };
  },
});
