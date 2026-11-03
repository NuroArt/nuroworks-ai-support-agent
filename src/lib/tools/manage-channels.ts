import { z } from 'zod';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { defineTool } from './types';

/**
 * Listing is harmless; changing where announcements go is not. Adding a channel
 * is how a bot could be talked into broadcasting to an attacker's chat, so
 * anything that writes is gated behind approval.
 */
export const manageChannels = defineTool({
  name: 'ManageChannels',
  category: 'community',
  riskLevel: 'high',
  requiredPermission: 'SUPER',
  approvalRequired: true,
  description:
    'List, add, or deactivate the Telegram channels the bot may post announcements to. ' +
    'Adding or changing a channel always requires an administrator to approve it.',
  schema: z.object({
    action: z.enum(['list', 'add', 'deactivate']),
    chatId: z.string().regex(/^-?\d+$/).optional().describe('Required for add and deactivate'),
    title: z.string().max(120).optional().describe('Required for add'),
    purpose: z.string().max(200).optional(),
  }),
  async execute({ action, chatId, title, purpose }) {
    if (action === 'list') {
      const channels = await db.channel.findMany({ orderBy: { createdAt: 'asc' } });
      if (channels.length === 0) return { ok: true, content: 'No channels are configured.' };
      return {
        ok: true,
        content: channels
          .map((c) => `${c.title} (${c.chatId}) — ${c.isActive ? 'active' : 'inactive'}${c.purpose ? ` — ${c.purpose}` : ''}`)
          .join('\n'),
      };
    }

    if (!chatId) return { ok: false, error: `chatId is required for ${action}.` };

    if (action === 'deactivate') {
      const updated = await db.channel.updateMany({ where: { chatId }, data: { isActive: false } });
      if (updated.count === 0) return { ok: false, error: `No channel with id ${chatId}.` };
      log.warn('channel deactivated', { chatId });
      return { ok: true, content: `Channel ${chatId} deactivated.` };
    }

    if (!title) return { ok: false, error: 'title is required when adding a channel.' };

    await db.channel.upsert({
      where: { chatId },
      create: { chatId, title, purpose: purpose ?? null },
      update: { title, purpose: purpose ?? null, isActive: true },
    });
    log.warn('channel added', { chatId, title });
    return { ok: true, content: `Channel "${title}" (${chatId}) is now active.` };
  },
});
