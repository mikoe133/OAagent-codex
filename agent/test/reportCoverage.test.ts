import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OaReadService } from '../src/infrastructure/oa-read/readService.js';
import { compileQuery } from '../src/infrastructure/oa-read/queryCompiler.js';
import { beginReportTurn, checkReportAnswer, finishReportTurn, reportSchema, buildCoverageReport, rememberReport, reportForModel } from '../src/infrastructure/oa-read/reportCoverage.js';
import { canonicalReadInput } from '../src/infrastructure/oa-read/reportPlan.js';
import { parseMetadata, type PublishedMetadata } from '../src/infrastructure/oa-read/metadata.js';
import type { ReadDatabase } from '../src/infrastructure/oa-read/database.js';
import { AgentService } from '../src/application/agentService.js';

const semantic = parseMetadata({ format: 1, description: 'synthetic', rules: [], entities: [
  { name: 'objects', table: 'objects', description: 'objects', access: 'authenticated', columns: { id: { description: 'id' }, label: { description: 'label' } } },
  { name: 'evidence', table: 'evidence', description: 'evidence', access: 'authenticated', columns: { owner: { description: 'subject id' }, body: { description: 'text' }, start: { description: 'start date' }, end: { description: 'inclusive end date' } }, references: [{ column: 'owner', entity: 'objects', targetColumn: 'id' }] },
] });
const published = { version: 'v1', publishedAt: '2026-01-01', semantic, schema: { database: 'oa', tables: semantic.entities.map(e => ({
  name: e.table, kind: 'BASE TABLE', columns: Object.keys(e.columns).map(name => ({ name, type: ['start', 'end'].includes(name) ? 'date' : ['body', 'label'].includes(name) ? 'text' : 'int' })), indexes: [], foreignKeys: [], dependencies: [],
})) } } as PublishedMetadata;
const principal = { userId: '1', isAdmin: false };
const population = { from: { entity: 'objects', as: 'o' }, select: [{ field: 'o.id', as: 'key' }, { field: 'o.label', as: 'label' }] };
const evidence = { from: { entity: 'evidence', as: 'e' }, select: [{ field: 'e.owner', as: 'key' }, { field: 'e.body', as: 'text' }],
  period: { startField: 'e.start', endField: 'e.end', start: '2027-02-01', end: '2027-03-01', endInclusive: true } };
const report = { id: 'overview', period: { start: '2027-02-01', end: '2027-03-01' }, population: { query: population, key: 'key', label: 'label' }, evidence: [{ query: evidence, key: 'key', content: 'text', source: 'synthetic records' }] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'report-coverage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const save = (active = published, status = 'published') => writeFile(path.join(dir, 'current.json'), JSON.stringify({ active, report: { status } }));
  await save();
  const queries: { sql: string; bindings: unknown[] }[] = [];
  let transactions = 0;
  const db = { read: async (fn: any) => { transactions++; return fn(async (sql: string, bindings: unknown[]) => {
    queries.push({ sql, bindings });
    return sql.includes('FROM `objects`') ? [{ key: 1, label: '甲' }, { key: 2, label: '乙' }, { key: 3, label: '丙' }, { key: 4, label: '丁' }]
      : [{ key: 1, text: '完成工作' }, { key: 2, text: '' }, { key: 3, text: '修复问题<script>' }];
  }); }, close: async () => {} } as unknown as ReadDatabase;
  const service = new OaReadService({ databaseUrl: 'mysql://read:unused@localhost/oa', metadataPath: '', stateDirectory: dir, syncIntervalSeconds: 300, queryTimeoutMs: 1000, maxRows: 100, concurrency: 2 }, db);
  return { service, queries, save, transactions: () => transactions };
}

