import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

export const searchPreviousConversations = defineTool({
  name: 'SearchPreviousConversations',
  category: 'knowledge',
  riskLevel: 'low',
  requiredPermission: 'SUPPORT',
  approvalRequired: false,
  description:
    "Look up this user's history: past tickets and earlier conversations. Use it to avoid " +
    'repeating advice they have already had, or to check whether a problem is recurring. ' +
    'Scoped to the current user only.',
  schema: z.object({
    keyword: z.string().max(100).optional()
      .describe('Optional filter. Omit to get the most recent history.'),
  }),
  async execute({ keyword }, ctx) {
    const tickets = await db.ticket.findMany({
      where: {
        userId: ctx.userId,
        ...(keyword ? { summary: { contains: keyword, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const messages = await db.message.findMany({
      where: {
        role: 'USER',
        conversation: { userId: ctx.userId, isArchived: true },
        ...(keyword ? { content: { contains: keyword, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    if (tickets.length === 0 && messages.length === 0) {
      return { ok: true, content: 'No earlier tickets or archived conversations for this user.' };
    }

    const parts: string[] = [];
    if (tickets.length) {
      parts.push(
        'Previous tickets:\n' +
        tickets.map((t) =>
          `  ${t.reference} [${t.status}] ${t.createdAt.toISOString().slice(0, 10)} — ${t.summary}`,
        ).join('\n'),
      );
    }
    if (messages.length) {
      parts.push(
        'Earlier questions from this user:\n' +
        messages.map((m) => `  ${m.createdAt.toISOString().slice(0, 10)} — ${m.content.slice(0, 160)}`).join('\n'),
      );
    }
    return { ok: true, content: parts.join('\n\n') };
  },
});
