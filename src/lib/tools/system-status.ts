import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

/**
 * Status is read from the database, never inferred. If an operator has not
 * recorded a service, the tool says so rather than claiming everything is fine —
 * a bot that invents "all systems operational" during an outage is worse than
 * one that admits it does not know.
 */
export const getSystemStatus = defineTool({
  name: 'GetSystemStatus',
  category: 'system',
  riskLevel: 'low',
  requiredPermission: 'READ_ONLY',
  approvalRequired: false,
  description:
    'Report the operational status of NuroWorks services. Use when the user asks whether ' +
    'something is down, slow, or under maintenance. Never state a service is healthy ' +
    'without calling this first.',
  schema: z.object({
    service: z.string().max(60).optional()
      .describe('Service name, e.g. "bot" or "dashboard". Omit for all services.'),
  }),
  async execute({ service }) {
    const rows = await db.serviceStatus.findMany({
      where: service ? { service: { equals: service, mode: 'insensitive' } } : {},
      orderBy: { service: 'asc' },
    });

    if (rows.length === 0) {
      return {
        ok: true,
        content: service
          ? `No status is recorded for "${service}". Tell the user you cannot confirm its state, ` +
            'and offer to escalate if they are seeing a problem.'
          : 'No service statuses are recorded. Do not claim anything is operational.',
      };
    }

    return {
      ok: true,
      content: rows
        .map((r) =>
          `${r.service}: ${r.status}` +
          (r.detail ? ` — ${r.detail}` : '') +
          ` (updated ${r.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
        )
        .join('\n'),
    };
  },
});