test('report groups all objects, distinguishes empty/missing evidence and fills omissions without a model call', async t => {
  const { service, queries, transactions } = await fixture(t);
  beginReportTurn('test'); t.after(async () => finishReportTurn('test'));
  const result: any = await service.call({ action: 'report', sessionId: 'test', version: 'v1', report }, principal);
  assert.equal(result.ok, true); assert.equal(transactions(), 1); assert.equal(queries.length, 2);
  assert.deepEqual(result.report.totals, { population: 4, withContent: 2, empty: 1, notFound: 1 });
  assert.deepEqual(result.report.subjects.map((s: any) => s.status), ['content', 'empty', 'content', 'not_found']);
  assert.match(queries[1]!.sql, /`e`\.`start` < \?/); assert.match(queries[1]!.sql, /`e`\.`end` >= \?/);
  assert.deepEqual(queries[1]!.bindings, [1, 2, 3, 4, '2027-03-01', '2027-02-01']);
  const checked = checkReportAnswer('test', '甲完成工作，乙正文为空。');
  assert.equal(checked.missingCount, 2); assert.match(checked.answer, /丙/); assert.match(checked.answer, /丁/);
  assert.match(checked.answer, /来源片段/); assert.doesNotMatch(checked.answer, /<script>/);
  assert.match(checked.answer, /跨边界/);
  assert.equal(checkReportAnswer('another-session', 'x').reports, 0);
});

test('batch compiles every query before opening one transaction; permission or schema failure causes zero reads', async t => {
  const { service, queries, transactions } = await fixture(t);
  assert.equal((await service.call({ action: 'batch', version: 'v1', queries: [population, { ...population, from: { entity: 'forbidden', as: 'o' } }] }, principal)).ok, false);
  assert.equal(queries.length, 0);
  const result: any = await service.call({ action: 'batch', version: 'v1', queries: [population, evidence] }, principal);
  assert.equal(result.ok, true); assert.equal(result.results.length, 2); assert.equal(transactions(), 1);
  assert.equal((await service.call({ action: 'report', version: 'v1', report: { ...report, population: { ...report.population, key: 'missing' } } }, principal)).ok, false);
  assert.equal(transactions(), 1);
  const wrongPeriod = { ...report, period: { start: '2027-01-01', end: '2027-03-01' } };
  assert.equal((await service.call({ action: 'report', version: 'v1', report: wrongPeriod }, principal)).ok, false);
  assert.equal(transactions(), 1);
});

test('period handles arbitrary months and boundary semantics, rejects reversed ranges and non-date fields', () => {
  const exclusive = compileQuery({ ...evidence, period: { ...evidence.period, endInclusive: false } }, published, principal, 100, 1000);
  assert.match(exclusive.sql, /`e`\.`end` > \?/);
  assert.throws(() => compileQuery({ ...evidence, period: { ...evidence.period, start: '2027-04-01' } }, published, principal, 100, 1000));
  assert.throws(() => compileQuery({ ...evidence, period: { ...evidence.period, startField: 'e.body' } }, published, principal, 100, 1000), /日期类型/);
});

test('schema reuse is isolated by session, user, role and metadata version, with rejected snapshots excluded', async t => {
  const { service, save, queries } = await fixture(t);
  await service.call({ action: 'describe', sessionId: 'a', entities: ['objects'] }, principal);
  assert.equal(((await service.context('a', principal)) as any).described.length, 1);
  assert.equal(((await service.context('b', principal)) as any).described.length, 0);
  assert.equal(((await service.context('a', { ...principal, userId: '2' })) as any).described.length, 0);
  assert.equal(((await service.context('a', { ...principal, isAdmin: true })) as any).described.length, 0);
  await save({ ...published, version: 'v2' });
  assert.equal(((await service.context('a', principal)) as any).described.length, 0);
  await save(published, 'rejected');
  assert.equal(((await service.context('a', principal)) as any).ok, false);
  assert.equal(queries.length, 0);
});


test('partial evidence keeps a paging cursor and never claims complete coverage', async t => {
  const { service } = await fixture(t);
  const result: any = await service.call({ action: 'report', version: 'v1', report: { ...report,
    evidence: [{ ...report.evidence[0], query: { ...evidence, limit: 1 } }],
  } }, principal);
  assert.equal(result.ok, true);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.pages[1].nextOffset, 1);
  assert.equal(result.report.pages[1].hasMore, true);
  assert.match(result.report.warnings.join(' '), /分页或截断/);
});

