import { db } from '@/lib/db';
import type { TicketStatus } from '@/generated/prisma/client';
import { ai } from '@/lib/ai/ai-service';
import { log } from '@/lib/log';

export function formatReference(n: number): string {
  return `NW-${String(n).padStart(4, '0')}`;
}

export async function createTicket(opts: {
  userId: string;
  conversationId?: string;
  transcript: string;
  fallbackSummary: string;
}) {
  const summary = await ai().generateTicketSummary(opts.transcript, opts.fallbackSummary);

  // `number` is a Postgres sequence, so concurrent escalations cannot collide.
  // The reference is derived from it immediately after insert.
  const created = await db.ticket.create({
    data: {
      reference: `pending-${crypto.randomUUID()}`,
      userId: opts.userId,
      conversationId: opts.conversationId,
      summary,
      transcript: opts.transcript.slice(0, 20_000),
    },
  });

  const ticket = await db.ticket.update({
    where: { id: created.id },
    data: { reference: formatReference(created.number) },
    include: { user: true },
  });

  if (opts.conversationId) {
    await db.conversation.update({
      where: { id: opts.conversationId },
      data: { isArchived: true },
    });
  }

  log.info('ticket created', { reference: ticket.reference, userId: opts.userId });
  return ticket;
}

export async function setStatus(id: string, status: TicketStatus) {
  return db.ticket.update({
    where: { id },
    data: { status, resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? new Date() : null },
    include: { user: true },
  });
}

export async function dashboardStats() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const [open, total, resolved, activeUsers] = await Promise.all([
    db.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    db.ticket.count(),
    db.ticket.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] } } }),
    db.user.count({ where: { lastSeenAt: { gte: since } } }),
  ]);
  return { open, total, resolved, activeUsers };
}
