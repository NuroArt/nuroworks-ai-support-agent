import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { SettingsForm } from './form';

export const dynamic = 'force-dynamic';

export default async function Settings() {
  const settings = await db.adminSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });

  let primary = 'not configured';
  let fallback = 'none';
  let chatModel = '—';
  let fastModel = '—';
  try {
    const e = env();
    primary = e.AI_PROVIDER === 'anthropic' ? 'claude' : 'openai';
    fallback = e.AI_PROVIDER === 'anthropic'
      ? (e.OPENAI_API_KEY ? 'openai' : 'none')
      : (e.ANTHROPIC_API_KEY ? 'claude' : 'none');
    chatModel = e.AI_PROVIDER === 'anthropic' ? e.CHAT_MODEL : e.OPENAI_CHAT_MODEL;
    fastModel = e.AI_PROVIDER === 'anthropic' ? e.FAST_MODEL : e.OPENAI_CHAT_MODEL;
  } catch { /* settings must still render with a broken env */ }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-muted">Behaviour of the support agent.</p>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Primary provider</div>
          <div className="mt-1 font-mono text-primary">{primary}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Fallback provider</div>
          <div className="mt-1 font-mono text-accent">{fallback}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Chat model</div>
          <div className="mt-1 font-mono text-primary">{chatModel}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Fast model</div>
          <div className="mt-1 font-mono text-primary">{fastModel}</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Providers and models come from environment variables and cannot be changed from the browser.
        Embeddings always use OpenAI, because Claude has no embeddings endpoint.
      </p>

      <SettingsForm
        initial={{
          systemPrompt: settings.systemPrompt,
          confidenceFloor: settings.confidenceFloor,
          escalationEnabled: settings.escalationEnabled,
        }}
      />
    </div>
  );
}
