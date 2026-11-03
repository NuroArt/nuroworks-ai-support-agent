import { env } from '@/lib/env';
import { log } from '@/lib/log';

const base = () => `https://api.telegram.org/bot${env().TELEGRAM_BOT_TOKEN}`;

async function call<T>(method: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${base()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      log.warn('telegram api rejected', { method, reason: data.description });
      return null;
    }
    return data.result ?? null;
  } catch (e) {
    // A failed send must never take down the request that triggered it.
    log.error('telegram api unreachable', e, { method });
    return null;
  }
}

/** Telegram hard-rejects messages over 4096 characters. */
export function split(text: string, size = 3900): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + line + '\n').length > size) { out.push(buf); buf = ''; }
    buf += line + '\n';
  }
  if (buf.trim()) out.push(buf);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  opts: { buttons?: { text: string; data: string }[][]; html?: boolean } = {},
) {
  let last = null;
  for (const part of split(text)) {
    last = await call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: part,
      parse_mode: opts.html ? 'HTML' : undefined,
      reply_markup: opts.buttons
        ? { inline_keyboard: opts.buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) }
        : undefined,
    });
  }
  return last;
}

export const answerCallback = (id: string, text?: string) =>
  call('answerCallbackQuery', { callback_query_id: id, text });

export const sendChatAction = (chatId: string | number) =>
  call('sendChatAction', { chat_id: chatId, action: 'typing' });

export const setWebhook = (url: string, secret: string) =>
  call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });

export const deleteWebhook = () => call('deleteWebhook', { drop_pending_updates: false });

export const getUpdates = (offset: number) =>
  call<TgUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });

export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string; first_name?: string; language_code?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number } };
    from: { id: number; username?: string; first_name?: string; language_code?: string };
  };
};
