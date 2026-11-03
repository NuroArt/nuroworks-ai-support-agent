import { db } from '@/lib/db';
import { dashboardStats } from '@/lib/tickets';
import { ai } from '@/lib/ai/ai-service';

export const dynamic = 'force-dynamic';

function Card({ label, value, tone }: { label: string; value: number; tone?: 'primary' | 'accent' }) {
  const colour = tone === 'primary' ? 'text-primary' : tone === 'accent' ? 'text-accent' : 'text-white';
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted">{label}</div>
      <div className={`mt-2 text-4xl font-bold tabular-nums ${colour}`}>{value}</div>
    </div>
  );
}

export default async function Dashboard() {
  const stats = await dashboardStats();

  // The dashboard must still render when no AI keys are configured.
  let usage: Awaited<ReturnType<ReturnType<typeof ai>['usageSummary']>> = [];
  try { usage = await ai().usageSummary(30); } catch { /* keys not set */ }
  const recent = await db.ticket.findMany({
    orderBy: { createdAt: 'desc' },
    take: 8,
    include: { user: { select: { username: true, firstName: true } } },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted">Support activity across Telegram.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card label="Open Tickets"     value={stats.open}        tone="primary" />
        <Card label="Total Tickets"    value={stats.total} />
        <Card label="Resolved"         value={stats.resolved}    tone="accent" />
        <Card label="Active Users 30d" value={stats.activeUsers} />
      </div>

      {usage.length > 0 && (
        <>
          <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-[0.14em] text-muted">
            Model usage, last 30 days
          </h2>
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-[#0C1424] text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-4 py-3">Operation</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3 text-right">In</th>
                  <th className="px-4 py-3 text-right">Out</th>
                </tr>
              </thead>
              <tbody>
                {usage
                  .sort((a, b) => b.calls - a.calls)
                  .map((u) => (
                    <tr key={`${u.operation}-${u.provider}-${u.model}`} className="border-t border-line">
                      <td className="px-4 py-3 font-medium">{u.operation}</td>
                      <td className="px-4 py-3 text-muted">{u.provider}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">{u.model}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{u.calls}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {u.inputTokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {u.outputTokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-[0.14em] text-muted">
        Recent tickets
      </h2>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-[#0C1424] text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted">No tickets yet.</td></tr>
            )}
            {recent.map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="px-4 py-3 font-mono text-primary">{t.reference}</td>
                <td className="px-4 py-3">{t.user.username ? `@${t.user.username}` : t.user.firstName ?? '—'}</td>
                <td className="max-w-md truncate px-4 py-3 text-[#B7C4DA]">{t.summary}</td>
                <td className="px-4 py-3 text-muted">{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
