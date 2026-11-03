# NuroWorks AI Support Agent

A Telegram support bot that answers from your documentation, opens tickets when
it cannot, and hands off to a human. Admin dashboard included.

Next.js 15 · TypeScript · Prisma 7 · PostgreSQL · Tailwind
**Claude primary, OpenAI fallback.**

---

## What it does

| | |
|---|---|
| **Answers questions** | Retrieves from your knowledge base, then answers from that context only |
| **Admits uncertainty** | Below a configurable confidence floor it offers a human instead of guessing |
| **Opens tickets** | `NW-0001`, `NW-0002`… assigned from a Postgres sequence |
| **Escalates** | Posts to a staff Telegram group and archives the conversation |
| **Dashboard** | Open/total/resolved counts, ticket table with status control, knowledge management |

---

## Quick start

```bash
cp .env.example .env     # fill in the values described below
npm install
npm run db:push          # create tables
npm run ingest           # embed everything in ./knowledge
npm run dev              # dashboard on http://localhost:3000/admin
```

In a second terminal, for local bot testing without a public URL:

```bash
npm run bot:poll
```

Telegram will not deliver to `localhost`. `bot:poll` deletes any registered
webhook first, so the two delivery modes can never run at once and double-handle
every message.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | yes | 16+ chars. `openssl rand -hex 24` |
| `TELEGRAM_ADMIN_CHAT_ID` | no | Staff group. Without it, tickets open but nobody is told |
| `AI_PROVIDER` | no | `anthropic` (default) or `openai` |
| `ANTHROPIC_API_KEY` | yes, by default | Primary provider |
| `OPENAI_API_KEY` | **yes, always** | Embeddings + fallback. See below |
| `CHAT_MODEL` | no | `claude-sonnet-5-5` |
| `FAST_MODEL` | no | `claude-haiku-5-5` — classification and summaries |
| `OPENAI_CHAT_MODEL` | no | `gpt-4o-mini` |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` |
| `ADMIN_PASSWORD` | yes | 8+ chars |
| `ADMIN_SESSION_SECRET` | yes | 32+ chars. `openssl rand -hex 32` |
| `APP_URL` | for webhook | Public HTTPS base URL |

**OpenAI is required even when chat runs on Claude.** Anthropic publishes no
embeddings endpoint, so retrieval always goes through OpenAI. The app refuses to
boot without the key rather than failing later on the first question.

---

## AI architecture

Nothing outside `src/lib/ai` ever calls a model API. Everything goes through
`AIService`, so switching providers is one environment variable.

```
src/lib/ai/
  types.ts              AIProvider interface, ProviderError, Intent
  providers/claude.ts   primary  — Messages API, SSE streaming, output_config.effort
  providers/openai.ts   fallback — Chat Completions, SSE streaming, embeddings
  ai-service.ts         the only thing the rest of the app imports
```

`AIService` exposes:

| Method | Model used | Notes |
|---|---|---|
| `generateResponse()` | `CHAT_MODEL` | Retry, fallback, streaming via `onDelta` |
| `embedText()` | `EMBEDDING_MODEL` | Always OpenAI |
| `summarizeConversation()` | `FAST_MODEL` | |
| `generateTicketSummary()` | `FAST_MODEL` | Falls back to raw user text on failure |
| `classifyIntent()` | `FAST_MODEL` | Returns `question` on any failure |
| `usageSummary()` | — | Token spend grouped by operation |

**Retry and fallback.** Transient failures (408, 429, 5xx, 529) are retried up
to three times with exponential backoff and jitter. A 401 or a malformed
request is *not* retried — repeating it burns latency and ends identically.
Once the primary is exhausted, the request goes to the fallback provider with
the model id stripped, since a Claude model id means nothing to OpenAI.

**Model selection.** Conversation uses Sonnet. Classification and summarisation
use Haiku, which is roughly 20x cheaper per token and handles routing well.
Those short calls are the majority by volume, so this is most of the bill.

**Effort.** Sonnet defaults to `high` effort, which is slow and expensive for
answering from retrieved context. Chat sends `medium`; classification and
summaries send `low`.

**Degradation.** Every AI call has a defined failure behaviour. Intent
classification falls back to `question` (the safe path — it routes to
retrieval). Ticket summarisation falls back to the user's own words. A ticket
always opens, even with every model down.

**Token usage** is written to the `TokenUsage` table on every call and shown on
the dashboard, grouped by operation, provider and model. Fallback calls are
recorded as `chat:fallback` so you can see how often the primary is failing.

---

## Tool use

Claude decides when to call a tool and when to answer. There is no keyword
routing and no intent pre-classification in the request path — the model reads
the message, calls what it needs, and replies.

```
src/lib/tools/
  types.ts                 ToolDefinition, ToolContext, ToolResult
  search-kb.ts             SearchKnowledgeBase
  create-ticket.ts         CreateTicket
  get-ticket.ts            GetTicketStatus
  notify-admin.ts          NotifyAdmin
  escalate.ts              EscalateToHuman
  search-conversations.ts  SearchPreviousConversations
  system-status.ts         GetSystemStatus
  collect-lead.ts          CollectLead
  registry.ts              schema translation + execution
