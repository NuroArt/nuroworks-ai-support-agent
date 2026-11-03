'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RebuildButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/knowledge/rebuild', { method: 'POST' });
      const data = (await res.json()) as { indexed?: number; skipped?: number; failed?: number; error?: string };
      setMsg(res.ok
        ? `Indexed ${data.indexed}, skipped ${data.skipped}, failed ${data.failed}`
        : data.error ?? 'Rebuild failed');
      if (res.ok) router.refresh();
    } catch {
      setMsg('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        onClick={() => void run()}
        disabled={busy}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-[#06121F] transition hover:brightness-110 disabled:opacity-50"
      >
        {busy ? 'Rebuilding…' : 'Rebuild embeddings'}
      </button>
      {msg && <div className="mt-2 text-xs text-muted">{msg}</div>}
    </div>
  );
}
