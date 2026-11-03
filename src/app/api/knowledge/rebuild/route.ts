import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { ingestAll } from '@/lib/knowledge/ingest';
import { rateLimit } from '@/lib/ratelimit';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST() {
  if (!(await isAuthenticated())) return new NextResponse('unauthorized', { status: 401 });

  // Re-embedding costs money. Two accidental double-clicks should not bill twice.
  if (!rateLimit('knowledge:rebuild', 2, 60_000)) {
    return NextResponse.json({ error: 'A rebuild just ran. Wait a minute.' }, { status: 429 });
  }

  try {
    const result = await ingestAll();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    log.error('rebuild failed', e);
    return NextResponse.json({ error: 'Rebuild failed. Check server logs.' }, { status: 500 });
  }
}