```

Each tool declares a Zod schema. `z.toJSONSchema()` turns it into the
`input_schema` advertised to Claude, and the *same* schema validates what comes
back. Tool arguments are model-generated, so nothing reaches the database
unvalidated.

**The loop** lives in `AIService.runWithTools()`. It sends the tool specs, and
while `stop_reason` is `tool_use` it executes every `tool_use` block, appends
the assistant turn verbatim, and returns all results in one user message —
which is what the API requires for parallel calls. Capped at six iterations;
the final attempt withholds tools so the user gets prose rather than silence.

**Failures are tool results, not exceptions.** A tool that throws returns
`is_error: true` with a recovery hint. Claude can work around a failed tool; it
cannot work around a dead request. Internal error text is never passed through.

**Guards worth knowing about:**

| Tool | Guard |
|---|---|
| `GetTicketStatus` · `NotifyAdmin` | Scoped to the asking user. A reference like `NW-0043` is guessable, so another user gets an error with no detail leaked |
| `CreateTicket` | Refuses a second ticket within 10 minutes and points at the existing one |
| `NotifyAdmin` | Posts once per ticket; a repeat call is a no-op |
| `GetSystemStatus` | Reads recorded status only. With nothing recorded it says so — it will never claim "operational" during an unrecorded outage |
| `CollectLead` | Refuses empty input; one row per user per day, merged on repeat |
| `EscalateToHuman` | Opens the ticket *and* notifies in one step, so an escalation cannot end with a ticket nobody was told about |

`GetSystemStatus` reads the `ServiceStatus` table, which an operator maintains.
Nothing populates it automatically, by design.

---

## Tool permissions

The AI never has unrestricted tool access. Every call passes through one gate in
`src/lib/tools/registry.ts`, checked against the agent's level and any per-tool
override before anything executes.

### Categories

| Category | Tools |
|---|---|
| **Knowledge** | SearchKnowledgeBase, SearchPreviousConversations, ModifyKnowledgeBase |
| **Support** | GetTicketStatus, CreateTicket, NotifyAdmin, EscalateToHuman, DeleteTicket |
| **Sales** | CollectLead, ScheduleDemo |
| **Community** | MuteUser, BanUser, SendBroadcastMessage, ManageChannels |
| **System** | GetSystemStatus, GetConfiguration, LookupUser |

### Levels

Set on the Tool Permissions screen. Default is `SUPPORT`, not `SUPER`.

| Level | Reaches | Typical use |
|---|---|---|
| `READ_ONLY` | **3 of 17** — search, ticket status, system status | Public FAQ bot |
| `SUPPORT` | **6** — adds history, CreateTicket, NotifyAdmin | **Default.** Support desk |
| `OPERATIONS` | **12** — adds escalation, sales, MuteUser, config reads | Full agent |
| `SUPER` | **17** — high-risk ones still gated | Internal/admin |

**Risk levels** drive whether a human signs off:

| Risk | Tools | Behaviour |
|---|---|---|
| low | SearchKnowledgeBase, GetTicketStatus, GetSystemStatus, SearchPreviousConversations | Runs immediately |
| medium | CreateTicket, NotifyAdmin, EscalateToHuman, CollectLead, ScheduleDemo, MuteUser | Runs if the level permits |
| high | DeleteTicket, BanUser, SendBroadcastMessage, ModifyKnowledgeBase, ManageChannels | **Always pauses for approval** |
| critical | *(supported, nothing implemented — see below)* | Would always pause |

**Tools above the agent's level are never advertised to the model.** Offering a
capability and then refusing it wastes a turn and teaches the model to retry.
Approval-gated tools *are* advertised, because requesting one is legitimate.

**The approval flow.** A high-risk call raises an `APR-0001` request instead of
executing. The arguments are frozen on the record at request time, so approving
an hour later runs exactly what was reviewed — not whatever the conversation has
drifted to. The staff group gets the tool name, the full arguments, and
Approve/Deny buttons. Requests expire after 24 hours, cannot be replayed once
decided, and the requester is told either way.

**The kill switch.** Disabling a tool on the permissions screen overrides
everything, including `SUPER`. That is the control you reach for when a tool is
misbehaving in production.

### Deliberately not implemented

Four capabilities appear in the spec and are **not built**, each for the same
reason: they let the model alter the thing that constrains the model.

| Not built | Why |
|---|---|
| `DeleteDatabase` | Unrecoverable. The only thing between a prompt injection and your data would be one tired admin pressing a button |
| `RemoveAdmin` | Removes the people who would stop it |
| **Agent Management (write)** | The AI setting its own permission level is privilege escalation. A model talked into promoting itself to `SUPER` defeats every gate here |
| **Configuration (write)** | These settings include the confidence floor and the system prompt — the two controls that decide when the bot may guess. A model able to lower its own floor can talk itself out of the check the floor exists to enforce |

The read halves **are** built: `GetConfiguration` and `LookupUser` answer
questions without granting control. `GetConfiguration` never returns secrets.

The five HIGH tools are built because they are useful, survivable, and
individually gated. `MuteUser` exists specifically so the bot has a
proportionate response and is not forced to choose between tolerating abuse and
a permanent ban.

### Tools that cannot invent facts

Three tools are deliberately read-bound to a table an operator maintains:

- **`GetSystemStatus`** reads recorded status. With nothing recorded it says so,
  rather than claiming "operational" during an outage nobody logged.
- **`ScheduleDemo`** can only offer slots that exist. A model that promises
  "Tuesday at 3pm" with nothing in the calendar creates a no-show, not a demo.
  Claiming a slot uses a conditional update, so two users racing for the same
  time cannot double-book.
- **`ManageChannels`** can list freely, but adding a channel is gated — that is
  how a bot gets talked into broadcasting to an attacker's chat.

---

## Knowledge base

Drop `.md`, `.txt` or `.pdf` files into `/knowledge`, then rebuild from the
dashboard or with `npm run ingest`.

Each file is hashed. Unchanged files are skipped, so adding one document costs
one document's worth of embeddings rather than re-embedding the corpus. Deleting
a file from disk removes it from the index on the next rebuild — a deleted
document stops answering questions.

Chunking splits on paragraph boundaries and packs to roughly 1200 characters
with 200 characters of overlap. Fixed-width windows cut sentences in half and
the retrieved context reads as nonsense.

**Vectors are stored as JSON and compared in process.** At MVP scale that is a
few milliseconds and runs on any Postgres, including a bare VPS with no
extensions. Past roughly 20k chunks, move to `pgvector` and
`src/lib/knowledge/retrieve.ts` becomes a SQL query.

---

## Telegram setup

1. **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`
2. **Staff group** — create a private group, add the bot as an admin, forward a
   message from it to `@userinfobot`, put the (negative) id in
   `TELEGRAM_ADMIN_CHAT_ID`
