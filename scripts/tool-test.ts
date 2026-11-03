/**
 * Tool registry and orchestration loop.
 * Database calls are real; model calls are stubbed.
 */
import { db } from '../src/lib/db';
import { ai } from '../src/lib/ai/ai-service';
import { TOOLS, executeTool, toClaudeTools, toOpenAITools } from '../src/lib/tools/registry';
import type { ToolContext } from '../src/lib/tools/types';

const ok = (c: boolean, m: string) => console.log(`${c ? '  PASS' : '  FAIL'}  ${m}`);
const realFetch = globalThis.fetch;

let calls: { url: string; body: Record<string, unknown> }[] = [];

/**
 * Routes by URL rather than call order. A tool can make its own API calls
 * mid-loop — SearchKnowledgeBase hits OpenAI embeddings — so a purely
 * sequential stub hands the wrong canned reply to the wrong endpoint.
 */
function stub(modelTurns: Array<{ status: number; json?: unknown; text?: string }>) {
  calls = [];
  let turn = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const reply = (r: { status: number; json?: unknown; text?: string }) => ({
      ok: r.status >= 200 && r.status < 300, status: r.status, body: null,
      json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    }) as unknown as Response;

    // Side calls are answered generically and kept out of `calls`, so the
    // assertions below count only model turns.
    if (url.includes('/v1/embeddings')) {
      return reply({ status: 200, json: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 5 } } });
    }
    if (url.includes('api.telegram.org') && !url.includes('sendMessage')) {
      return reply(TG_OK);
    }

    calls.push({ url, body });
    return reply(modelTurns[Math.min(turn++, modelTurns.length - 1)]);
  }) as typeof fetch;
}

const TG_OK = { status: 200, json: { ok: true, result: { message_id: 555 } } };
const claudeTurn = (content: unknown[], stop: string) => ({
  status: 200,
  json: { content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 30 }, model: 'claude-sonnet-5-5' },
});

// ── fixtures ────────────────────────────────────────────────────────────────
// This file tests what the tools DO. The permission gate is perm-test's job, so
// the agent is raised to SUPER here and restored at the end.
const priorSettings = await db.adminSettings.findUnique({ where: { id: 'singleton' } });
await db.adminSettings.upsert({
  where: { id: 'singleton' },
  create: { id: 'singleton', agentPermission: 'SUPER' },
  update: { agentPermission: 'SUPER' },
});
await db.user.deleteMany({ where: { telegramId: { in: [BigInt(88001), BigInt(88002)] } } });
await db.serviceStatus.deleteMany({ where: { service: { in: ['test-bot', 'test-dash'] } } });

const userA = await db.user.create({ data: { telegramId: BigInt(88001), username: 'alice' } });
const userB = await db.user.create({ data: { telegramId: BigInt(88002), username: 'mallory' } });
const convoA = await db.conversation.create({ data: { userId: userA.id } });
const convoB = await db.conversation.create({ data: { userId: userB.id } });

const ctxA: ToolContext = { userId: userA.id, conversationId: convoA.id, telegramChatId: 88001, username: 'alice' };
const ctxB: ToolContext = { userId: userB.id, conversationId: convoB.id, telegramChatId: 88002, username: 'mallory' };

console.log('\n1. registry');
ok(TOOLS.length === 17, `17 tools registered (${TOOLS.length})`);
const names = TOOLS.map((t) => t.name).sort();
console.log('   ', names.join(', '));
ok(new Set(names).size === 17, 'names are unique');

const claudeSpecs = await toClaudeTools();
ok(claudeSpecs.every((t) => t.input_schema && !('$schema' in t.input_schema)),
   '$schema stripped — Anthropic rejects unknown top-level keys');
ok(claudeSpecs.every((t) => (t.input_schema as { type?: string }).type === 'object'),
   'every input_schema is an object schema');
ok(claudeSpecs.every((t) => t.description.length > 40), 'descriptions are substantive');
const oai = await toOpenAITools();
ok(oai.every((t) => t.type === 'function' && t.function.parameters), 'openai shape wraps in function');

console.log('\n2. input validation (inputs are model-generated)');
let r = await executeTool({ id: 't1', name: 'SearchKnowledgeBase', input: {} }, ctxA);
ok(r.isError, 'missing required field rejected');
ok(r.content.includes('query'), `error names the field: "${r.content.slice(0, 60)}…"`);

