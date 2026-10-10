import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OaReadService } from '../src/infrastructure/oa-read/readService.js';
import { parseMetadata, type PublishedMetadata } from '../src/infrastructure/oa-read/metadata.js';
import type { ReadDatabase, ReadQuery, SqlValue } from '../src/infrastructure/oa-read/database.js';
import { canonicalReadInput } from '../src/infrastructure/oa-read/reportPlan.js';
import { queryPlanForRequest, queryRequestSchema } from '../src/infrastructure/oa-read/readProtocol.js';
import { databaseReadGuidance } from '../src/infrastructure/oa-read/routing.js';

// Arbitrary entities and extra fields exercise the dynamic protocol, without
// coupling selection or batching to project/employee business keywords.
const semantic = parseMetadata({ format: 1, description: 'dynamic test catalog', rules: [], entities: [
  { name: 'work_items', table: 'work_items', description: 'work items', access: 'authenticated',
    columns: { id: { description: 'key' }, label: { description: 'label' },
      kind: { description: 'kind', values: { ready: 'Ready', draft: 'Draft' } }, visible: { description: 'visibility' },
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`extra_${index}`, { description: `extra field ${index}: ${'详细字段说明。'.repeat(30)}` }])),
    }, filters: [{ column: 'visible', value: 1 }] },
  { name: 'activity', table: 'activity', description: 'activity', access: 'authenticated',
    columns: { id: { description: 'key' }, item_id: { description: 'item' }, body: { description: 'body' },
      happened_on: { description: 'date' }, note: { description: 'source period and uncertainty' } },
    period: { startColumn: 'happened_on' }, references: [{ column: 'item_id', entity: 'work_items', targetColumn: 'id' }] },
  { name: 'restricted', table: 'user_weekly_salary', description: 'restricted', access: 'admin', columns: { id: { description: 'key' } } },
] });
const published = { version: 'v1', publishedAt: '2026-10-10', semantic, schema: { database: 'oa', tables: semantic.entities.map(entity => ({
  name: entity.table, kind: 'BASE TABLE', columns: Object.keys(entity.columns).map(name => ({ name,
    type: name === 'happened_on' ? 'date' : ['id', 'item_id', 'visible'].includes(name) ? 'int' : 'text',
  })), indexes: [], foreignKeys: [], dependencies: [],
})) } } as PublishedMetadata;
const principal = { userId: '1', isAdmin: false };
const items = { from: { entity: 'work_items', as: 'w' }, select: [{ field: 'w.id', as: 'id' }, { field: 'w.label', as: 'label' }],
  where: [{ field: 'w.kind', op: 'eq', value: 'ready' }], orderBy: [{ field: 'w.id', direction: 'asc' }] };
const activity = { from: { entity: 'activity', as: 'a' }, select: [{ field: 'a.id', as: 'id' }, { field: 'a.body', as: 'body', textLength: 100 },
  { field: 'a.note', as: 'note' }, { field: 'a.happened_on', as: 'date' }],
  where: [{ field: 'a.item_id', op: 'in', value: [1, 2] }],
  period: { startField: 'a.happened_on', start: '2026-10-01', end: '2026-11-01' }, orderBy: [{ field: 'a.id', direction: 'asc' }] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, rowsFor?: (sql: string, bindings: SqlValue[]) => Record<string, unknown>[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'read-protocol-'));
  const save = (metadata = published) => writeFile(path.join(dir, 'current.json'), JSON.stringify({ active: metadata, report: { status: 'published' } }));
  await save();
  const queries: { sql: string; bindings: SqlValue[] }[] = [];
  let transactions = 0;
  const db = { read: async (operation: (query: ReadQuery) => unknown) => {
    transactions++;
    return operation((async (sql: string, bindings: SqlValue[] = []) => {
      queries.push({ sql, bindings });
      if (rowsFor) return rowsFor(sql, bindings);
      return sql.includes('COUNT(') ? [{ total: 2 }]
        : sql.includes('FROM `work_items`') ? [{ id: 1, label: '甲' }, { id: 2, label: '乙' }]
        : [{ id: 3, body: '完成工作', note: '覆盖 2026-09-28 至 2026-10-04；仅标题生成，待核实', date: '2026-10-04' }];
    }) as ReadQuery);
  }, close: async () => {} } as unknown as ReadDatabase;
  const service = new OaReadService({ databaseUrl: 'mysql://read:unused@localhost/oa', metadataPath: '', stateDirectory: dir,
    syncIntervalSeconds: 300, queryTimeoutMs: 1000, maxRows: 100, concurrency: 2 }, db);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, queries, transactions: () => transactions, save };
}