3. **Register the webhook** once deployed:

```bash
npm run bot:register
```

Commands: `/start` `/help` `/ticket` `/status` `/contact` `/admin`

---

## Deploying

### Railway

1. New project from this repo, add the PostgreSQL plugin
2. Paste the environment variables; `DATABASE_URL` is provided by the plugin
3. Set `APP_URL` to the generated domain
4. After the first deploy: `npm run db:push`, then `npm run bot:register`

### Docker / VPS

```bash
docker compose up -d --build
docker compose exec app npx prisma db push
docker compose exec app npm run ingest
```

The image is multi-stage, runs as the non-root `node` user, carries a health
check, and uses `dumb-init` as PID 1 so `SIGTERM` reaches Node and in-flight
requests finish. `/knowledge` is mounted as a volume so documents can be added
without rebuilding.

**Run exactly one instance.** Rate limiting is in process memory. Two replicas
would each enforce their own quota and the real limit becomes double what you
set. Moving to Redis is the first thing to do before scaling out.

---

## Security

- Webhook requests verified against `TELEGRAM_WEBHOOK_SECRET`; anything else is 403
- Admin session is an HMAC-signed, httpOnly cookie; password compared in constant time
- Login limited to 5 attempts per IP per 5 minutes
- Bot limited to 8 messages per user per minute
- Knowledge rebuild limited to 2 per minute, because re-embedding costs money
- Server actions re-check authentication; they are public endpoints, not internal calls
- All environment variables validated at boot with a readable error

