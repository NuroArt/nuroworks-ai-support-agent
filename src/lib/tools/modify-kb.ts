import { z } from 'zod';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { KNOWLEDGE_DIR } from '@/lib/knowledge/ingest';
import { defineTool } from './types';

export const modifyKnowledgeBase = defineTool({
  name: 'ModifyKnowledgeBase',
  category: 'knowledge',
  riskLevel: 'high',
  requiredPermission: 'SUPER',
  approvalRequired: true,
  description:
    'Create, overwrite or delete a documentation file. Changes what the bot tells every ' +
    'future user, so it always requires an administrator to approve it. Re-index with a ' +
    'rebuild afterwards.',
  schema: z.object({
    action: z.enum(['write', 'delete']),
    filename: z.string().min(3).max(100)
      .regex(/^[A-Za-z0-9._-]+\.(md|txt)$/, 'Must be a .md or .txt filename with no path')
      .describe('Filename only, e.g. refunds.md'),
    content: z.string().max(60_000).optional().describe('Required for write'),
  }),
  async execute({ action, filename, content }) {
    // The regex above already forbids separators; this is the belt to its braces.
    // A filename reaching the filesystem from a model is worth checking twice.
    const resolved = path.resolve(KNOWLEDGE_DIR, filename);
    if (path.dirname(resolved) !== path.resolve(KNOWLEDGE_DIR)) {
      return { ok: false, error: 'Filename must not contain a path.' };
    }

    if (action === 'delete') {
      try {
        await unlink(resolved);
      } catch {
        return { ok: false, error: `${filename} does not exist.` };
      }
      await db.knowledgeDocument.deleteMany({ where: { filename } });
      log.warn('knowledge file deleted via approved tool call', { filename });
      return { ok: true, content: `${filename} deleted. Run a rebuild to update the index.` };
    }

    if (!content) return { ok: false, error: 'content is required when action is write.' };

    await writeFile(resolved, content, 'utf8');
    log.warn('knowledge file written via approved tool call', { filename, bytes: content.length });
    return {
      ok: true,
      content: `${filename} written (${content.length} characters). Run a rebuild to index it.`,
    };
  },
});
