import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthenticated())) return new NextResponse('unauthorized', { status: 401 });
  const docs = await db.knowledgeDocument.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json(docs);
}
