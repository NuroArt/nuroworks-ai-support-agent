import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await isAuthenticated())) return new NextResponse('unauthorized', { status: 401 });

  const status = new URL(req.url).searchParams.get('status');
  const valid = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
  const where = valid.includes(status as never) ? { status: status as never } : {};

  const tickets = await db.ticket.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { user: { select: { username: true, firstName: true, telegramId: true } } },
  });

  return NextResponse.json(
    tickets.map((t) => ({ ...t, user: { ...t.user, telegramId: t.user.telegramId.toString() } })),
  );
}