test('report IDs accept correlation labels, while SQL aliases remain strictly validated', async t => {
  const { service, queries } = await fixture(t);
  for (const id of ['2027-02-all-objects', 'syntax-check', '设备概览']) {
    const result: any = await service.call({ action: 'report', version: 'v1', report: { ...report, id } }, principal);
    assert.equal(result.ok, true); assert.equal(result.report.id, id);
    assert.ok(queries.every(q => !q.sql.includes(id)));
  }
  const before = queries.length;
  const bad: any = await service.call({ action: 'report', version: 'v1', report: { ...report,
    population: { ...report.population, key: 'bad-alias' },
  } }, principal);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.issues[0].path, 'report.population.key');
  assert.equal(queries.length, before);
});

test('batch echoes optional IDs, handles neq, and identifies exact invalid field without reading data', async t => {
  const { service, queries } = await fixture(t);
  const result: any = await service.call({ action: 'batch', version: 'v1', queries: [
    { ...population, id: 'objects-1', where: [{ field: 'o.id', op: 'neq', value: 3 }] },
    { ...evidence, id: 'evidence-2' },
  ] }, principal);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r: any) => r.id), ['objects-1', 'evidence-2']);
  assert.match(queries[0]!.sql, /`o`\.`id` <> \?/);
  assert.deepEqual(queries[0]!.bindings, [3]);
  const before = queries.length;
  const rejected: any = await service.call({ action: 'batch', version: 'v1', queries: [population,
    { ...evidence, select: [{ field: 'LEFT(e.body,200)', as: 'preview' }] },
  ] }, principal);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.issues[0].path, 'queries.1.query.select.0.field');
  assert.match(rejected.error.message, /textLength/);
  assert.equal(rejected.error.recovery.action, 'correct_parameters');
  assert.equal(queries.length, before);
  const preview: any = await service.call({ action: 'query', version: 'v1', query: {
    ...evidence, id: 'preview-1', select: [{ field: 'e.body', as: 'preview', textLength: 200 }],
  } }, principal);
  assert.equal(preview.ok, true); assert.equal(preview.id, 'preview-1');
  assert.match(queries.at(-1)!.sql, /SUBSTRING\(CAST\(`e`\.`body` AS CHAR\), 1, 201\)/);
});

test('validation errors return allowed operators, without echoing submitted values', async t => {
  const { service, queries } = await fixture(t);
  const result: any = await service.call({ action: 'query', version: 'v1', query: {
    ...population, where: [{ field: 'o.id', op: 'private-invalid-op', value: 'private-value' }],
  } }, principal);
  assert.equal(result.ok, false);
  assert.equal(result.error.issues[0].path, 'query.where.0.op');
  assert.match(result.error.message, /notIn/);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.equal(queries.length, 0);
});

test('failed follow-up suppresses a misleading long appendix; a refreshed report restores coverage', async t => {
  const { service, save } = await fixture(t);
  beginReportTurn('interrupted'); t.after(async () => finishReportTurn('interrupted'));
  const request = { action: 'report', sessionId: 'interrupted', version: 'v1', report };
  await service.call(request, principal);
  await save(published, 'rejected');
  await service.call({ action: 'query', sessionId: 'interrupted', version: 'v1', query: evidence }, principal);
  const stopped = checkReportAnswer('interrupted', '本次数据不足。');
  assert.equal(stopped.interrupted, true);
  assert.match(stopped.answer, /后续数据读取失败/);
  assert.doesNotMatch(stopped.answer, /甲|乙|丙|丁/);
  assert.equal(stopped.replacement, true);
  await save();
  await service.call(request, principal);
  assert.equal(checkReportAnswer('interrupted', '甲').interrupted, false);
});

