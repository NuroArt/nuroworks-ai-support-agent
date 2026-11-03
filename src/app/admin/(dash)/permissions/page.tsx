import { db } from '@/lib/db';
import { toolMatrix } from '@/lib/tools/registry';
import { PERMISSION_LABELS, PERMISSION_LEVELS } from '@/lib/tools/permissions';
import { CATEGORY_LABELS, TOOL_CATEGORIES } from '@/lib/tools/types';
import { setAgentPermission, setToolPolicy } from './actions';

export const dynamic = 'force-dynamic';

const RISK_TONE: Record<string, string> = {
  low: 'text-accent',
  medium: 'text-primary',
  high: 'text-amber-400',
  critical: 'text-red-400',
};

const VERDICT_TONE: Record<string, string> = {
  allow: 'text-accent',
  needs_approval: 'text-amber-400',
  deny: 'text-muted line-through',
};

export default async function Permissions() {
  const settings = await db.adminSettings.upsert({
    where: { id: 'singleton' }, create: { id: 'singleton' }, update: {},
  });
  const matrix = await toolMatrix();
  const pending = await db.toolApproval.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { requestedBy: { select: { username: true, firstName: true } } },
  });

  const allowed = matrix.filter((m) => m.verdict !== 'deny').length;

  return (
    <div>
      <h1 className="text-2xl font-bold">Tool permissions</h1>
      <p className="mt-1 text-sm text-muted">
        The agent can reach {allowed} of {matrix.length} tools. Anything it cannot reach is never
        shown to the model.
      </p>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-[0.14em] text-muted">
        Agent permission level
      </h2>
      <form action={setAgentPermission} className="space-y-2">
        {PERMISSION_LEVELS.map((level) => (
          <label
            key={level}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 transition hover:border-primary/50"
          >
            <input
              type="radio" name="level" value={level}
              defaultChecked={settings.agentPermission === level}
              className="mt-1 h-4 w-4 accent-[#00D4FF]"
            />
            <span>
              <span className="block font-mono text-sm text-primary">{level}</span>
              <span className="block text-xs text-muted">{PERMISSION_LABELS[level]}</span>
            </span>
          </label>
        ))}
        <button className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-[#06121F] hover:brightness-110">
          Save level
        </button>
      </form>

      {pending.length > 0 && (
        <>
          <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-[0.14em] text-amber-400">
            Awaiting approval ({pending.length})
          </h2>
          <div className="space-y-2">
            {pending.map((a) => (
              <div key={a.id} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-sm text-amber-300">{a.reference}</span>
                  <span className="text-xs text-muted">
                    expires {a.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                  </span>
                </div>
                <div className="mt-1 text-sm">
                  <b>{a.toolName}</b>{' '}
                  <span className="text-muted">
                    requested by {a.requestedBy.username ? `@${a.requestedBy.username}` : a.requestedBy.firstName}
                  </span>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-[#0C1424] p-3 text-xs text-[#B7C4DA]">
                  {JSON.stringify(a.input, null, 2)}
                </pre>
                <p className="mt-2 text-xs text-muted">
                  Approve or deny from the staff Telegram group.
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-[0.14em] text-muted">
        Tools
      </h2>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-[#0C1424] text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3">Tool</th>
              <th className="px-4 py-3">Risk</th>
              <th className="px-4 py-3">Needs level</th>
              <th className="px-4 py-3">Approval</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Control</th>
            </tr>
          </thead>
          <tbody>
            {TOOL_CATEGORIES.flatMap((cat) => {
              const inCat = matrix.filter((m) => m.category === cat);
              if (inCat.length === 0) return [];
              return [
                <tr key={`h-${cat}`} className="border-t border-line bg-[#0C1424]">
                  <td colSpan={6} className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                    {CATEGORY_LABELS[cat]} · {inCat.length}
                  </td>
                </tr>,
                ...inCat.map((t) => (
              <tr key={t.name} className="border-t border-line align-top">
                <td className="px-4 py-3">
                  <div className={`font-medium ${t.verdict === 'deny' ? 'text-muted' : ''}`}>{t.name}</div>
                  <div className="max-w-md text-xs text-muted">{t.description.slice(0, 110)}…</div>
                </td>
                <td className={`px-4 py-3 font-medium ${RISK_TONE[t.riskLevel]}`}>{t.riskLevel}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted">{t.requiredPermission}</td>
                <td className="px-4 py-3 text-xs text-muted">{t.approvalRequired ? 'required' : '—'}</td>
                <td className={`px-4 py-3 text-xs font-medium ${VERDICT_TONE[t.verdict]}`}>
                  {t.verdict.replace('_', ' ')}
                </td>
                <td className="px-4 py-3">
                  <form action={setToolPolicy} className="flex items-center gap-2">
                    <input type="hidden" name="toolName" value={t.name} />
                    <input type="hidden" name="enabled" value={String(!t.enabled)} />
                    <input type="hidden" name="approvalRequired" value="inherit" />
                    <button
                      className={`rounded-md border px-2 py-1 text-xs transition ${
                        t.enabled
                          ? 'border-line text-muted hover:border-red-400 hover:text-red-400'
                          : 'border-accent/40 text-accent hover:brightness-125'
                      }`}
                    >
                      {t.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </form>
                </td>
              </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted">
        Disabling a tool overrides the permission level — it is refused even to a SUPER agent.
        High-risk tools always pause for approval; the arguments are frozen when the request is
        raised, so approving later runs exactly what was reviewed.
      </p>
    </div>
  );
}