test('single reads and the previously failed wrapped batch format use identical query envelopes', async t => {
  const { service, queries, transactions } = await fixture(t);
  const single: any = await service.call({ action: 'query', version: 'v1', id: 'items', query: items }, principal);
  const batch: any = await service.call({ action: 'batch', version: 'v1', queries: [
    { id: 'items', query: items }, { id: 'activity', query: activity },
  ] }, principal);
  assert.equal(single.ok, true); assert.equal(single.id, 'items');
  assert.equal(batch.ok, true); assert.equal(transactions(), 2); assert.equal(queries.length, 3);
  assert.deepEqual(batch.results.map((result: any) => result.id), ['items', 'activity']);
  assert.deepEqual(batch.results[0].rows, single.rows);
  assert.deepEqual(queries[1]!.bindings, queries[0]!.bindings);
  assert.deepEqual(queries[2]!.bindings, [1, 2, '2026-11-01', '2026-10-01']);
  assert.match(batch.results[1].rows[0].note, /覆盖.*仅标题生成，待核实/);
});

test('old flat plans, nested IDs and singular joins remain compatible without modifying filters or periods', async t => {
  const { service, queries } = await fixture(t);
  const legacy = { ...activity, id: 'legacy', join: [{ entity: 'work_items', as: 'w', type: 'inner', on: { left: 'a.item_id', right: 'w.id' } }] };
  const normalized: any = canonicalReadInput({ action: 'batch', version: 'v1', queries: [legacy, { query: { ...items, id: 'nested' } }] });
  assert.deepEqual(normalized.queries[0].query.where, activity.where);
  assert.deepEqual(normalized.queries[0].query.period, activity.period);
  assert.equal(normalized.queries[0].query.joins.length, 1);
  assert.ok('join' in legacy); // Normalization must not mutate the caller's plan.
  const result: any = await service.call({ action: 'batch', version: 'v1', queries: [legacy, { query: { ...items, id: 'nested' } }] }, principal);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((row: any) => row.id), ['legacy', 'nested']);
  assert.deepEqual(queries[0]!.bindings, [1, 1, 2, '2026-11-01', '2026-10-01']);
});

test('unknown fields, ambiguous envelopes and forbidden entities fail before any batch data is read', async t => {
  const { service, transactions } = await fixture(t);
  for (const entry of [
    { query: items, sql: 'SELECT * FROM private' },
    { query: { ...items, sql: 'SELECT * FROM private' } },
    { query: items, from: items.from },
    { id: 'outer', query: { ...items, id: 'inner' } },
    { query: { ...items, select: [{ field: 'w.password', as: 'secret' }] } },
    { query: { from: { entity: 'restricted', as: 'r' }, select: [{ field: 'r.id', as: 'id' }] } },
  ]) {
    const result: any = await service.call({ action: 'batch', version: 'v1', queries: [{ query: activity }, entry] }, principal);
    assert.equal(result.ok, false); assert.equal(transactions(), 0);
  }
  const conflict: any = await service.call({ action: 'query', version: 'v1', id: 'outer', query: { ...items, id: 'inner' } }, principal);
  assert.equal(conflict.error.issues[0].path, 'id');
  const tooMany: any = await service.call({ action: 'batch', version: 'v1', queries: Array.from({ length: 6 }, () => ({ query: items })) }, principal);
  assert.equal(tooMany.ok, false); assert.equal(transactions(), 0);
});

test('details, counts and existence checks fit one batch and keep separate IDs and completeness', async t => {
  const { service, queries, transactions } = await fixture(t);
  const countItems = { from: items.from, where: items.where, select: [{ aggregate: 'count', as: 'total' }] };
  const countActivity = { from: activity.from, where: activity.where, period: activity.period, select: [{ aggregate: 'count', as: 'total' }] };
  const result: any = await service.call({ action: 'batch', version: 'v1', queries: [
    { id: 'items', query: { ...items, limit: 1 } }, { id: 'total', query: countItems },
    { id: 'activity', query: activity }, { id: 'activity_count', query: countActivity },
    { id: 'other_item_exists', query: { ...countActivity, where: [{ field: 'a.item_id', op: 'eq', value: 3 }] } },
  ] }, principal);
  assert.equal(result.ok, true); assert.equal(transactions(), 1); assert.equal(queries.length, 5);
  assert.deepEqual(result.results.map((row: any) => row.id), ['items', 'total', 'activity', 'activity_count', 'other_item_exists']);
  assert.equal(result.results[0].hasMore, true); assert.equal(result.results[0].nextOffset, 1);
  assert.equal(result.results[0].coverage, 'partial');
  assert.equal(result.results[1].rows[0].total, 2); assert.equal(result.results[1].hasMore, false);
  assert.deepEqual(queries[0]!.bindings, queries[1]!.bindings);
  assert.deepEqual(queries[2]!.bindings, queries[3]!.bindings);
});