test('explicit preview lengths retain a truncation warning even below the default text limit', async t => {
  const { service } = await fixture(t);
  const result: any = await service.call({ action: 'report', version: 'v1', report: { ...report,
    evidence: [{ ...report.evidence[0], query: { ...evidence, select: [evidence.select[0], { ...evidence.select[1], textLength: 4 }] } }],
  } }, principal);
  assert.equal(result.ok, true);
  assert.match(result.report.warnings.join(' '), /截断上限/);
});

test('grounded reports never accept invented empty-object facts or another object\'s evidence', async t => {
  const { service } = await fixture(t);
  beginReportTurn('grounded'); t.after(async () => finishReportTurn('grounded'));
  const result: any = await service.call({ action: 'report', sessionId: 'grounded', version: 'v1', report }, principal);
  const first = result.report.subjects.find((s: any) => s.key === '1');
  const third = result.report.subjects.find((s: any) => s.key === '3');
  assert.ok(first.fragments.length); assert.ok(third.fragments.length);
  const fabricated = checkReportAnswer('grounded', '乙完成不存在的重大成果，丁没有提交，甲做了丙的工作。');
  assert.equal(fabricated.replacement, true);
  assert.doesNotMatch(fabricated.answer, /不存在的重大成果|丁没有提交|甲做了丙/);
  assert.match(fabricated.answer, /乙.*正文为空/);
  assert.match(fabricated.answer, /丁.*不能据此认定未提交/);
  const selected = checkReportAnswer('grounded', JSON.stringify({ format: 'oa-report-answer/v1', reports: [{ id: 'overview', highlights: [
    { key: '1', evidenceIds: [third.fragments[0].id] }, // cross-object reference is ignored
    { key: '2', evidenceIds: [first.fragments[0].id] }, // empty object cannot acquire progress
    { key: '3', evidenceIds: [third.fragments[0].id] },
  ] }] }));
  const row = selected.answer.split('\n').find(line => line.includes('**甲**'))!;
  assert.match(row, /完成工作/); assert.doesNotMatch(row, /修复问题/);
  assert.match(selected.answer.split('\n').find(line => line.includes('**乙**'))!, /正文为空/);
  assert.equal(selected.missingCount, 1);
});

test('shorter previews reuse richer evidence within the same turn; changed identity or period cannot reuse it', async t => {
  const { service, transactions } = await fixture(t);
  beginReportTurn('reuse'); t.after(async () => finishReportTurn('reuse'));
  const request = (length: number) => ({ action: 'report', sessionId: 'reuse', version: 'v1', report: { ...report,
    evidence: [{ ...report.evidence[0], query: { ...evidence, select: [evidence.select[0], { ...evidence.select[1], textLength: length }] } }],
  } });
  const first: any = await service.call(request(500), principal);
  const shorter: any = await service.call(request(200), principal);
  assert.equal(first.cacheReused, false); assert.equal(shorter.cacheReused, true);
  assert.equal(transactions(), 1);
  assert.deepEqual(shorter.report.subjects, first.report.subjects);
  await service.call(request(200), { ...principal, userId: 'another-user' });
  assert.equal(transactions(), 2);
  const changed = request(200);
  changed.report.period = { start: '2027-01-01', end: '2027-03-01' };
  changed.report.evidence[0]!.query.period = { ...evidence.period, start: '2027-01-01' };
  const otherPeriod: any = await service.call(changed, principal);
  assert.equal(otherPeriod.ok, true); assert.equal(otherPeriod.cacheReused, false);
  assert.equal(transactions(), 3);
});

