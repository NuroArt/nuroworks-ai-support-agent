import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { handleUpdate, type TgUpdate } from '@/lib/telegram/bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Telegram echoes the secret we registered. Anything else is forged.
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || secret !== env().TELEGRAM_WEBHOOK_SECRET) {
    log.warn('rejected webhook with bad secret');
    return new NextResponse('forbidden', { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  // Telegram retries any non-2xx, which would duplicate replies on a slow
  // model call. Acknowledge immediately and process after responding.
  void handleUpdate(update);

  return NextResponse.json({ ok: true });
}