test('field projection trims definitions but preserves types, enumerations, relationships and period rules', async t => {
  const { service, queries } = await fixture(t);
  const full: any = await service.call({ action: 'describe', entities: ['work_items', 'activity'] }, principal);
  const selected: any = await service.call({ action: 'describe', entities: ['work_items', 'activity'],
    fields: { work_items: ['id', 'kind'], activity: ['item_id', 'body'] },
  }, principal);
  assert.equal(selected.ok, true); assert.equal(queries.length, 0);
  const item = selected.entities.find((entity: any) => entity.name === 'work_items');
  const record = selected.entities.find((entity: any) => entity.name === 'activity');
  assert.deepEqual(Object.keys(item.columns), ['id', 'kind']); assert.equal(item.definitionCoverage, 'partial');
  assert.equal(item.columns.id.type, 'int'); assert.deepEqual(item.columns.kind.values, { ready: 'Ready', draft: 'Draft' });
  assert.deepEqual(item.filters, [{ column: 'visible', value: 1 }]);
  assert.deepEqual(record.references, semantic.entities[1]!.references);
  assert.deepEqual(record.period, semantic.entities[1]!.period);
  assert.ok(record.availableFields.includes('note')); assert.ok(record.availableFields.includes('happened_on'));
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), selectedBytes = Buffer.byteLength(JSON.stringify(selected));
  assert.ok(selectedBytes < fullBytes / 2);
  t.diagnostic(`Selected definitions: ${selectedBytes} bytes; full definitions: ${fullBytes} bytes`);
});

test('invalid or forbidden definition projections never leak hidden fields or query the database', async t => {
  const { service, transactions } = await fixture(t);
  for (const input of [
    { entities: ['work_items'], fields: { work_items: ['password'] } },
    { entities: ['work_items'], fields: { activity: ['body'] } },
    { entities: ['restricted'], fields: { restricted: ['id'] } },
    { entities: ['work_items'], fields: { work_items: [] } },
  ]) {
    const result: any = await service.call({ action: 'describe', ...input }, principal);
    assert.equal(result.ok, false); assert.ok(!result.entities); assert.equal(transactions(), 0);
  }
});

test('projection of one entity keeps another dynamically named entity complete', async t => {
  const { service, save } = await fixture(t);
  const metadata = structuredClone(published);
  metadata.semantic.entities[0]!.name = 'constructor';
  metadata.semantic.entities[1]!.references[0]!.entity = 'constructor';
  await save(metadata);
  const result: any = await service.call({ action: 'describe', entities: ['constructor', 'activity'], fields: { activity: ['body'] } }, principal);
  assert.equal(result.ok, true);
  const untouched = result.entities.find((entity: any) => entity.name === 'constructor');
  assert.equal(untouched.definitionCoverage, 'complete');
  assert.deepEqual(Object.keys(untouched.columns), Object.keys(metadata.semantic.entities[0]!.columns));
});

test('selected definitions merge existing session knowledge and remain isolated by principal and version', async t => {
  const { service, save } = await fixture(t);
  await service.call({ action: 'describe', sessionId: 'selected', entities: ['activity'], fields: { activity: ['id', 'body'] } }, principal);
  await service.call({ action: 'describe', sessionId: 'selected', entities: ['activity'], fields: { activity: ['note', 'happened_on'] } }, principal);
  const partial: any = await service.context('selected', principal);
  assert.deepEqual(Object.keys(partial.described[0].columns), ['id', 'body', 'happened_on', 'note']);
  assert.equal(partial.described[0].definitionCoverage, 'partial');
  await service.call({ action: 'describe', sessionId: 'selected', entities: ['activity'], fields: { activity: ['item_id'] } }, principal);
  const complete: any = await service.context('selected', principal);
  assert.equal(complete.described[0].definitionCoverage, 'complete');
  assert.equal(complete.described[0].availableFields, undefined);
  assert.equal((await service.context('selected', { ...principal, userId: '2' }) as any).described.length, 0);
  await save({ ...published, version: 'v2' });
  assert.equal((await service.context('selected', principal) as any).described.length, 0);
});