---

## Tests

```bash
node --env-file=.env node_modules/.bin/tsx scripts/smoke.ts      # 22 assertions
node --env-file=.env node_modules/.bin/tsx scripts/ai-test.ts    # 33 assertions
node --env-file=.env node_modules/.bin/tsx scripts/tool-test.ts  # 52 assertions
node --env-file=.env node_modules/.bin/tsx scripts/perm-test.ts  # 49 assertions
```

`smoke.ts` covers reference formatting, chunking edge cases, cosine similarity,
ticket creation against a real database, concurrent escalation and dashboard
counts. It cleans up its own fixtures, so it can run repeatedly.

`ai-test.ts` stubs `fetch` and verifies the control flow that is hard to test
any other way: retry on 529, no retry on 401, fallback to the second provider,
model-id stripping across vendors, `output_config.effort` only sent when asked
for, Haiku routing for classification, label validation, graceful degradation
when every provider is down, and token accounting per operation.

`tool-test.ts` covers the registry, schema validation of model-generated input,
cross-user ticket isolation, duplicate suppression, a throwing tool, and the
orchestration loop itself — including that the `tool_use` block survives
verbatim into history, that `tool_use_id` matches, that parallel results arrive
in one message, and that a runaway loop is capped.

`perm-test.ts` covers the four levels, refusal at execution rather than only in
the advertised list, the kill switch beating `SUPER`, approval requests that do
not execute, denial, approval-then-execute, replay protection, expiry, and the
guards inside the high-risk tools — self-ban and four path-traversal attempts
against `ModifyKnowledgeBase`.

---

## Layout

```
prisma/schema.prisma          7 models
prisma.config.ts              Prisma 7 config — the URL no longer lives in the schema
src/lib/
  env.ts                      boot-time validation of every secret
  db.ts                       Prisma client via the pg driver adapter
  ai/types.ts                 provider interface and shared types
  ai/providers/claude.ts      primary
  ai/providers/openai.ts      fallback + embeddings
  ai/ai-service.ts            retry, fallback, model selection, usage
  knowledge/{chunk,ingest,retrieve}.ts
  telegram/{api,bot}.ts       one update handler for both webhook and polling
  tools/permissions.ts        levels, risk, the decide() gate
  tools/                      17 tools across 5 categories
  tickets.ts                  creation, status, dashboard stats
  auth.ts                     admin session
  ratelimit.ts
src/app/
  api/telegram/webhook/       secret-verified entry point
  api/tickets/                list, status change
  api/knowledge/              list, rebuild
  admin/(dash)/               dashboard, tickets, knowledge, permissions, settings
  admin/login/                outside the guarded group, deliberately
scripts/
  ingest.ts  dev-poll.ts  register-webhook.ts
  smoke.ts  ai-test.ts  tool-test.ts  perm-test.ts
```

---

## Known limits

- Single instance only, as above
- No file upload through the browser; documents go in `/knowledge` on disk
- Admin replies to tickets happen in Telegram, not in the dashboard
- No outbound notification beyond the staff group
- No dashboard page for leads yet; `Lead` rows are queryable but not displayed
- `ServiceStatus` has no admin UI — rows are set directly in the database
- Streaming is implemented but unused: Telegram has no streaming surface, and
  the tool loop needs whole blocks before it can act
