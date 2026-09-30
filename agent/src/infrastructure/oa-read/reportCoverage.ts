import { z } from 'zod';
import { createHash } from 'node:crypto';
import { queryId, querySchema } from './queryCompiler.js';
import { reportPeriodSchema, type ReportPeriod } from './reportPlan.js';

const alias = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '必须引用 select.as 的输出别名，不是 别名.字段；标识仅含字母、数字、下划线').max(64);
export const reportSchema = z.object({
  id: queryId,
  period: reportPeriodSchema.optional(),
  population: z.object({ query: querySchema, key: alias, label: alias }).strict(),
  evidence: z.array(z.object({ query: querySchema, key: alias, content: alias, source: z.string().min(1).max(80) }).strict()).min(1).max(4),
}).strict();
export type ReportPlan = z.infer<typeof reportSchema>;
export type QueryResult = { rows: Record<string, unknown>[]; hasMore: boolean; coverage: string; returned: number; nextOffset?: number | null };
export type EvidenceFragment = { id: string; text: string; source: string };
type Subject = { key: string; label: string; status: 'content' | 'empty' | 'not_found'; records: { source: string; content: string; fields: Record<string, unknown> }[]; fragments: EvidenceFragment[] };
export type CoverageReport = {
  id: string; subjects: Subject[]; complete: boolean; warnings: string[];
  pages: { source: string; returned: number; hasMore: boolean; nextOffset: number | null }[];
  period?: { start: string; end: string };
  totals: { population: number; withContent: number; empty: number; notFound: number };
  coverage: { populationComplete: boolean; evidenceRowsComplete: boolean; excerptsOnly: boolean };
  populationFilters: ReportPlan['population']['query']['where'];
  scopeNotes: string[];
};
const turns = new Map<string, Map<string, CoverageReport>>();
const interrupted = new Map<string, string>();
const contexts = new Map<string, { task?: string; period?: ReportPeriod | null; cache: Map<string, { principal: string; version: string; plan: ReportPlan; results: QueryResult[] }> }>();
export function beginReportTurn(sessionId: string, task?: string, period?: ReportPeriod | null) { turns.set(sessionId, new Map()); interrupted.delete(sessionId); contexts.set(sessionId, { task, period, cache: new Map() }); }
export function finishReportTurn(sessionId: string) { turns.delete(sessionId); interrupted.delete(sessionId); contexts.delete(sessionId); }
export const reportTurnContext = (sessionId?: string) => sessionId ? contexts.get(sessionId) : undefined;
export const hasReportForTurn = (sessionId: string) => !!turns.get(sessionId)?.size;
const cacheKey = (plan: ReportPlan) => JSON.stringify({ ...plan, population: { ...plan.population, query: { ...plan.population.query, select: plan.population.query.select.map(({ textLength: _, ...s }) => s) } }, evidence: plan.evidence.map(e => ({ ...e, query: { ...e.query, select: e.query.select.map(({ textLength: _, ...s }) => s) } })) });
export function cachedReportRows(sessionId: string | undefined, plan: ReportPlan, version: string, principal: string) {
  const entry = reportTurnContext(sessionId)?.cache.get(cacheKey(plan));
  if (!entry || entry.version !== version || entry.principal !== principal || entry.results.some(r => r.hasMore)) return undefined;
  const prior = [entry.plan.population.query, ...entry.plan.evidence.map(e => e.query)];
  const current = [plan.population.query, ...plan.evidence.map(e => e.query)];
  return current.every((q, i) => q.select.every((s, j) => (s.textLength ?? 6000) <= (prior[i]!.select[j]!.textLength ?? 6000))) ? entry : undefined;
}
export function cacheReportRows(sessionId: string | undefined, plan: ReportPlan, version: string, principal: string, results: QueryResult[]) {
  const cache = reportTurnContext(sessionId)?.cache;
  if (cache && cache.size < 4 && Buffer.byteLength(JSON.stringify(results)) <= 640 * 1024) cache.set(cacheKey(plan), { plan, version, principal, results });
}
export function markReportReadFailure(sessionId: string, code: string) {
  if (turns.get(sessionId)?.size) interrupted.set(sessionId, code);
}
export function rememberReport(sessionId: string | undefined, report: CoverageReport) {
  const turn = sessionId ? turns.get(sessionId) : undefined;
  if (sessionId && turn && (turn.has(report.id) || turn.size < 4)) {
    turn.set(report.id, report);
    // Only a refreshed report can supersede a failed follow-up read.
    interrupted.delete(sessionId);
  }
}

