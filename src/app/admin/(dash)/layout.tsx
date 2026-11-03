import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';
import { LogoutButton } from './logout-button';

const NAV = [
  { href: '/admin',           label: 'Dashboard' },
  { href: '/admin/tickets',   label: 'Tickets' },
  { href: '/admin/knowledge', label: 'Knowledge Base' },
  { href: '/admin/permissions', label: 'Tool Permissions' },
  { href: '/admin/settings',  label: 'Settings' },
];

/**
 * Login lives outside this route group on purpose. If it were inside, this
 * guard would redirect the login page to itself.
 */
export default async function DashLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect('/admin/login');

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-[#0C1424] p-5">
        <div className="mb-8">
          <div className="text-lg font-bold tracking-tight">
            Nuro<span className="text-primary">Works</span>
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Support Agent</div>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="block rounded-lg px-3 py-2 text-sm text-[#B7C4DA] transition hover:bg-surface hover:text-white"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <LogoutButton />
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
