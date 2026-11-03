import { z } from 'zod';
import { db } from '@/lib/db';
import { createTicket } from '@/lib/tickets';
import { defineTool } from './types';

export const escalateToHuman = defineTool({
  name: 'EscalateToHuman',
  category: 'support',
  riskLevel: 'medium',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'Hand the conversation to a human. Use when the user explicitly asks for a person, or ' +
    'when you have tried the documentation and cannot resolve the problem. This opens a ' +
    'ticket, archives the conversation, and alerts staff in one step — do not also call ' +
    'CreateTicket or NotifyAdmin.',
  schema: z.object({
    reason: z.string().min(4).max(300)
      .describe('Why a human is needed. One sentence, stating the unresolved problem.'),
  }),
  async execute({ reason }, ctx) {
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
      transcript: transcript || reason,
      fallbackSummary: reason,
    });

    // Notification is inlined rather than left to a second tool call, so an
    // escalation can never end with a ticket nobody has been told about.
    const { notifyAdmin } = await import('./notify-admin');
    const notified = await notifyAdmin.execute({ reference: ticket.reference }, ctx);

    return {
      ok: true,
      content:
        `Escalated. Ticket ${ticket.reference} created and the conversation archived. ` +
        (notified.ok ? 'Staff have been notified.' : `Staff notification failed: ${notified.error}`) +
        ` Tell the user the reference is ${ticket.reference} and a human will reply here.`,
    };
  },
});
