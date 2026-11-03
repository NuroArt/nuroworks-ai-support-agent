/**
 * Local development without a public URL.
 *
 * Telegram will not deliver to localhost, and running this at the same time as
 * a registered webhook means every update is handled twice. deleteWebhook on
 * start makes that mistake impossible.
 */
import { deleteWebhook, getUpdates } from '../src/lib/telegram/api';
import { handleUpdate } from '../src/lib/telegram/bot';

let offset = 0;
let running = true;

async function loop() {
  await deleteWebhook();
  console.log('polling for updates — webhook disabled, Ctrl+C to stop');

  while (running) {
    const updates = await getUpdates(offset);
    for (const u of updates ?? []) {
      offset = u.update_id + 1;
      await handleUpdate(u);
    }
    if (!updates) await new Promise((r) => setTimeout(r, 2000));
  }
}

process.on('SIGINT', () => { running = false; console.log('\nstopped'); process.exit(0); });
loop().catch((e) => { console.error(e); process.exit(1); });
