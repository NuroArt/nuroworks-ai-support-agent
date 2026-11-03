import { z } from 'zod';
import { db } from '@/lib/db';
import { retrieve } from '@/lib/knowledge/retrieve';
import { defineTool } from './types';

export const searchKnowledgeBase = defineTool({
  name: 'SearchKnowledgeBase',
  category: 'knowledge',
  riskLevel: 'low',
  requiredPermission: 'READ_ONLY',
  approvalRequired: false,
  description:
    'Search the NuroWorks documentation. Use this before answering any question about how ' +
    'the product works, setup, configuration, billing, or troubleshooting. Returns passages ' +
    'with a confidence score between 0 and 1. If the top score is low, the documentation does ' +
    'not cover the question — say so rather than guessing.',
  schema: z.object({
    query: z.string().min(2).max(500)
      .describe('The search query. Use the user\'s own words plus any obvious synonyms.'),
  }),
  async execute({ query }) {
    const hits = await retrieve(query, 4);
    if (hits.length === 0) {
      return { ok: true, content: 'No documents are indexed, or nothing matched. Confidence: 0.' };
    }

    const settings = await db.adminSettings.findUnique({ where: { id: 'singleton' } });
    const floor = settings?.confidenceFloor ?? 0.28;
    const best = hits[0].score;

    const body = hits
      .map((h, i) => `[${i + 1}] ${h.title} (score ${h.score.toFixed(3)})\n${h.content}`)
      .join('\n\n---\n\n');

    const verdict = best < floor
      ? `\n\nTop score ${best.toFixed(3)} is below the confidence floor of ${floor}. ` +
        'The documentation likely does not answer this. Tell the user you cannot confirm it, ' +
        'and offer to escalate.'
      : `\n\nTop score ${best.toFixed(3)}, above the floor of ${floor}.`;

    return { ok: true, content: body + verdict };
  },
});
