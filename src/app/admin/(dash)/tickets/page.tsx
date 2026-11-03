import { db } from '@/lib/db';
import { StatusSelect } from './status-select';

export const dynamic = 'force-dynamic';

export default async function Tickets() {
  const tickets = await db.ticket.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { user: { select: { username: true, firstName: true } } },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold">Tickets</h1>
      <p className="mt-1 text-sm text-muted">{tickets.length} total.</p>

      <div className="mt-6 overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-[#0C1424] text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3">Ticket ID</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-muted">Nothing here yet.</td></tr>
            )}
            {tickets.map((t) => (
              <tr key={t.id} className="border-t border-line align-top">
                <td className="px-4 py-3 font-mono text-primary">{t.reference}</td>
                <td className="px-4 py-3">{t.user.username ? `@${t.user.username}` : t.user.firstName ?? '—'}</td>
                <td className="max-w-sm px-4 py-3 text-[#B7C4DA]">{t.summary}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">
                  {t.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-4 py-3"><StatusSelect id={t.id} status={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
