'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

const OPTIONS = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export function StatusSelect({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    const previous = value;
    setValue(next);                       // optimistic
    setError(null);
    const res = await fetch(`/api/tickets/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    if (!res.ok) {
      setValue(previous);                 // roll back so the UI never lies
      setError('Failed');
      return;
    }
    start(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        disabled={pending}
        onChange={(e) => void change(e.target.value)}
        className="rounded-md border border-line bg-[#0C1424] px-2 py-1 text-xs text-white disabled:opacity-50"
      >
        {OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
