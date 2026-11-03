import { db } from '@/lib/db';
import { ai } from '@/lib/ai/ai-service';
import { cosine } from './similarity';

export type Hit = {
  documentId: string;
  title: string;
  content: string;
  score: number;
};

/**
 * Cosine similarity computed in process over every chunk.
 *
 * At MVP scale (a few hundred chunks) this is a handful of milliseconds and
 * needs no Postgres extension, so it deploys anywhere. Past roughly 20k chunks,
 * move the vectors into pgvector and this function becomes a SQL query.
 */
export async function retrieve(question: string, topK = 4): Promise<Hit[]> {
  const [qv] = await ai().embedText([question]);
  if (!qv) return [];

  const chunks = await db.knowledgeChunk.findMany({
    select: {
      documentId: true, content: true, embedding: true,
      document: { select: { title: true, status: true } },
    },
  });

  return chunks
    .filter((c) => c.document.status === 'INDEXED' && c.embedding.length === qv.length)
    .map((c) => ({
      documentId: c.documentId,
      title: c.document.title,
      content: c.content,
      score: cosine(qv, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
