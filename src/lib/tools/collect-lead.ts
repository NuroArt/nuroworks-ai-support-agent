import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

export const collectLead = defineTool({
  name: 'CollectLead',
  category: 'sales',
  riskLevel: 'medium',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'Record a sales enquiry when someone asks whether NuroWorks would work for their ' +
    'business, asks about pricing for a team, or offers their contact details. Only call ' +
    'this with information the user has actually given you. Never invent an email or a ' +
    'company, and never ask for details they have not offered more than once.',
  schema: z.object({
    name: z.string().max(120).optional().describe('Only if the user stated it'),
    email: z.email().max(200).optional().describe('Only if the user gave one'),
    businessType: z.string().max(200).optional().describe('What their business does'),
    notes: z.string().max(600).optional().describe('What they are trying to achieve'),
  }),
  async execute(input, ctx) {
    const hasAnything = Boolean(input.name || input.email || input.businessType || input.notes);
    if (!hasAnything) {
      return {
        ok: false,
        error:
          'Nothing to record — the user has not given any details yet. Ask what their ' +
          'business does before calling this again.',
      };
    }

    // One lead per user per day; a long conversation should not create five rows.
    const recent = await db.lead.findFirst({
      where: { userId: ctx.userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      orderBy: { createdAt: 'desc' },
    });

    if (recent) {
      await db.lead.update({
        where: { id: recent.id },
        data: {
          name: input.name ?? recent.name,
          email: input.email ?? recent.email,
          businessType: input.businessType ?? recent.businessType,
          notes: input.notes ?? recent.notes,
        },
      });
      return { ok: true, content: 'Existing lead record updated with the new details.' };
    }

    await db.lead.create({
      data: {
        userId: ctx.userId,
        telegramUser: ctx.username ?? null,
        name: input.name ?? null,
        email: input.email ?? null,
        businessType: input.businessType ?? null,
        notes: input.notes ?? null,
      },
    });

    return {
      ok: true,
      content: 'Lead recorded. Thank the user and say someone will follow up.',
    };
  },
});