r = await executeTool({ id: 't2', name: 'GetTicketStatus', input: { reference: 'nonsense' } }, ctxA);
ok(r.isError, 'malformed ticket reference rejected before any query');

r = await executeTool({ id: 't3', name: 'NoSuchTool', input: {} }, ctxA);
ok(r.isError && r.content.includes('No tool named'), 'unknown tool handled, not thrown');
ok(r.content.includes('SearchKnowledgeBase'), 'error lists the real tools so the model can recover');

console.log('\n3. CreateTicket');
stub([claudeTurn([{ type: 'text', text: 'Bot crashes on startup' }], 'end_turn')]);
r = await executeTool({ id: 't4', name: 'CreateTicket', input: { summary: 'Bot crashes on startup' } }, ctxA);
ok(!r.isError, 'ticket created');
const ref = r.content.match(/NW-\d+/)?.[0];
ok(Boolean(ref), `reference returned: ${ref}`);
ok(r.content.includes('NotifyAdmin'), 'result tells the model what to do next');

r = await executeTool({ id: 't5', name: 'CreateTicket', input: { summary: 'Bot crashes again' } }, ctxA);
ok(r.content.includes('already exists'), 'duplicate within 10 minutes is refused, not duplicated');

console.log('\n4. cross-user isolation — a reference is guessable');
r = await executeTool({ id: 't6', name: 'GetTicketStatus', input: { reference: ref! } }, ctxA);
ok(!r.isError && r.content.includes('Status:'), 'owner can read their own ticket');

r = await executeTool({ id: 't7', name: 'GetTicketStatus', input: { reference: ref! } }, ctxB);
ok(r.isError, "another user cannot read it");
ok(!r.content.includes('crashes'), 'and the summary does not leak in the error');

r = await executeTool({ id: 't8', name: 'NotifyAdmin', input: { reference: ref! } }, ctxB);
ok(r.isError, 'nor can they trigger a notification about it');

console.log('\n5. NotifyAdmin');
stub([TG_OK]);   // sendMessage is the only call here, so it lands in `calls`
r = await executeTool({ id: 't9', name: 'NotifyAdmin', input: { reference: ref!, urgency: 'high' } }, ctxA);
ok(!r.isError, 'posted to the staff group');
ok(calls[0].url.includes('sendMessage'), 'called telegram sendMessage');
ok(String(calls[0].body.text).includes('URGENT'), 'urgency reflected in the post');
ok(String(calls[0].body.text).includes(ref!), 'reference included');

r = await executeTool({ id: 't10', name: 'NotifyAdmin', input: { reference: ref! } }, ctxA);
ok(r.content.includes('already notified'), 'does not spam the group twice for one ticket');

console.log('\n6. GetSystemStatus must not invent uptime');
r = await executeTool({ id: 't11', name: 'GetSystemStatus', input: { service: 'test-bot' } }, ctxA);
ok(!r.isError, 'returns successfully with no data');
ok(!/operational/i.test(r.content), 'does NOT claim operational when nothing is recorded');
ok(/cannot confirm|escalate/i.test(r.content), 'tells the model to admit uncertainty');

await db.serviceStatus.create({ data: { service: 'test-bot', status: 'degraded', detail: 'slow webhooks' } });
r = await executeTool({ id: 't12', name: 'GetSystemStatus', input: { service: 'test-bot' } }, ctxA);
ok(r.content.includes('degraded') && r.content.includes('slow webhooks'), 'reports what an operator recorded');

console.log('\n7. CollectLead');
r = await executeTool({ id: 't13', name: 'CollectLead', input: {} }, ctxA);
ok(r.isError, 'refuses to create an empty lead');

r = await executeTool({ id: 't14', name: 'CollectLead', input: { email: 'not-an-email' } }, ctxA);
ok(r.isError, 'invalid email rejected by the schema');

r = await executeTool({ id: 't15', name: 'CollectLead', input: { businessType: 'bakery', email: 'a@b.com' } }, ctxA);
ok(!r.isError, 'lead recorded');
r = await executeTool({ id: 't16', name: 'CollectLead', input: { name: 'Alice' } }, ctxA);
ok(r.content.includes('updated'), 'second call updates rather than creating a duplicate');
const leads = await db.lead.count({ where: { userId: userA.id } });
ok(leads === 1, `one lead row for this user (${leads})`);
const lead = await db.lead.findFirst({ where: { userId: userA.id } });
ok(lead?.name === 'Alice' && lead?.businessType === 'bakery', 'merged fields from both calls');

