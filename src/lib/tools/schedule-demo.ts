import { z } from 'zod';
import { db } from '@/lib/db';
import { defineTool } from './types';

/**
 * Slots are created by an operator in advance. The bot can list free ones and
 * claim a specific one, but cannot invent a time — a model that promises
 * "Tuesday at 3pm" with nothing in the calendar creates a no-show, not a demo.
 */
export const scheduleDemo = defineTool({
  name: 'ScheduleDemo',
  category: 'sales',
  riskLevel: 'medium',
  requiredPermission: 'OPERATIONS',
  approvalRequired: false,
  description:
    'List available demo slots, or book one. Call with no slot to see what is free, then ' +
    'call again with the exact startsAt you were given. Never state a time that this tool ' +
    'has not returned as available.',
  schema: z.object({
    startsAt: z.string().optional()
      .describe('ISO timestamp of the slot to book, exactly as listed. Omit to list availability.'),
    contact: z.string().max(200).optional()
      .describe('Email or phone the user gave for the booking'),
    notes: z.string().max(500).optional().describe('What they want to see'),
  }),
  async execute({ startsAt, contact, notes }, ctx) {
    const free = await db.demoSlot.findMany({
      where: { bookedById: null, startsAt: { gte: new Date() } },
      orderBy: { startsAt: 'asc' },
      take: 6,
    });

    if (!startsAt) {
      if (free.length === 0) {
        return {
          ok: true,
          content:
            'No demo slots are currently open. Tell the user you will have someone reach out ' +
            'to arrange a time, and consider CollectLead to capture their details.',
        };
      }
      return {
        ok: true,
        content:
          'Available slots (offer these exact times, nothing else):\n' +
          free.map((s) => `  ${s.startsAt.toISOString()} (${s.durationMin} min)`).join('\n'),
      };
    }

    const when = new Date(startsAt);
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: 'startsAt is not a valid timestamp. Use one exactly as listed.' };
    }

    const slot = await db.demoSlot.findUnique({ where: { startsAt: when } });
    if (!slot) {
      return {
        ok: false,
        error: `No slot exists at ${when.toISOString()}. List availability first and offer only those times.`,
      };
    }
    if (slot.bookedById) {
      return { ok: false, error: 'That slot was taken. List availability again and offer another.' };
    }

    // Conditional update: two users claiming the same slot concurrently means
    // one wins and the other is told to pick again, rather than double-booking.
    const claimed = await db.demoSlot.updateMany({
      where: { id: slot.id, bookedById: null },
      data: { bookedById: ctx.userId, bookedAt: new Date(), contact: contact ?? null, notes: notes ?? null },
    });

    if (claimed.count === 0) {
      return { ok: false, error: 'That slot was taken a moment ago. Offer another time.' };
    }

    return {
      ok: true,
      content: `Demo booked for ${when.toISOString()} (${slot.durationMin} minutes). Confirm this time to the user.`,
    };
  },
});
