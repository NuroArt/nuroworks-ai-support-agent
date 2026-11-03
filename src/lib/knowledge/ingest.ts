import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { ai } from '@/lib/ai/ai-service';
import { chunkText } from './chunk';
import { log } from '@/lib/log';

export const KNOWLEDGE_DIR = path.join(process.cwd(), 'knowledge');
const SUPPORTED = new Set(['.md', '.txt', '.pdf']);

async function extract(file: string, buf: Buffer): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.txt') return buf.toString('utf8');
  if (ext === '.pdf') {
    // unpdf bundles a serverless build of pdf.js — no native deps, so the
    // Alpine runtime image needs nothing extra.
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    return Array.isArray(text) ? text.join('\n\n') : text;
  }
  throw new Error(`unsupported extension ${ext}`);
}

/**
 * Re-index the knowledge directory.
 *
 * Files whose contents have not changed are skipped, so a rebuild after adding
 * one document costs one document's worth of embeddings, not the whole corpus.
 */
export async function ingestAll(opts: { force?: boolean } = {}) {
  let names: string[];
  try {
    names = await readdir(KNOWLEDGE_DIR);
  } catch {
    log.warn('knowledge directory missing', { dir: KNOWLEDGE_DIR });
    return { indexed: 0, skipped: 0, failed: 0 };
  }

  const files = names.filter((n) => SUPPORTED.has(path.extname(n).toLowerCase()));
  let indexed = 0, skipped = 0, failed = 0;

  for (const filename of files) {
    const full = path.join(KNOWLEDGE_DIR, filename);
    try {
      const [buf, st] = await Promise.all([readFile(full), stat(full)]);
      const hash = createHash('sha256').update(buf).digest('hex');

      const existing = await db.knowledgeDocument.findUnique({ where: { filename } });
      if (existing && existing.contentHash === hash && existing.status === 'INDEXED' && !opts.force) {
        skipped++;
        continue;
      }

      const doc = await db.knowledgeDocument.upsert({
        where: { filename },
        create: {
          filename, title: path.basename(filename, path.extname(filename)),
          mimeType: path.extname(filename).slice(1), sizeBytes: st.size,
          contentHash: hash, status: 'PENDING',
        },
        update: { contentHash: hash, sizeBytes: st.size, status: 'PENDING', error: null },
      });

      const text = await extract(filename, buf);
      const parts = chunkText(text);
      if (parts.length === 0) throw new Error('no extractable text');

      const vectors = await ai().embedText(parts);

      // Replace atomically: a half-reindexed document would answer from a mix
      // of old and new content.
      await db.$transaction([
        db.knowledgeChunk.deleteMany({ where: { documentId: doc.id } }),
        db.knowledgeChunk.createMany({
          data: parts.map((content, ordinal) => ({
            documentId: doc.id, ordinal, content, embedding: vectors[ordinal],
          })),
        }),
        db.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: 'INDEXED', chunkCount: parts.length, indexedAt: new Date(), error: null },
        }),
      ]);

      indexed++;
      log.info('indexed document', { filename, chunks: parts.length });
    } catch (e) {
      failed++;
      log.error('ingest failed', e, { filename });
      await db.knowledgeDocument.updateMany({
        where: { filename },
        data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 500) : 'unknown' },
      });
    }
  }

  // A file deleted from disk must stop answering questions.
  const onDisk = new Set(files);
  const orphans = await db.knowledgeDocument.findMany({ select: { id: true, filename: true } });
  const dead = orphans.filter((d) => !onDisk.has(d.filename));
  if (dead.length) {
    await db.knowledgeDocument.deleteMany({ where: { id: { in: dead.map((d) => d.id) } } });
    log.info('removed documents no longer on disk', { count: dead.length });
  }

  return { indexed, skipped, failed };
}