test('previews detect clipping and Unicode boundaries in the same read without changing row pagination', async t => {
  let body = '🙂汉🙂';
  const { service, queries, transactions } = await fixture(t, () => [{ id: 1, body }, { id: 2, body: '未返回记录' }]);
  const query = { ...activity, select: [{ field: 'a.id', as: 'id' }, { field: 'a.body', as: 'body', textLength: 2 }], limit: 1 };
  const first: any = await service.call({ action: 'query', version: 'v1', query }, principal);
  assert.equal(first.ok, true); assert.equal(first.rows[0].body, '🙂汉');
  assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 1); assert.equal(first.coverage, 'partial');
  assert.equal(first.textCoverage.excerptsOnly, true); assert.equal(first.textCoverage.fields[0].truncated, true);
  assert.match(queries[0]!.sql, /SUBSTRING\(CAST\(`a`\.`body` AS CHAR\), 1, 3\)/);
  assert.equal(transactions(), 1);
  body = '🙂汉';
  const exact: any = await service.call({ action: 'query', version: 'v1', query }, principal);
  assert.equal(exact.textCoverage.excerptsOnly, false); assert.equal(exact.textCoverage.fields[0].truncated, false);
  assert.equal(transactions(), 2); // Each request reads once; there is no clipping probe.
  const tail: any = await service.call({ action: 'query', version: 'v1', query: { ...query,
    select: [query.select[0], { ...query.select[1], textOffset: 2 }],
  } }, principal);
  assert.equal(tail.textCoverage.excerptsOnly, true); assert.equal(tail.textCoverage.fields[0].textOffset, 2);
});

test('default text bounds also expose clipping while row-complete results keep independent coverage', async t => {
  const { service, transactions } = await fixture(t, () => [{ body: '汉'.repeat(6001) }]);
  const result: any = await service.call({ action: 'batch', version: 'v1', queries: [{ id: 'long', query: {
    from: activity.from, select: [{ field: 'a.body', as: 'body' }],
  } }] }, principal);
  assert.equal(result.ok, true); assert.equal(transactions(), 1);
  assert.equal(result.results[0].rows[0].body.length, 6000);
  assert.equal(result.results[0].coverage, 'complete'); assert.equal(result.results[0].hasMore, false);
  assert.equal(result.results[0].textCoverage.excerptsOnly, true);
  assert.equal(result.results[0].textCoverage.fields[0].textLength, 6000);
});

test('reports use detected text coverage instead of treating an exact Unicode preview boundary as clipped', async t => {
  const { service, transactions } = await fixture(t, sql => sql.includes('FROM `work_items`')
    ? [{ id: 1, label: '甲' }] : [{ id: 1, body: '🙂汉', date: '2026-10-04' }]);
  const result: any = await service.call({ action: 'report', version: 'v1', report: {
    id: 'unicode-boundary', period: { start: '2026-10-01', end: '2026-11-01' },
    population: { query: items, key: 'id', label: 'label' },
    evidence: [{ query: { ...activity, select: [{ field: 'a.item_id', as: 'id' }, { field: 'a.body', as: 'body', textLength: 2 }] },
      key: 'id', content: 'body', source: 'activity' }],
  } }, principal);
  assert.equal(result.ok, true); assert.equal(transactions(), 1);
  assert.equal(result.report.coverage.excerptsOnly, false);
  assert.doesNotMatch(result.report.warnings.join(' '), /截断上限/);
});

test('prompt query examples share the accepted envelope and consistent detail/count scopes', () => {
  const lines = databaseReadGuidance('').split('\n');
  const singleLine = lines.find(line => line.startsWith('- 单条与批量'))!;
  const batchLine = lines.find(line => line.startsWith('- batch 示例'))!;
  const single = JSON.parse(singleLine.match(/示例：(\{.*\})。/)![1]!);
  const batch = JSON.parse(batchLine.match(/：(\{.*\})。/)![1]!);
  queryRequestSchema.parse({ id: single.id, query: single.query });
  const plans = batch.queries.map((request: unknown) => queryPlanForRequest(queryRequestSchema.parse(request)));
  assert.deepEqual(plans[0].where, plans[1].where);
  assert.deepEqual(plans[0].from, plans[1].from);
});
