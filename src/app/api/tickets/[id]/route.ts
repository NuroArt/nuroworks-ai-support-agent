import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { setStatus } from '@/lib/tickets';
import { env } from '@/lib/env';
import { sendMessage } from '@/lib/telegram/api';
import { log } from '@/lib/log';

const body = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticated())) return new NextResponse('unauthorized', { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'status is required' }, { status: 400 });

  const { id } = await ctx.params;
  const ticket = await setStatus(id, parsed.data.status);

  // Tell the person who raised it, not just the dashboard.
  if (parsed.data.status === 'RESOLVED' || parsed.data.status === 'CLOSED') {
    try {
      await sendMessage(
        ticket.user.telegramId.toString(),
        `Ticket ${ticket.reference} is now ${parsed.data.status}.\n\nReply here if the problem is still happening.`,
      );
    } catch (e) {
      log.warn('could not notify user of status change', { reference: ticket.reference });
    }
  }
  void env;

  return NextResponse.json({ ok: true, reference: ticket.reference, status: ticket.status });
}
