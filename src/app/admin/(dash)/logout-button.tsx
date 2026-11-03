'use client';

import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch('/api/admin/login', { method: 'DELETE' });
        router.push('/admin/login');
        router.refresh();
      }}
      className="rounded-lg px-3 py-2 text-left text-sm text-muted transition hover:bg-surface hover:text-white"
    >
      Sign out
    </button>
  );
}