// Only account for model-selected result columns; no business names or date rules.
export function buildCoverageReport(plan: ReportPlan, results: QueryResult[], scopeNotes: string[] = []): CoverageReport {
  const warnings: string[] = [];
  if (results.some(r => r.coverage !== 'complete')) warnings.push('查询包含分页或截断，以下仅覆盖本次返回范围。');
  if (plan.period && plan.evidence.some(e => !e.query.period)) warnings.push('部分证据未声明 period，不能据此确认完整时间范围。');
  if (plan.evidence.some(e => e.query.period?.endField)) warnings.push('期间按相交区间检索；跨边界记录的正文未按日拆分，不能将全部内容归入目标期间。');
  const subjects = new Map<string, Subject>();
  for (const row of results[0]!.rows) {
    const key = scalarKey(row[plan.population.key]);
    const label = scalarKey(row[plan.population.label]);
    if (key === null || label === null) { warnings.push('对象标识或展示名称缺失。'); continue; }
    if (subjects.has(key)) { warnings.push('对象清单包含重复标识。'); continue; }
    subjects.set(key, { key, label, status: 'not_found', records: [], fragments: [] });
  }
  const contentCounts = new Map<string, number>();
  for (const [i, evidence] of plan.evidence.entries()) for (const row of results[i + 1]!.rows) {
    const key = scalarKey(row[evidence.key]);
    if (key !== null && subjects.has(key) && row[evidence.content] != null && String(row[evidence.content]).trim()) contentCounts.set(key, (contentCounts.get(key) ?? 0) + 1);
  }
  const bytesPerSubject = Math.floor(96 * 1024 / Math.max(1, contentCounts.size));
  let excerptsOnly = false;
  for (const [i, evidence] of plan.evidence.entries()) {
    for (const row of results[i + 1]!.rows) {
      const key = scalarKey(row[evidence.key]);
      const subject = key === null ? undefined : subjects.get(key);
      if (!subject) continue;
      if (!Object.hasOwn(row, evidence.content)) { warnings.push('证据返回字段缺失。'); continue; }
      const raw = row[evidence.content];
      const content = typeof raw === 'string' ? raw.trim() : raw == null ? '' : JSON.stringify(raw);
      if (subject.status === 'not_found') subject.status = 'empty';
      if (!content) continue;
      subject.status = 'content';
      const fields = Object.fromEntries(Object.entries(row).filter(([key]) => key !== evidence.content));
      const selection = evidence.query.select.find(s => s.as === evidence.content);
      if (content.length >= (selection?.textLength ?? 6000) || (selection?.textOffset ?? 0) > 0) { excerptsOnly = true; warnings.push('证据可能达到文本截断上限或仅包含正文片段，不能声称已读取全文。'); }
      const budget = Math.max(64, Math.floor(bytesPerSubject / contentCounts.get(subject.key)!) - Buffer.byteLength(JSON.stringify(fields)));
      const retained = boundText(content, budget);
      if (retained.length < content.length) { excerptsOnly = true; warnings.push('正文已按对象均衡截取，保留片段而非全文。'); }
      const dateAlias = (field?: string) => evidence.query.select.find(s => s.field === field)?.as;
      const start = row[dateAlias(evidence.query.period?.startField) ?? ''];
      const end = row[dateAlias(evidence.query.period?.endField) ?? ''];
      const range = typeof start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(start) ? `（${start.slice(0, 10)}${typeof end === 'string' ? ` 至 ${end.slice(0, 10)}` : ''}）` : '';
      subject.records.push({ source: evidence.source + range, content: retained, fields });
    }
  }
  const values = [...subjects.values()];
  // Fair, bounded excerpts prevent a few long objects from using the entire
  // model context. IDs let the model select highlights instead of rewriting facts.
  const fragmentBudget = Math.max(300, Math.floor(48 * 1024 / Math.max(1, values.filter(s => s.status === 'content').length)));
  for (const subject of values) {
    let bytes = 0;
    const candidates = subject.records.map(record => fragmentText(record.content).map(text => ({
      id: createHash('sha256').update(JSON.stringify([subject.key, record.source, record.fields, text])).digest('hex').slice(0, 12), text, source: record.source,
    })));
    // Round-robin over records, so later source records are also represented.
    for (let index = 0; index < Math.max(0, ...candidates.map(c => c.length)); index++) {
      for (const fragments of candidates) {
        const fragment = fragments[index];
        if (!fragment || subject.fragments.some(f => f.id === fragment.id)) continue;
        const size = Buffer.byteLength(JSON.stringify(fragment));
        if (bytes + size > fragmentBudget || subject.fragments.length >= 8) continue;
        subject.fragments.push(fragment); bytes += size;
      }
    }
  }
  if (new Set(values.map(s => s.label)).size !== values.length) warnings.push('对象存在同名，回答须同时列出标识以免混淆。');
  return { id: plan.id, ...(plan.period ? { period: plan.period } : {}),
    pages: results.map((result, i) => ({ source: i ? plan.evidence[i - 1]!.source : 'population', returned: result.returned, hasMore: result.hasMore, nextOffset: result.nextOffset ?? null })),
    subjects: values, complete: warnings.length === 0, warnings: [...new Set(warnings)],
    totals: { population: values.length, withContent: values.filter(s => s.status === 'content').length,
      empty: values.filter(s => s.status === 'empty').length, notFound: values.filter(s => s.status === 'not_found').length },
    coverage: { populationComplete: results[0]!.coverage === 'complete', evidenceRowsComplete: results.slice(1).every(r => r.coverage === 'complete'),
      excerptsOnly },
    populationFilters: plan.population.query.where, scopeNotes };
}

