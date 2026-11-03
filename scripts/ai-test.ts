/**
 * Exercises AIService's retry, fallback and accounting by stubbing fetch.
 * No real API keys and no network: the point is the control flow, not the model.
 */
import { db } from '../src/lib/db';
import { ai } from '../src/lib/ai/ai-service';

const ok = (c: boolean, m: string) => console.log(`${c ? '  PASS' : '  FAIL'}  ${m}`);
const realFetch = globalThis.fetch;

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];

/** Queue one canned response per expected request, in order. */
function stub(responses: Array<{ status: number; json?: unknown; text?: string }>) {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      body: null,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
}

const claudeOk = (text: string) => ({
  status: 200,
  json: {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 40 },
    model: 'claude-sonnet-5-5',
  },
});
const openaiOk = (text: string) => ({
  status: 200,
  json: {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 90, completion_tokens: 25 },
    model: 'gpt-4o-mini',
  },
});

await db.tokenUsage.deleteMany({});

console.log('\n1. provider wiring (AI_PROVIDER=anthropic)');
ok(ai().primaryName === 'claude', `primary is ${ai().primaryName}`);
ok(ai().fallbackName === 'openai', `fallback is ${ai().fallbackName}`);

console.log('\n2. happy path goes to Claude');
stub([claudeOk('Here are the steps.')]);
let r = await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'how?' }] });
ok(r.provider === 'claude', 'served by claude');
ok(r.text === 'Here are the steps.', 'text returned');
ok(r.usage.inputTokens === 120 && r.usage.outputTokens === 40, 'usage captured');
ok(calls.length === 1, `one request made (${calls.length})`);
ok(calls[0].url.includes('api.anthropic.com'), 'hit the anthropic endpoint');
ok(typeof calls[0].body.system === 'string', 'system sent as its own field, not a message');

console.log('\n3. retry on a transient 529');
stub([{ status: 529, text: 'overloaded' }, { status: 529, text: 'overloaded' }, claudeOk('Recovered.')]);
r = await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'x' }] });
ok(r.text === 'Recovered.', 'succeeded after retries');
ok(calls.length === 3, `retried twice then succeeded (${calls.length} calls)`);
ok(calls.every((c) => c.url.includes('anthropic')), 'all retries stayed on the primary');

console.log('\n4. a 401 is NOT retried — it falls straight over to OpenAI');
stub([{ status: 401, text: 'invalid key' }, openaiOk('From the fallback.')]);
r = await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'x' }] });
ok(r.provider === 'openai', 'served by the fallback');
ok(r.text === 'From the fallback.', 'fallback text returned');
ok(calls.length === 2, `one claude attempt, one openai (${calls.length} calls)`);
ok(calls[1].url.includes('api.openai.com'), 'second call went to openai');
const msgs = calls[1].body.messages as { role: string }[];
ok(msgs[0].role === 'system', 'openai gets system as the first message');
ok(calls[1].body.model === 'gpt-4o-mini', "claude's model id was not forwarded to openai");

console.log('\n5. both providers down surfaces the error');
stub([{ status: 500, text: 'boom' }]);
let threw = false;
try { await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'x' }] }); }
catch { threw = true; }
ok(threw, 'throws rather than returning empty text');

console.log('\n6. effort is only sent when asked for');
stub([claudeOk('ok')]);
await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'x' }], effort: 'medium' });
ok(JSON.stringify(calls[0].body.output_config) === '{"effort":"medium"}', 'output_config.effort set');
stub([claudeOk('ok')]);
await ai().generateResponse({ system: 's', messages: [{ role: 'user', content: 'x' }] });
ok(calls[0].body.output_config === undefined, 'omitted when not specified, so the model default applies');

console.log('\n7. classifyIntent uses the fast model and validates the label');
stub([claudeOk('needs_human')]);
ok((await ai().classifyIntent('I want to talk to a person')) === 'needs_human', 'valid label accepted');
ok(calls[0].body.model === 'claude-haiku-5-5', `routed to ${calls[0].body.model}`);
stub([claudeOk('banana')]);
ok((await ai().classifyIntent('x')) === 'question', 'unknown label falls back to question');
stub([{ status: 500, text: 'down' }]);
ok((await ai().classifyIntent('x')) === 'question', 'classifier outage falls back to question');

console.log('\n8. ticket summary never blocks a ticket');
stub([{ status: 401, text: 'bad' }, { status: 401, text: 'bad' }]);
const sum = await ai().generateTicketSummary('User: it broke', 'Fallback summary');
ok(sum === 'Fallback summary', 'both providers failing still returns a summary');

console.log('\n9. embeddings always go to OpenAI');
stub([{ status: 200, json: { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 7 } } }]);
const vecs = await ai().embedText(['hello']);
ok(vecs.length === 1 && vecs[0].length === 2, 'vector returned');
ok(calls[0].url.includes('api.openai.com/v1/embeddings'), 'hit the openai embeddings endpoint');

console.log('\n10. token usage recorded per operation');
globalThis.fetch = realFetch;
await new Promise((r) => setTimeout(r, 400));   // writes are fire-and-forget
const usage = await ai().usageSummary();
const ops = new Set(usage.map((u) => u.operation));
ok(ops.has('chat'), 'chat recorded');
ok(ops.has('chat:fallback'), 'fallback recorded separately from primary');
ok(ops.has('classify'), 'classify recorded');
ok(ops.has('embed'), 'embed recorded');
const chat = usage.find((u) => u.operation === 'chat');
ok((chat?.inputTokens ?? 0) > 0, `token counts stored (chat input=${chat?.inputTokens})`);
console.log('   operations seen:', [...ops].sort().join(', '));

await db.$disconnect();
console.log('\ndone');
