import { z } from 'zod';
import { querySchema } from './queryCompiler.js';
import type { PublishedMetadata, Entity } from './metadata.js';
import type { ReportPlan } from './reportCoverage.js';

export const reportPeriodSchema = z.object({ start: z.string().date(), end: z.string().date() }).strict().refine(v => v.start < v.end);
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Normalize only equivalent protocol shapes, never business filters or dates.
export function canonicalReadInput(raw: unknown): unknown {
  if (!record(raw)) return raw;
  const normalizeQuery = (query: unknown) => {
    if (!record(query) || !('join' in query) || 'joins' in query) return query;
    const { join, ...rest } = query;
    return { ...rest, joins: join };
  };
  if (raw.action === 'query') return { ...raw, query: normalizeQuery(raw.query) };
  if (raw.action === 'batch' && Array.isArray(raw.queries)) return { ...raw, queries: raw.queries.map(normalizeQuery) };
  if (raw.action !== 'report' || !record(raw.report)) return raw;
  const spec = (value: unknown) => {
    if (!record(value)) return value;
    let normalized = { ...value };
    if (!('query' in normalized) && 'from' in normalized) {
      const query: Record<string, unknown> = {};
      for (const key of [...querySchema.keyof().options, 'join']) {
        if (key in normalized) { query[key] = normalized[key]; delete normalized[key]; }
      }
      normalized.query = query;
    }
    normalized.query = normalizeQuery(normalized.query);
    // A qualified key is an exact field reference, not a guessed join/identity.
    if (record(normalized.query) && Array.isArray(normalized.query.select)) {
      const query = { ...normalized.query, select: [...normalized.query.select] };
      for (const key of ['key', 'label', 'content']) {
        const field = normalized[key];
        if (typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(field)) continue;
        const matches = query.select.filter(s => record(s) && s.field === field && !s.aggregate);
        if (matches.length === 1 && record(matches[0])) normalized[key] = matches[0].as;
        else if (!matches.length && key !== 'content') {
          let alias = `report_${key}`;
          while (query.select.some(s => record(s) && s.as === alias)) alias += '_';
          query.select.push({ field, as: alias }); normalized[key] = alias;
        }
      }
      normalized.query = query;
    }
    return normalized;
  };
  return { ...raw, report: { ...raw.report, population: spec(raw.report.population),
    ...(Array.isArray(raw.report.evidence) ? { evidence: raw.report.evidence.map(spec) } : {}) } };
}

export function prepareReportPlan(plan: ReportPlan, metadata: PublishedMetadata, expectedPeriod?: ReportPeriod | null): ReportPlan {
  if (expectedPeriod && plan.period && JSON.stringify(expectedPeriod) !== JSON.stringify(plan.period)) throw new Error('report.period 与本轮语义路由确认的用户期间不一致；保留用户期间，不能在重试时改变范围。');
  const period = expectedPeriod ?? plan.period;
  return { ...plan, ...(period ? { period } : {}), evidence: plan.evidence.map(evidence => {
    const query = structuredClone(evidence.query);
    for (const selection of query.select) if (selection.as === evidence.content && selection.textLength === undefined) selection.textLength = 600;
    const base = metadata.semantic.entities.find(e => e.name === query.from.entity);
    const candidates: { entity: Entity; alias: string; relation?: NonNullable<Entity['references'][number]> }[] = [];
    if (base?.period) candidates.push({ entity: base, alias: query.from.as });
    for (const ref of base?.references ?? []) {
      const target = metadata.semantic.entities.find(e => e.name === ref.entity);
      if (target?.period) {
        const joined = query.joins.find(j => j.entity === target.name && ((j.on.left === `${query.from.as}.${ref.column}` && j.on.right === `${j.as}.${ref.targetColumn}`) || (j.on.right === `${query.from.as}.${ref.column}` && j.on.left === `${j.as}.${ref.targetColumn}`)));
        candidates.push({ entity: target, alias: joined?.as ?? '', relation: ref });
      }
    }
    if (!period) {
      const periodFields = new Set(candidates.flatMap(c => [
        ...(c.alias ? [`${c.alias}.${c.entity.period!.startColumn}`, ...(c.entity.period!.endColumn ? [`${c.alias}.${c.entity.period!.endColumn}`] : [])] : []),
        ...(c.relation ? [`${query.from.as}.${c.relation.column}`] : []),
      ]));
      if (query.period || [...query.where, ...query.anyOf].some(c => periodFields.has(c.field))) throw new Error('有期间筛选的 report 必须声明 report.period:{start,end}；不能只传编号列表或周起始日条件。无期间要求的全历史查询可省略 period。');
      return { ...evidence, query };
    }
    if (query.period && (query.period.start !== period.start || query.period.end !== period.end)) throw new Error('证据 query.period 必须使用 report.period 的同一范围');
    if (candidates.length > 1 && !query.period) throw new Error('存在多个期间来源，请根据语义元数据明确 query.period 的日期字段');
    const candidate = candidates.find(c => query.period?.startField === `${c.alias}.${c.entity.period!.startColumn}`) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (candidates.length && !candidate) throw new Error('query.period 未引用已登记的期间来源，请明确关联和对应日期字段');
    if (candidate) {
      if (!candidate.alias) {
        let alias = 'report_period';
        while ([query.from, ...query.joins].some(s => s.as === alias)) alias += '_';
        candidate.alias = alias;
        query.joins.push({ entity: candidate.entity.name, as: alias, type: 'inner', on: { left: `${query.from.as}.${candidate.relation!.column}`, right: `${alias}.${candidate.relation!.targetColumn}` } });
      }
      const definition = candidate.entity.period!;
      const expected = { startField: `${candidate.alias}.${definition.startColumn}`, ...(definition.endColumn ? { endField: `${candidate.alias}.${definition.endColumn}` } : {}), ...period, endInclusive: definition.endInclusive };
      if (query.period && (query.period.startField !== expected.startField || query.period.endField !== expected.endField || query.period.endInclusive !== expected.endInclusive)) throw new Error('query.period 必须使用元数据声明的完整日期区间及结束日包含规则，避免漏掉跨边界记录');
      const fields = new Set([expected.startField, expected.endField, ...(candidate.relation ? [`${query.from.as}.${candidate.relation.column}`, `${candidate.alias}.${candidate.relation.targetColumn}`] : [])]);
      if ([...query.where, ...query.anyOf].some(c => fields.has(c.field))) throw new Error('期间已由 report.period 约束，请移除额外的期间编号/起止日期筛选，避免重复缩小范围');
      query.period = expected;
    }
    if (!query.period) throw new Error('未找到已声明期间字段，请明确 evidence.query.period 或为数据源补充期间元数据');
    if (!query.groupBy.length && !query.select.some(s => s.aggregate)) {
      const fields = [query.period.startField, ...(query.period.endField ? [query.period.endField] : [])];
      for (const [index, field] of fields.entries()) {
        if (query.select.some(s => s.field === field) || query.select.length >= 30) continue;
        let alias = `report_date_${index}`;
        while (query.select.some(s => s.as === alias)) alias += '_';
        query.select.push({ field, as: alias });
      }
    }
    return { ...evidence, query };
  }) };
}
