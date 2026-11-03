import { z } from 'zod';
import { db } from '@/lib/db';
import { createTicket } from '@/lib/tickets';
import { defineTool } from './types';

export const createTicketTool = defineTool({
  name: 'CreateTicket',
  category: 'support',
  riskLevel: 'medium',
  requiredPermission: 'SUPPORT',
  approvalRequired: false,
  description:
    'Open a support ticket. Use this for technical failures, bug reports, and anything the ' +
    'documentation cannot resolve. Returns the ticket reference. Do not call this more than ' +
    'once for the same problem — check SearchPreviousConversations first if unsure.',
  schema: z.object({
    summary: z.string().min(4).max(200)
      .describe('One sentence stating the problem. No greeting, no preamble.'),
  }),
  async execute({ summary }, ctx) {
    // An open ticket for the same user usually means a duplicate, not a new issue.
    const existing = await db.ticket.findFirst({
      where: { userId: ctx.userId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing && Date.now() - existing.createdAt.getTime() < 10 * 60_000) {
      return {
        ok: true,
        content:
          `An open ticket already exists: ${existing.reference} (${existing.status}) — ` +
          `"${existing.summary}". Tell the user it is already logged rather than opening another.`,
      };
    }

    const messages = await db.message.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const transcript = messages
      .map((m) => `${m.role === 'USER' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const ticket = await createTicket({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      transcript: transcript || summary,
      fallbackSummary: summary,
    });

    return {
      ok: true,
      content:
        `Ticket ${ticket.reference} created with status ${ticket.status}. ` +
        `Summary: "${ticket.summary}". Now call NotifyAdmin with this reference.`,
    };
  },
});
