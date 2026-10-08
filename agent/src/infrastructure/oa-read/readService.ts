import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OaReadConfig } from "../../config/oaReadConfig.js";
import { ReadDatabase } from "./database.js";
import { accessible, type Principal, type PublishedMetadata } from "./metadata.js";
import { reportSchema, buildCoverageReport, rememberReport, markReportReadFailure, reportTurnContext, cachedReportRows, cacheReportRows, reportForModel } from "./reportCoverage.js";
import { canonicalReadInput, prepareReportPlan } from './reportPlan.js';
import { compileQuery, querySchema } from "./queryCompiler.js";
import { invalidQuery } from "./queryValidation.js";
import { readCatalogState, synchronizeMetadata } from "./schemaSync.js";
import { tableAccess } from "./accessPolicy.js";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("catalog"), sessionId: z.string().optional(), search: z.string().max(100).optional() }).strict(),
  z.object({ action: z.literal("describe"), sessionId: z.string().optional(), entities: z.array(z.string()).min(1).max(10) }).strict(),
  z.object({ action: z.literal("batch"), sessionId: z.string().optional(), version: z.string(), queries: z.array(querySchema).min(1).max(5) }).strict(),
  z.object({ action: z.literal("report"), sessionId: z.string().optional(), version: z.string(), report: reportSchema }).strict(),
  z.object({ action: z.literal("query"), sessionId: z.string().optional(), version: z.string(), query: querySchema }).strict(),
  z.object({ action: z.literal("self"), sessionId: z.string().optional(), version: z.string() }).strict(),
]);
// The legacy OA tool token is given to the model process. It must NOT be the
// signing key for capabilities that authorize access to other sessions.
const capabilitySecret = randomBytes(32);
export const readToolToken = (secret: string, sessionId: string) => createHmac("sha256", capabilitySecret).update(secret).update(`\0oa-read:${sessionId}`).digest("hex");

export class OaReadService {
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private readonly descriptions = new Map<string, { version: string; principal: string; at: number; entities: Record<string, unknown>[] }>();

  async context(sessionId: string, principal: Principal) {
    const catalog = await this.call({ action: 'catalog' }, principal);
    if (!catalog.ok || !('version' in catalog)) return catalog;
    const cached = this.descriptions.get(sessionId);
    const valid = cached && cached.version === catalog.version && cached.principal === JSON.stringify(principal) && Date.now() - cached.at < 10 * 60 * 1000;
    return { catalog, described: valid ? cached.entities : [] };
  }
  private starting?: Promise<void>;
  private closed = false;
  private syncing?: ReturnType<typeof synchronizeMetadata>;
  private readonly db: ReadDatabase;
  private readonly syncDb: ReadDatabase;
  constructor(readonly config: OaReadConfig, db?: ReadDatabase) {
    this.db = db ?? new ReadDatabase(config);
    // Background schema validation must not exhaust the user-query pool, or be
    // mistaken for a schema failure merely because all query slots are occupied.
    this.syncDb = db ?? new ReadDatabase({ ...config, concurrency: 1 });
  }

