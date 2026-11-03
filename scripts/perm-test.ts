/**
 * Permission gate and approval workflow.
 */
import { db } from '../src/lib/db';
import { TOOLS, availableTools, executeTool, resolveApproval, toolMatrix } from '../src/lib/tools/registry';
import { decide } from '../src/lib/tools/permissions';
import type { ToolContext } from '../src/lib/tools/types';
import type { PermissionLevel } from '../src/generated/prisma/client';

const ok = (c: boolean, m: string) => console.log(`${c ? '  PASS' : '  FAIL'}  ${m}`);
const realFetch = globalThis.fetch;
let tgCalls: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('api.telegram.org')) {
    tgCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }), text: async () => '' } as unknown as Response;
  }
  if (url.includes('/v1/embeddings')) {
    return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [0.1] }], usage: {} }), text: async () => '' } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: {} }), text: async () => '' } as unknown as Response;
}) as typeof fetch;

async function setLevel(level: PermissionLevel) {
  await db.adminSettings.upsert({
    where: { id: 'singleton' }, create: { id: 'singleton', agentPermission: level },
    update: { agentPermission: level },
  });
}

await db.user.deleteMany({ where: { telegramId: { in: [BigInt(77001), BigInt(77002)] } } });
await db.toolPolicy.deleteMany({});
const u = await db.user.create({ data: { telegramId: BigInt(77001), username: 'perm' } });
const victim = await db.user.create({ data: { telegramId: BigInt(77002), username: 'victim' } });
const c = await db.conversation.create({ data: { userId: u.id } });
const ctx: ToolContext = { userId: u.id, conversationId: c.id, telegramChatId: 77001, username: 'perm' };

console.log('\n1. the four levels gate the right tools');
const expected: Record<PermissionLevel, number> = { READ_ONLY: 3, SUPPORT: 6, OPERATIONS: 12, SUPER: 17 };
for (const level of ['READ_ONLY', 'SUPPORT', 'OPERATIONS', 'SUPER'] as PermissionLevel[]) {
  await setLevel(level);
  const tools = await availableTools();
  ok(tools.length === expected[level], `${level}: ${tools.length} tools reachable (expected ${expected[level]})`);
}

await setLevel('READ_ONLY');
const ro = (await availableTools()).map((t) => t.name);
ok(!ro.includes('CreateTicket'), 'READ_ONLY cannot reach CreateTicket');
ok(!ro.includes('EscalateToHuman'), 'READ_ONLY cannot reach EscalateToHuman');
ok(!ro.includes('CollectLead'), 'READ_ONLY cannot reach CollectLead');
ok(ro.includes('SearchKnowledgeBase'), 'READ_ONLY keeps SearchKnowledgeBase');

console.log('\n2. a denied tool is refused at execution, not just hidden');
let r = await executeTool({ id: 'x1', name: 'CreateTicket', input: { summary: 'should not happen' } }, ctx);
ok(r.isError, 'CreateTicket refused at READ_ONLY');
ok(r.content.includes('READ_ONLY'), 'the reason names the current level');
ok(r.content.includes('Do not retry'), 'tells the model not to loop on it');
const made = await db.ticket.count({ where: { userId: u.id } });
ok(made === 0, 'and no ticket was created');

console.log('\n3. an admin kill switch beats every permission level');
await setLevel('SUPER');
await db.toolPolicy.create({ data: { toolName: 'SearchKnowledgeBase', enabled: false } });
r = await executeTool({ id: 'x2', name: 'SearchKnowledgeBase', input: { query: 'anything' } }, ctx);
ok(r.isError && r.content.includes('switched off'), 'disabled tool refused even at SUPER');
ok(!(await availableTools()).some((t) => t.name === 'SearchKnowledgeBase'), 'and it is not advertised');
await db.toolPolicy.deleteMany({ where: { toolName: 'SearchKnowledgeBase' } });

console.log('\n4. high-risk tools do not execute — they raise an approval');
tgCalls = [];
const before = await db.ticket.count();
r = await executeTool({ id: 'x3', name: 'DeleteTicket', input: { reference: 'NW-0001', reason: 'testing the gate' } }, ctx);
ok(!r.isError, 'returns a normal result, not an error');
ok(r.content.includes('APR-'), `approval reference raised: ${r.content.match(/APR-\d+/)?.[0]}`);
ok(r.content.includes('awaiting approval'), 'model is told to wait');
ok(await db.ticket.count() === before, 'nothing was deleted');

const posted = tgCalls.find((t) => String(t.text ?? '').includes('TOOL APPROVAL REQUIRED'));
ok(Boolean(posted), 'staff group was notified');
ok(String(posted?.text).includes('DeleteTicket'), 'the post names the tool');
ok(String(posted?.text).includes('testing the gate'), 'and shows the exact arguments for review');
const kb = posted?.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
ok(Boolean(kb?.inline_keyboard), 'approve/deny buttons attached');

