import { db } from '../src/lib/db';
import { createTicket, dashboardStats, formatReference } from '../src/lib/tickets';
import { chunkText } from '../src/lib/knowledge/chunk';
import { cosine } from '../src/lib/knowledge/similarity';

const ok = (c: boolean, m: string) => console.log(`${c ? '  PASS' : '  FAIL'}  ${m}`);

console.log('\n1. reference formatting');
ok(formatReference(1) === 'NW-0001', 'NW-0001');
ok(formatReference(42) === 'NW-0042', 'NW-0042');
ok(formatReference(12345) === 'NW-12345', 'overflows past 4 digits without truncating');

console.log('\n2. chunking');
const doc = Array.from({ length: 12 }, (_, i) =>
  `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(8)).join('\n\n');
const parts = chunkText(doc);
ok(parts.length > 1, `split into ${parts.length} chunks`);
ok(parts.every((p) => p.length <= 1600), 'no chunk wildly over budget');
ok(chunkText('').length === 0, 'empty input yields no chunks');
ok(chunkText('tiny').length === 0, 'fragment below threshold dropped');
const huge = chunkText('x'.repeat(5000));
ok(huge.length >= 4, `single oversized paragraph still split (${huge.length})`);

console.log('\n3. cosine');
ok(Math.abs(cosine([1,0,0],[1,0,0]) - 1) < 1e-9, 'identical vectors = 1');
ok(Math.abs(cosine([1,0,0],[0,1,0])) < 1e-9, 'orthogonal = 0');
ok(cosine([0,0,0],[1,0,0]) === 0, 'zero vector does not divide by zero');

console.log('\n4. ticket creation against the real database');
// Clean up any fixtures from a previous run. The ticket sequence is not reset
// by deleting rows, so the assertions below are relative rather than absolute.
await db.user.deleteMany({ where: { telegramId: BigInt(99001) } });
const user = await db.user.create({
  data: { telegramId: BigInt(99001), username: 'tester', firstName: 'Test' },
});
const convo = await db.conversation.create({ data: { userId: user.id } });
await db.message.create({
  data: { conversationId: convo.id, role: 'USER', content: 'My webhook registration keeps failing.' },
});

// The AI key is fake, so summarise() must fall back rather than throw.
const t1 = await createTicket({
  userId: user.id, conversationId: convo.id,
  transcript: 'User: My webhook registration keeps failing.',
  fallbackSummary: 'Webhook registration failing',
});
ok(/^NW-\d{4,}$/.test(t1.reference), `reference is well formed: ${t1.reference}`);
ok(t1.summary === 'Webhook registration failing', 'fell back to user text when summariser unavailable');
ok(t1.status === 'OPEN', 'opens as OPEN');

const archived = await db.conversation.findUnique({ where: { id: convo.id } });
ok(archived?.isArchived === true, 'conversation archived on escalation');

const t2 = await createTicket({
  userId: user.id, transcript: 'second', fallbackSummary: 'Second issue',
});
ok(t2.number === t1.number + 1, `second ticket increments: ${t1.reference} -> ${t2.reference}`);
ok(t2.reference === formatReference(t2.number), 'reference matches its number');

console.log('\n5. concurrent escalation must not collide');
const burst = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    createTicket({ userId: user.id, transcript: `t${i}`, fallbackSummary: `Issue ${i}` })),
);
const refs = burst.map((t) => t.reference);
ok(new Set(refs).size === 5, `5 concurrent tickets, 5 distinct refs: ${refs.join(' ')}`);

console.log('\n6. dashboard stats');
const stats = await dashboardStats();
ok(stats.total >= 7, `total counts this run's 7 tickets (total=${stats.total})`);
ok(stats.open >= 7, `all 7 are open (open=${stats.open})`);
ok(stats.activeUsers >= 1, `active users counted (${stats.activeUsers})`);

// Leave the database as we found it.
await db.user.deleteMany({ where: { telegramId: BigInt(99001) } });
const leftover = await db.ticket.count({ where: { userId: user.id } });
ok(leftover === 0, 'fixtures cleaned up (tickets cascade with the user)');

await db.$disconnect();
console.log('\ndone');