  sync(trigger: string) {
    if (this.syncing) return this.syncing;
    this.syncing = synchronizeMetadata(this.config, this.syncDb, trigger).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("oa_read_service_closed"));
    if (this.starting) return this.starting;
    const check = async (trigger: string) => {
      try {
        const report = await this.sync(trigger);
        if (report.status !== "unchanged") console.error(JSON.stringify({ event: "oa_read_metadata_sync", trigger, status: report.status, impacted: report.impacted, errors: report.errors, failure: report.failure }));
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        if (!this.closed && report.failure?.retryable) {
          const delaySeconds = Math.min(30 * 2 ** Math.min(this.retryAttempt++, 5), this.config.syncIntervalSeconds);
          this.retryTimer = setTimeout(() => { void check('retry'); }, delaySeconds * 1000);
          this.retryTimer.unref();
        } else this.retryAttempt = 0;
      } catch {
        console.error('[oa-read] metadata sync failed; background checks will retry');
      }
    };
    this.starting = (async () => {
      await check("startup");
      if (this.closed) return;
      // Poll the database directly, regardless of how schema changes were made.
      this.timer = setInterval(() => { void check("scheduled"); }, this.config.syncIntervalSeconds * 1000);
      this.timer.unref();
    })();
    return this.starting;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.starting;
    await this.syncing?.catch(() => undefined);
    await this.db.close();
    if (this.syncDb !== this.db) await this.syncDb.close();
  }

  async call(raw: unknown, principal: Principal) {
    const result = await this.execute(raw, principal);
    if (!result.ok && raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string') {
      markReportReadFailure(raw.sessionId, result.error.code);
    }
    return result;
  }

  private async execute(raw: unknown, principal: Principal) {
    const started = performance.now();
    try {
      let input = inputSchema.parse(canonicalReadInput(raw));
      // Local atomic snapshot only. Never introspect information_schema on a chat request.
      const state = await readCatalogState(this.config.stateDirectory);
      const active = state?.active;
      if (!active) return failure("metadata_not_ready", "OA 查询元数据尚未发布，后台会自动同步，请稍后重试。");
      if (active.schema.database !== new URL(this.config.databaseUrl).pathname.slice(1)) return failure("metadata_database_mismatch", "发布的元数据与当前查询库不匹配，请重新同步。");
      if (state.report.status === "rejected") {
        const unavailable = state.report.failure?.kind === 'unavailable';
        return { ok: false as const, error: {
          code: unavailable ? 'metadata_sync_unavailable' : 'metadata_validation_failed',
          message: unavailable ? '后台元数据检查暂未完成，查询已暂停；这不表示已确认数据定义错误。后台会自动重试。'
            : '元数据验证未通过，查询已暂停，需修复定义后重新同步。',
          recovery: { action: 'stop_for_turn', retryAfterSeconds: state.report.failure?.retryable ? 30 : this.config.syncIntervalSeconds,
            instruction: '本轮停止数据库调用，说明已有结果与缺口；不要 sleep 轮询、重试 catalog 或换工具绕过。' },
        } };
      }
      const allowed = active.semantic.entities.filter(e => accessible(e, principal, active.schema));
      if (input.action === "catalog") {
        const terms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        return { ok: true as const, version: active.version, publishedAt: active.publishedAt, rules: active.semantic.rules, entities: allowed.filter(e => !terms.length || terms.some(t => `${e.name} ${e.description}`.toLowerCase().includes(t))).map(e => ({ name: e.name, description: e.description, scope: tableAccess(e.table, active.schema) })) };
      }
      if (input.action === "describe") {
        const requestedEntities = input.entities;
        if (input.entities.some(name => !allowed.some(e => e.name === name))) return failure("entity_forbidden", "实体未发布或当前用户无权访问。");
        const result = { ok: true as const, version: active.version, entities: allowed.filter(e => requestedEntities.includes(e.name)).map(e => ({
          ...e, access: tableAccess(e.table, active.schema), ownerColumn: undefined, references: e.references.filter(r => allowed.some(a => a.name === r.entity)),
          columns: Object.fromEntries(Object.entries(e.columns).map(([name, meaning]) => [name, { ...meaning, type: active.schema.tables.find(t => t.name === e.table)?.columns.find(c => c.name === name)?.type }])),
        })) };
        if (input.sessionId) {
          const previous = this.descriptions.get(input.sessionId);
          const identity = JSON.stringify(principal);
          const entities = new Map<string, Record<string, unknown>>();
          if (previous?.version === active.version && previous.principal === identity && Date.now() - previous.at < 10 * 60 * 1000) {
            for (const entity of previous.entities) entities.set(String(entity.name), entity);
          }
          for (const entity of result.entities) entities.set(entity.name, entity);
          this.descriptions.delete(input.sessionId);
          const bounded: Record<string, unknown>[] = [];
          let bytes = 0;
          for (const entity of [...entities.values()].reverse().slice(0, 10)) {
            bytes += Buffer.byteLength(JSON.stringify(entity));
            if (bytes > 24 * 1024) break;
            bounded.push(entity);
          }
          this.descriptions.set(input.sessionId, { version: active.version, principal: identity, at: Date.now(), entities: bounded });
          if (this.descriptions.size > 128) this.descriptions.delete(this.descriptions.keys().next().value!);
        }
        return result;
      }
      if (input.version !== active.version) return failure("metadata_version_changed", "元数据已更新，请重新 describe 后生成查询。");
      if (input.action === "self") {
        const result = await this.readCurrentUser(active, principal, started);
        return result;
      }
      const turnContext = reportTurnContext(input.sessionId);
      if (input.action === 'report') input = { ...input, report: prepareReportPlan(input.report, active, turnContext?.period) };
      if (input.action === 'batch' || input.action === 'report') {
        const reportPlan = input.action === 'report' ? input.report : undefined;
        const plans = input.action === 'batch' ? input.queries : [input.report.population.query, ...input.report.evidence.map(e => e.query)];
        // Validate the complete batch before reading any data, with one snapshot and principal.
        const compiledQueries = plans.map(plan => compileQuery(plan, active, principal, this.config.maxRows, Math.max(1, Math.floor(this.config.queryTimeoutMs / plans.length)), turnContext));
        if (input.action === 'report') {
          if (input.report.period && input.report.evidence.some(e => !e.query.period || e.query.period.start !== input.report.period!.start || e.query.period.end !== input.report.period!.end)) {
            return failure('invalid_report_period', '每个证据查询的 period 必须覆盖 report.period 声明的同一期间；不要先用有限周次筛掉跨界记录。');
          }
          for (const spec of [input.report.population, ...input.report.evidence]) {
            const required = [spec.key, ...('label' in spec ? [spec.label] : [spec.content])];
            if (required.some(alias => !spec.query.select.some(s => s.as === alias))) return failure('invalid_report', '对象标识、名称或内容必须引用 query.select 中的输出别名。');
            if (!spec.query.select.some(s => s.as === spec.key && s.field && !s.aggregate)) return failure('invalid_report', '对象标识必须引用未聚合的 select 字段，才能将证据限制在同一对象清单。');
          }
        }
        const cached = input.action === 'report' ? cachedReportRows(input.sessionId, input.report, active.version, JSON.stringify(principal)) : undefined;
        const results = cached?.results ?? await this.db.read(async query => {
          const values = [];
          let remainingBytes = input.action === 'batch' ? 128 * 1024 : 640 * 1024;
          for (const [index, original] of compiledQueries.entries()) {
            if (performance.now() - started > this.config.queryTimeoutMs) throw new Error('批量读取超时，请缩小范围。');
            let compiled = original;
            if (reportPlan && index > 0) {
              const spec = reportPlan.evidence[index - 1]!;
              const keys = values[0]!.rows.map(row => row[reportPlan.population.key]).filter((key): key is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof key));
              const field = spec.query.select.find(s => s.as === spec.key)!.field!;
              compiled = compileQuery(spec.query, active, principal, this.config.maxRows, Math.max(1, Math.floor(this.config.queryTimeoutMs / plans.length)), { ...turnContext, population: { field, keys } });
            }
            const rowBudget = reportPlan && index > 0 ? Math.min(512 * 1024, Math.floor(remainingBytes / (compiledQueries.length - index))) : Math.min(128 * 1024, remainingBytes);
            const result = boundRows(await query(compiled.sql, compiled.bindings), compiled, rowBudget);
            remainingBytes -= Buffer.byteLength(JSON.stringify(result));
            values.push(result);
          }
          return values;
        });
        const durationMs = Math.round(performance.now() - started);
        if (input.action === 'report') {
          if (!cached) cacheReportRows(input.sessionId, input.report, active.version, JSON.stringify(principal), results);
          const reportPlan = cached?.plan ?? input.report;
          const describeCondition = (condition: typeof reportPlan.population.query.where[number]) => {
            const [alias, column] = condition.field.split('.');
            const source = [reportPlan.population.query.from, ...reportPlan.population.query.joins].find(s => s.as === alias);
            const definition = active.semantic.entities.find(e => e.name === source?.entity)?.columns[column!];
            const meaning = (definition?.description ?? column!).split(/[；;。\n]/)[0]!.slice(0, 140);
            const values = (Array.isArray(condition.value) ? condition.value : [condition.value]).map(v => definition?.values?.[String(v)] ?? String(v ?? '空值')).join('、');
            const operator = { eq: '等于', ne: '排除', notIn: '排除', in: '包含', contains: '包含文字', isNull: '为空', isNotNull: '不为空', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于' }[condition.op];
            return `${meaning}：${operator}${values}${definition?.values && ['ne', 'notIn'].includes(condition.op) ? '（仅已登记类型）' : ''}`;
          };
          const scopeNotes = reportPlan.population.query.where.map(describeCondition);
          if (reportPlan.population.query.anyOf.length) scopeNotes.push(`满足以下任一条件：${reportPlan.population.query.anyOf.map(describeCondition).join(' 或 ')}`);
          const report = buildCoverageReport(reportPlan, results, scopeNotes);
          rememberReport(input.sessionId, report);
          return { ok: true as const, version: active.version, durationMs, report: reportForModel(report), cacheReused: !!cached,
            summary: '按对象返回有界来源片段。行完整性与正文片段分别标记；最终只需选择片段 ID。' };
        }
        return { ok: true as const, version: active.version, durationMs, results };
      }
      const compiled = compileQuery(input.query, active, principal, this.config.maxRows, this.config.queryTimeoutMs, turnContext);
      const rows = await this.db.read(q => q(compiled.sql, compiled.bindings));
      let hasMore = rows.length > compiled.limit;
      const result: unknown[] = [];
      let bytes = 0;
      for (const row of rows.slice(0, compiled.limit)) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > 128 * 1024) { hasMore = true; break; }
        bytes += size; result.push(row);
      }
      if (!result.length && rows.length) return failure("result_too_wide", "单行结果过大，请减少返回字段。");
      const durationMs = Math.round(performance.now() - started);
      console.error(JSON.stringify({ event: "oa_read_query", userId: principal.userId, version: active.version, entities: compiled.entities, durationMs, returned: result.length, hasMore }));
      return { ok: true as const, ...(compiled.id ? { id: compiled.id } : {}), version: active.version, durationMs, rows: result, returned: result.length, hasMore, nextOffset: hasMore ? compiled.offset + result.length : null, textLimit: 6000, coverage: hasMore ? "partial" : compiled.offset ? "last_page" : "complete" };
    } catch (e) {
      if (e instanceof z.ZodError) return invalidQuery(e);
      const code = (e as NodeJS.ErrnoException).code;
      if (code) {
        console.error(JSON.stringify({ event: "oa_read_query_failed", code, durationMs: Math.round(performance.now() - started) }));
        return failure("database_query_failed", "只读查询失败或超时，请缩小查询范围；若表或字段刚有变化，后台会在下一次检查时自动同步。");
      }
      return failure("query_rejected", e instanceof Error ? e.message : "查询被拒绝");
    }
  }

  private async readCurrentUser(active: PublishedMetadata, principal: Principal, started: number) {
    if (!/^[1-9]\d*$/.test(principal.userId)) {
      return failure("self_identity_unmappable", "当前 OA 用户 ID 不是成员表支持的数字 ID，未查询其他成员；请检查 OA 用户 ID 与成员主键的映射。");
    }

    const findEntity = (name: string) => active.semantic.entities.find(entity => entity.name === name);
    const member = findEntity("members");
    if (!member || !Object.hasOwn(member.columns, "id")) {
      return failure("self_profile_unavailable", "已发布的 OA 只读目录缺少本人资料所需的成员主键。");
    }
    const memberTable = active.schema.tables.find(table => table.name === member.table);
    const memberIdType = memberTable?.columns.find(column => column.name === "id")?.type;
    if (!memberIdType || !/^(?:tinyint|smallint|mediumint|int|integer|bigint)\b/i.test(memberIdType)) {
      return failure("self_profile_unavailable", "成员主键不是已验证支持的数字 ID，未执行本人资料查询。");
    }

    const select: Array<{ field: string; as: string }> = [];
    const addFields = (entity: NonNullable<ReturnType<typeof findEntity>>, alias: string, fields: Array<[string, string]>) => {
      for (const [column, output] of fields) {
        if (Object.hasOwn(entity.columns, column)) select.push({ field: `${alias}.${column}`, as: output });
      }
    };
    addFields(member, "m", [
      ["id", "id"], ["full_name", "full_name"], ["username", "username"],
      ["email", "email"], ["employee_title", "employee_title"],
      ["employee_type", "employee_type"], ["start_date", "start_date"],
    ]);

    const joins: Array<{ entity: string; as: string; type: "left"; on: { left: string; right: string } }> = [];
    const department = findEntity("department");
    if (department && Object.hasOwn(department.columns, "name") &&
        member.references.some(reference => reference.column === "department_id" && reference.entity === department.name && reference.targetColumn === "id")) {
      joins.push({ entity: department.name, as: "d", type: "left", on: { left: "m.department_id", right: "d.id" } });
      select.push({ field: "d.name", as: "department" });
    }

    const profile = findEntity("user_profile");
    if (profile && profile.references.some(reference => reference.column === "user_id" && reference.entity === member.name && reference.targetColumn === "id")) {
      joins.push({ entity: profile.name, as: "up", type: "left", on: { left: "m.id", right: "up.user_id" } });
      addFields(profile, "up", [
        ["title", "profile_title"], ["position", "position"], ["school", "school"],
        ["tech_stack", "tech_stack"], ["intro", "intro"], ["github_id", "github_id"],
      ]);
    }

    const compiled = compileQuery({
      from: { entity: member.name, as: "m" },
      joins,
      select,
      where: [{ field: "m.id", op: "eq", value: principal.userId }],
      limit: 2,
    }, active, principal, this.config.maxRows, this.config.queryTimeoutMs);
    const rows = await this.db.read(query => query(compiled.sql, compiled.bindings));
    if (!rows.length) return failure("self_profile_not_found", "已验证当前登录身份，但成员目录中没有匹配的成员记录。");
    if (rows.length > 1) return failure("self_profile_ambiguous", "成员主键匹配到多条本人资料记录，为避免返回错误资料，查询已停止。");

    return {
      ok: true as const,
      version: active.version,
      durationMs: Math.round(performance.now() - started),
      identitySource: "verified_current_session",
      profile: rows[0],
    };
  }
}

function boundRows(rows: Record<string, unknown>[], compiled: { id?: string; limit: number; offset: number }, maxBytes: number) {
  const result: Record<string, unknown>[] = [];
  let bytes = 0;
  let hasMore = rows.length > compiled.limit;
  for (const row of rows.slice(0, compiled.limit)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > maxBytes) { hasMore = true; break; }
    result.push(row); bytes += size;
  }
  if (!result.length && rows.length) throw new Error('单行结果过大，请减少字段或 textLength。');
  return { ...(compiled.id ? { id: compiled.id } : {}), rows: result, returned: result.length, hasMore, nextOffset: hasMore ? compiled.offset + result.length : null,
    coverage: hasMore ? 'partial' : compiled.offset ? 'last_page' : 'complete' };
}

function failure(code: string, message: string) { return { ok: false as const, error: { code, message } }; }
const instances = new Map<string, OaReadService>();
export function getOaReadService(config: OaReadConfig): OaReadService {
  const key = JSON.stringify(config);
  let service = instances.get(key);
  if (!service) { service = new OaReadService(config); instances.set(key, service); }
  return service;
}
