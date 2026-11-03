import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSession, destroySession, verifyPassword } from '@/lib/auth';
import { rateLimit } from '@/lib/ratelimit';
import { log } from '@/lib/log';

const body = z.object({ password: z.string().min(1) });

export async function POST(req: Request) {
  // Without this an attacker can grind the password at network speed.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!rateLimit(`login:${ip}`, 5, 300_000)) {
    return NextResponse.json({ error: 'Too many attempts. Wait five minutes.' }, { status: 429 });
  }

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !verifyPassword(parsed.data.password)) {
    log.warn('failed admin login', { ip });
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  await createSession();
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
