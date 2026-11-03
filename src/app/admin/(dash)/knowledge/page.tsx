import { db } from '@/lib/db';
import { RebuildButton } from './rebuild-button';

export const dynamic = 'force-dynamic';

const TONE: Record<string, string> = {
  INDEXED: 'text-accent',
  PENDING: 'text-yellow-400',
  FAILED:  'text-red-400',
};

export default async function Knowledge() {
  const docs = await db.knowledgeDocument.findMany({ orderBy: { createdAt: 'desc' } });
  const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Base</h1>
          <p className="mt-1 text-sm text-muted">
            {docs.length} document{docs.length === 1 ? '' : 's'} · {chunks} chunks indexed
          </p>
        </div>
        <RebuildButton />
      </div>

      <div className="mt-4 rounded-lg border border-line bg-surface p-4 text-sm text-[#B7C4DA]">
        Drop <code className="text-primary">.md</code>, <code className="text-primary">.txt</code> or{' '}
        <code className="text-primary">.pdf</code> files into the{' '}
        <code className="text-primary">/knowledge</code> folder, then rebuild. Unchanged files are
        skipped, so a rebuild only costs embeddings for what actually changed.
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-[#0C1424] text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3">Document</th>
              <th className="px-4 py-3">Uploaded</th>
              <th className="px-4 py-3">Chunks</th>
              <th className="px-4 py-3">Embedding Status</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-10 text-center text-muted">
                No documents indexed. Add files to /knowledge and rebuild.
              </td></tr>
            )}
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="px-4 py-3">
                  <div className="font-medium">{d.title}</div>
                  <div className="font-mono text-xs text-muted">{d.filename}</div>
                  {d.error && <div className="mt-1 text-xs text-red-400">{d.error}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">
                  {d.createdAt.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-3 tabular-nums text-muted">{d.chunkCount}</td>
                <td className={`px-4 py-3 font-medium ${TONE[d.status] ?? 'text-muted'}`}>{d.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
