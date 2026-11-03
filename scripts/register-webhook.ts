import { env } from '../src/lib/env';
import { setWebhook } from '../src/lib/telegram/api';

const e = env();
if (!e.APP_URL) {
  console.error('APP_URL must be set to your public https URL.');
  process.exit(1);
}

const url = `${e.APP_URL.replace(/\/$/, '')}/api/telegram/webhook`;
setWebhook(url, e.TELEGRAM_WEBHOOK_SECRET)
  .then((ok) => { console.log(ok ? `webhook registered: ${url}` : 'registration failed'); process.exit(ok ? 0 : 1); });