test('registered period relations avoid calendar prefetch and preserve the routed interval', async t => {
  const { service, save, queries, transactions } = await fixture(t);
  const metadata = structuredClone(published);
  const calendar = { name: 'cycles', table: 'cycles', description: 'generic calendar', access: 'authenticated' as const,
    columns: { id: { description: 'cycle key' }, begin: { description: 'start' }, finish: { description: 'inclusive end' } }, references: [], filters: [],
    period: { startColumn: 'begin', endColumn: 'finish', endInclusive: true } };
  metadata.semantic.entities.push(calendar);
  const entity = metadata.semantic.entities.find(e => e.name === 'evidence')!;
  entity.columns.cycle = { description: 'calendar reference' };
  entity.references.push({ column: 'cycle', entity: 'cycles', targetColumn: 'id' });
  metadata.schema.tables.find(t => t.name === 'evidence')!.columns.push({ ...metadata.schema.tables[0]!.columns[0]!, name: 'cycle' });
  metadata.schema.tables.push({ ...metadata.schema.tables[0]!, name: 'cycles', columns: [
    { ...metadata.schema.tables[0]!.columns[0]!, name: 'id' },
    { ...metadata.schema.tables[1]!.columns.find(c => c.name === 'start')!, name: 'begin' },
    { ...metadata.schema.tables[1]!.columns.find(c => c.name === 'end')!, name: 'finish' },
  ] });
  await save(metadata);
  beginReportTurn('period', 'generic request', { start: '2028-05-01', end: '2028-06-01' });
  t.after(async () => finishReportTurn('period'));
  const { period: _, ...withoutQueryPeriod } = evidence;
  const { period: __, ...withoutReportPeriod } = report;
  const plan = { ...withoutReportPeriod, evidence: [{ ...report.evidence[0], query: withoutQueryPeriod }] };
  const result: any = await service.call({ action: 'report', sessionId: 'period', version: 'v1', report: plan }, principal);
  assert.equal(result.ok, true); assert.equal(transactions(), 1); assert.equal(queries.length, 2);
  assert.deepEqual(result.report.period, { start: '2028-05-01', end: '2028-06-01' });
  assert.match(queries[1]!.sql, /INNER JOIN .*FROM `cycles`/);
  assert.match(queries[1]!.sql, /`report_period`\.`begin` < \?/);
  assert.match(queries[1]!.sql, /`report_period`\.`finish` >= \?/);
  assert.match(queries[1]!.sql, /`e`\.`owner` IN \(\?, \?, \?, \?\)/);
  assert.deepEqual(queries[1]!.bindings.slice(-2), ['2028-06-01', '2028-05-01']);
  const altered: any = await service.call({ action: 'report', sessionId: 'period', version: 'v1', report }, principal);
  assert.equal(altered.ok, false); assert.match(altered.error.message, /路由确认/); assert.equal(transactions(), 1);
  const narrower = { ...plan, evidence: [{ ...plan.evidence[0], query: { ...withoutQueryPeriod, where: [{ field: 'e.cycle', op: 'in', value: [7, 8] }] } }] };
  const blocked: any = await service.call({ action: 'report', sessionId: 'period', version: 'v1', report: narrower }, principal);
  assert.equal(blocked.ok, false); assert.match(blocked.error.message, /重复缩小/); assert.equal(transactions(), 1);
});

test('negative enum filters exclude unclassified values, and undefined flags cannot silently narrow reports', async t => {
  const { service, save, transactions } = await fixture(t);
  const metadata = structuredClone(published);
  const entity = metadata.semantic.entities.find(e => e.name === 'objects')!;
  entity.columns.category = { description: 'registered type', values: { draft: 'Draft', ready: 'Ready', retired: 'Retired' } };
  entity.columns.state_flag = { description: 'undefined meaning', filterPolicy: 'explicit_only' };
  for (const name of ['category', 'state_flag']) metadata.schema.tables[0]!.columns.push({ ...metadata.schema.tables[0]!.columns[0]!, name });
  const compiled = compileQuery({ ...population, where: [{ field: 'o.category', op: 'ne', value: 'draft' }] }, metadata, principal, 100, 1000);
  assert.match(compiled.sql, /`o`\.`category` IN \(\?, \?\)/);
  assert.deepEqual(compiled.bindings, ['ready', 'retired']);
  assert.throws(() => compileQuery({ ...population, where: [{ field: 'o.state_flag', op: 'eq', value: 1 }] }, metadata, principal, 100, 1000), /尚未定义业务/);
  assert.doesNotThrow(() => compileQuery({ ...population, where: [{ field: 'o.state_flag', op: 'eq', value: 1 }] }, metadata, principal, 100, 1000, { task: '只筛选 state_flag=1' }));
  await save(metadata);
  const result: any = await service.call({ action: 'report', version: 'v1', report: { ...report, population: { ...report.population,
    query: { ...population, where: [{ field: 'o.state_flag', op: 'eq', value: 1 }] },
  } } }, principal);
  assert.equal(result.ok, false); assert.equal(transactions(), 0);
});