function fragmentText(content: string): string[] {
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^#{1,6}\s|^```|^[-*]\s*$/.test(line));
  return (lines.length ? lines : [content]).map(line => line.length > 240 ? `${line.slice(0, 240)}…` : line);
}

function boundText(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(text.slice(0, mid)) <= bytes) low = mid; else high = mid - 1; }
  const result = text.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

export function reportForModel(report: CoverageReport) {
  return { ...report, subjects: report.subjects.map(({ records: _, ...subject }) => subject),
    answerContract: { format: 'oa-report-answer/v1', instruction: '最终回答仅输出 JSON：{"format":"oa-report-answer/v1","reports":[{"id":"报告id","highlights":[{"key":"对象key","evidenceIds":["该对象的fragment.id，最多3个"]}]}]}。选择能代表进展的来源片段，不重写事实。服务端负责对象名称、数量、空正文、未查到记录、筛选与期间说明。',
      rowsComplete: report.coverage.evidenceRowsComplete,
      instructionForExcerpts: 'excerptsOnly 表示正文片段，和行分页无关；rowsComplete=true 时不要因片段提示而重新缩短正文取数。需要其他内容时只补查具体对象或记录。' } };
}

const scalarKey = (value: unknown) => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const escape = (text: string) => text.replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&').replace(/\s+/g, ' ');
const answerSchema = z.object({ format: z.literal('oa-report-answer/v1'), reports: z.array(z.object({ id: queryId,
  highlights: z.array(z.object({ key: z.string().max(128), evidenceIds: z.array(z.string().regex(/^[a-f0-9]{12}$/)).max(3) }).strict()).max(1000),
}).strict()).max(4) }).strict();

// Rendering is grounded in data and exact excerpts. A model selects evidence IDs;
// unsupported prose, cross-object references and invented empty-object progress
// cannot become report facts. Invalid/missing selections use existing excerpts.
export function checkReportAnswer(sessionId: string, answer: string) {
  const reports = [...(turns.get(sessionId)?.values() ?? [])];
  if (!reports.length) return { answer, appendix: '', reports: 0, subjectCount: 0, missingCount: 0, limited: false, interrupted: false, replacement: false };
  let selection: z.infer<typeof answerSchema> | undefined;
  try {
    if (answer.length <= 128 * 1024) selection = answerSchema.parse(JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  } catch { /* No additional model call to repair formatting. */ }
  const interruption = interrupted.get(sessionId);
  const notes: string[] = [];
  let missingCount = 0;
  let subjectCount = 0;
  for (const report of reports) {
    subjectCount += report.subjects.length;
    notes.push(`**查询对象进度概览${report.period ? `（${report.period.start} 至 ${report.period.end}，不含结束日）` : ''}**`);
    notes.push(`本次对象清单 ${report.totals.population} 个；${report.totals.withContent} 个有正文，${report.totals.empty} 个仅返回空正文，${report.totals.notFound} 个在本次证据范围内未查到记录。${!report.coverage.populationComplete || !report.coverage.evidenceRowsComplete ? '行范围尚未完整，以上为本次返回数量。' : ''}`);
    if (report.populationFilters.length || report.scopeNotes.length) notes.push(`筛选口径：${report.scopeNotes.length ? report.scopeNotes.map(escape).join('；') : `对象清单包含 ${report.populationFilters.length} 条筛选条件`}。对象数量仅代表这一口径。`);
    if (interruption) {
      notes.push('后续数据读取失败，已有证据仅供部分参考，本次未展开对象正文。');
      continue;
    }
    const selected = selection?.reports.find(r => r.id === report.id);
    for (const subject of report.subjects.slice(0, 100)) {
      const name = `**${escape(subject.label.slice(0, 160))}**（${escape(subject.key.slice(0, 128))}）`;
      if (subject.status !== 'content') {
        notes.push(`- ${name}：${subject.status === 'empty' ? '本次返回的记录正文为空，无法据此总结具体进展。' : '本次证据范围内未查到记录；不能据此认定未提交或没有进展。'}`);
        continue;
      }
      const ids = selected?.highlights.filter(s => s.key === subject.key).flatMap(s => s.evidenceIds) ?? [];
      let fragments = [...new Set(ids)].map(id => subject.fragments.find(f => f.id === id)).filter((f): f is EvidenceFragment => !!f).slice(0, 3);
      if (!fragments.length) { fragments = subject.fragments.slice(0, 2); missingCount++; }
      const detail = fragments.length ? fragments.map(f => `「${escape(f.text)}」（来源：${escape(f.source)}）`).join('；') : '有正文，但本次输出预算未保留可引用片段，需补查此对象。';
      notes.push(`- ${name}：${detail}`);
    }
    if (report.subjects.length > 100) notes.push(`还有 ${report.subjects.length - 100} 个对象未展开，可按范围分组查看。`);
    if (report.warnings.length) notes.push(`范围说明：${report.warnings.join(' ')}`);
    notes.push('以上为来源片段选摘；未对跨期间正文按日拆分。');
  }
  return { answer: notes.join('\n\n'), appendix: '', reports: reports.length, subjectCount, missingCount,
    limited: !!interruption || reports.some(report => !report.complete), interrupted: !!interruption, replacement: true };
}