console.log('\n5. invalid arguments are caught before a human is asked');
tgCalls = [];
r = await executeTool({ id: 'x4', name: 'DeleteTicket', input: { reference: 'garbage' } }, ctx);
ok(r.isError, 'rejected');
ok(tgCalls.length === 0, 'no approval request raised for input that would have failed anyway');

console.log('\n6. denying an approval does not run the tool');
const pending = await db.toolApproval.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
let outcome = await resolveApproval(pending!.id, false, '@admin');
ok(outcome.message.includes('denied'), 'denial recorded');
const afterDeny = await db.toolApproval.findUnique({ where: { id: pending!.id } });
ok(afterDeny?.status === 'DENIED', 'status is DENIED');
ok(afterDeny?.decidedBy === '@admin', 'decider recorded');
ok(Boolean(outcome.notifyUserChatId), 'requester is told');

console.log('\n7. approving executes exactly what was reviewed');
const t = await db.ticket.create({
  data: { reference: 'NW-999901', number: 999901, userId: u.id, summary: 'to be deleted', transcript: '' },
});
r = await executeTool({ id: 'x5', name: 'DeleteTicket', input: { reference: 'NW-999901', reason: 'approved path test' } }, ctx);
ok(await db.ticket.findUnique({ where: { id: t.id } }) !== null, 'still present while pending');

const appr = await db.toolApproval.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
outcome = await resolveApproval(appr!.id, true, '@admin');
ok(await db.ticket.findUnique({ where: { id: t.id } }) === null, 'deleted once approved');
const done = await db.toolApproval.findUnique({ where: { id: appr!.id } });
ok(done?.status === 'EXECUTED', 'marked EXECUTED');
ok(Boolean(done?.result), 'outcome stored on the record');

console.log('\n8. an approval cannot be replayed');
outcome = await resolveApproval(appr!.id, true, '@admin2');
ok(outcome.message.includes('already'), 'second approval is a no-op');

console.log('\n9. expired approvals are not actionable');
const stale = await db.toolApproval.create({
  data: {
    reference: 'APR-9999', toolName: 'BanUser', input: { telegramId: '77002', reason: 'stale request' },
    riskLevel: 'high', requestedById: u.id, expiresAt: new Date(Date.now() - 1000),
  },
});
outcome = await resolveApproval(stale.id, true, '@admin');
ok(outcome.message.includes('expired'), 'expired request refused');
ok((await db.user.findUnique({ where: { id: victim.id } }))?.isBlocked === false, 'and the user was not blocked');

console.log('\n10. guards inside the high-risk tools themselves');
r = await executeTool({ id: 'x6', name: 'BanUser', input: { telegramId: '77001', reason: 'self ban attempt' } }, ctx, { bypassApproval: true });
ok(r.isError, 'a user cannot be blocked through their own conversation');

for (const bad of ['../secrets.md', 'nested/path.md', 'script.sh', '..%2Fetc.md']) {
  r = await executeTool({ id: 'x7', name: 'ModifyKnowledgeBase', input: { action: 'write', filename: bad, content: 'x'.repeat(50) } }, ctx, { bypassApproval: true });
  ok(r.isError, `path traversal rejected: ${bad}`);
}

console.log('\n11. the matrix an admin sees');
await setLevel('SUPPORT');
const matrix = await toolMatrix();
ok(matrix.length === 17, `all 17 listed regardless of level (${matrix.length})`);
ok(matrix.filter((m) => m.verdict === 'allow').length === 6, 'six allowed at SUPPORT');
ok(matrix.filter((m) => m.riskLevel === 'high').every((m) => m.approvalRequired), 'every high-risk tool requires approval');
ok(matrix.filter((m) => m.riskLevel === 'low').every((m) => !m.approvalRequired), 'no low-risk tool requires approval');
ok(TOOLS.every((t) => t.description.length > 40 && t.riskLevel && t.requiredPermission && t.category),
   'every tool declares description, risk, permission and category');

const cats = new Set(matrix.map((m) => m.category));
ok(cats.size === 5, `five categories in use: ${[...cats].sort().join(', ')}`);
ok(matrix.filter((m) => m.category === 'community').every((m) => m.requiredPermission !== 'READ_ONLY'),
   'no moderation tool is reachable at READ_ONLY');
ok(matrix.filter((m) => m.riskLevel === 'high').length === 5, 'five high-risk tools, all gated');

// cleanup
globalThis.fetch = realFetch;
await db.toolApproval.deleteMany({ where: { requestedById: u.id } });
await db.user.deleteMany({ where: { telegramId: { in: [BigInt(77001), BigInt(77002)] } } });
await db.toolPolicy.deleteMany({});
await setLevel('SUPPORT');
await db.$disconnect();
console.log('\ndone');