test('equivalent flat report shapes and singular join normalize without discarding unknown fields', () => {
  const raw = { action: 'report', version: 'v1', report: { ...report,
    population: { ...population, key: 'o.id', label: 'o.label' },
    evidence: [{ ...evidence, join: [{ entity: 'objects', as: 'o', on: { left: 'e.owner', right: 'o.id' } }], key: 'e.owner', content: 'text', source: 'generic' }],
  } };
  const normalized: any = canonicalReadInput(raw);
  const plan = reportSchema.parse(normalized.report);
  assert.equal(plan.population.key, 'key'); assert.equal(plan.population.label, 'label');
  assert.equal(plan.evidence[0]!.query.joins.length, 1); assert.equal(plan.evidence[0]!.key, 'key');
  const bad: any = structuredClone(raw); bad.report.population.sql = 'SELECT * FROM private';
  assert.throws(() => reportSchema.parse((canonicalReadInput(bad) as any).report));
});

test('fair excerpts retain late objects and distinguish complete rows from partial text', () => {
  const plan = reportSchema.parse(report);
  const populationRows = Array.from({ length: 30 }, (_, i) => ({ key: i, label: `Object ${i}` }));
  const evidenceRows = populationRows.flatMap(row => Array.from({ length: 5 }, (_, i) => ({ key: row.key, text: `Record ${i}: ${'长正文'.repeat(2000)}` })));
  const result = buildCoverageReport(plan, [
    { rows: populationRows, returned: 30, hasMore: false, coverage: 'complete' },
    { rows: evidenceRows, returned: 150, hasMore: false, coverage: 'complete' },
  ]);
  assert.equal(result.subjects.every(s => s.fragments.length > 0), true);
  assert.equal(result.coverage.evidenceRowsComplete, true); assert.equal(result.coverage.excerptsOnly, true);
  assert.ok(Buffer.byteLength(JSON.stringify(reportForModel(result))) < 80 * 1024);
  beginReportTurn('fair'); rememberReport('fair', result);
  const answer = checkReportAnswer('fair', '{}'); finishReportTurn('fair');
  assert.match(answer.answer, /Object 29/); assert.doesNotMatch(answer.answer, /oa-report-answer\/v1/);
});

test('report model prose is withheld from the chat stream until grounded rendering', async t => {
  const { service } = await fixture(t);
  beginReportTurn('streamed'); t.after(async () => finishReportTurn('streamed'));
  await service.call({ action: 'report', sessionId: 'streamed', version: 'v1', report }, principal);
  const agent = new AgentService({} as any, {} as any);
  const state: any = { items: [], messageTexts: new Map(), finalResponse: '', activeToolIds: new Set(), toolStartedAt: new Map(), commandOutputs: new Map() };
  const emitted: any[] = [];
  await (agent as any).emitItemEvent('streamed', 'item.completed', { type: 'agent_message', id: 'answer', text: '乙完成不存在的成果' }, state, [], async (event: any) => emitted.push(event));
  assert.equal(emitted.length, 0);
  assert.equal(state.finalResponse, '乙完成不存在的成果');
  const rendered = checkReportAnswer('streamed', state.finalResponse);
  assert.doesNotMatch(rendered.answer, /不存在的成果/);
  assert.match(rendered.answer, /正文为空/);
  finishReportTurn('streamed');
  await (agent as any).emitItemEvent('normal', 'item.completed', { type: 'agent_message', id: 'normal-answer', text: '普通回答' }, state, [], async (event: any) => emitted.push(event));
  assert.equal(emitted.length, 1); assert.equal(emitted[0].text, '普通回答');
});