console.log('\n8. a throwing tool becomes a tool result, not a crash');
const broken = TOOLS.find((t) => t.name === 'GetSystemStatus')!;
const original = broken.execute;
broken.execute = async () => { throw new Error('database on fire'); };
r = await executeTool({ id: 't17', name: 'GetSystemStatus', input: {} }, ctxA);
broken.execute = original;
ok(r.isError, 'surfaced as an error result');
ok(!r.content.includes('on fire'), 'internal message not leaked to the model');
ok(r.content.includes('escalate'), 'gives the model a recovery path');

console.log('\n9. the orchestration loop');
stub([
  // turn 1: Claude asks for the knowledge base
  claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'SearchKnowledgeBase', input: { query: 'webhook setup' } }], 'tool_use'),
  // turn 2: having seen the result, it answers
  claudeTurn([{ type: 'text', text: 'Set APP_URL, then run bot:register.' }], 'end_turn'),
]);
let loop = await ai().runWithTools({ system: 'test', messages: [{ role: 'user', content: 'how do I configure webhooks?' }], ctx: ctxA });
ok(loop.text === 'Set APP_URL, then run bot:register.', 'final text returned');
ok(loop.iterations === 2, `two model turns (${loop.iterations})`);
ok(loop.toolsUsed.join() === 'SearchKnowledgeBase', `tool recorded: ${loop.toolsUsed.join()}`);
ok(calls.length === 2, 'two requests to the model');
ok(Array.isArray(calls[0].body.tools) && (calls[0].body.tools as unknown[]).length > 0, 'tools advertised');

const sent = calls[1].body.messages as { role: string; content: unknown }[];
ok(sent.length === 3, `history grew to 3 messages (${sent.length})`);
ok(sent[1].role === 'assistant', 'assistant turn preserved');
const asstBlocks = sent[1].content as { type: string; id?: string }[];
ok(asstBlocks[0].type === 'tool_use' && asstBlocks[0].id === 'toolu_1', 'tool_use block kept verbatim');
const resBlocks = sent[2].content as { type: string; tool_use_id?: string }[];
ok(sent[2].role === 'user' && resBlocks[0].type === 'tool_result', 'result returned as a user message');
ok(resBlocks[0].tool_use_id === 'toolu_1', 'tool_use_id matches the call');

console.log('\n10. parallel tool calls come back in one message');
stub([
  claudeTurn([
    { type: 'tool_use', id: 'p1', name: 'SearchKnowledgeBase', input: { query: 'a' } },
    { type: 'tool_use', id: 'p2', name: 'GetSystemStatus', input: {} },
  ], 'tool_use'),
  claudeTurn([{ type: 'text', text: 'Both checked.' }], 'end_turn'),
]);
loop = await ai().runWithTools({ system: 'test', messages: [{ role: 'user', content: 'x' }], ctx: ctxA });
ok(loop.toolsUsed.length === 2, `both tools ran (${loop.toolsUsed.join(', ')})`);
const parallel = (calls[1].body.messages as { content: unknown }[])[2].content as { type: string }[];
ok(parallel.length === 2 && parallel.every((b) => b.type === 'tool_result'),
   'both results in a single user message, as the API requires');

console.log('\n11. runaway tool use is capped');
stub([claudeTurn([{ type: 'tool_use', id: 'loop', name: 'GetSystemStatus', input: {} }], 'tool_use')]);
loop = await ai().runWithTools({ system: 'test', messages: [{ role: 'user', content: 'x' }], ctx: ctxA });
ok(loop.iterations === 6, `stopped at the ceiling (${loop.iterations} iterations)`);
const lastBody = calls[calls.length - 1].body;
ok(lastBody.tools === undefined, 'final attempt withholds tools to force a text answer');
ok(String(lastBody.system).includes('tool budget'), 'and tells the model why');

// ── cleanup ─────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
await db.adminSettings.update({
  where: { id: 'singleton' },
  data: { agentPermission: priorSettings?.agentPermission ?? 'SUPPORT' },
});
await db.user.deleteMany({ where: { telegramId: { in: [BigInt(88001), BigInt(88002)] } } });
await db.serviceStatus.deleteMany({ where: { service: { in: ['test-bot', 'test-dash'] } } });
await db.$disconnect();
console.log('\ndone');
