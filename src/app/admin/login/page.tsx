'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Login() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) { router.push('/admin'); router.refresh(); }
    else {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error ?? 'Incorrect password.');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7">
        <div className="text-lg font-bold">Nuro<span className="text-primary">Works</span></div>
        <div className="mb-6 text-[11px] uppercase tracking-[0.18em] text-muted">Support Agent</div>

        <label className="mb-2 block text-sm font-medium">Admin password</label>
        <input
          type="password" value={password} autoFocus
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-line bg-[#0C1424] px-3 py-2 text-sm text-white"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <button
          disabled={busy || !password}
          className="mt-5 w-full rounded-lg bg-primary py-2 text-sm font-semibold text-[#06121F] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
