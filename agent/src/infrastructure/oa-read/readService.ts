import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OaReadConfig } from "../../config/oaReadConfig.js";
import { ReadDatabase } from "./database.js";
import { accessible, type Principal } from "./metadata.js";
import { compileQuery } from "./queryCompiler.js";
import { readCatalogState, synchronizeMetadata } from "./schemaSync.js";
import { tableAccess } from "./accessPolicy.js";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("catalog"), sessionId: z.string().optional(), search: z.string().max(100).optional() }).strict(),
  z.object({ action: z.literal("describe"), sessionId: z.string().optional(), entities: z.array(z.string()).min(1).max(10) }).strict(),
  z.object({ action: z.literal("query"), sessionId: z.string().optional(), version: z.string(), query: z.unknown() }).strict(),
]);
// The legacy OA tool token is given to the model process. It must NOT be the
// signing key for capabilities that authorize access to other sessions.
const capabilitySecret = randomBytes(32);
export const readToolToken = (secret: string, sessionId: string) => createHmac("sha256", capabilitySecret).update(secret).update(`\0oa-read:${sessionId}`).digest("hex");

export class OaReadService {
  private timer?: NodeJS.Timeout;
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
        if (report.status !== "unchanged") console.error(JSON.stringify({ event: "oa_read_metadata_sync", trigger, status: report.status, impacted: report.impacted, errors: report.errors }));
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
    await this.starting;
    await this.syncing?.catch(() => undefined);
    await this.db.close();
    if (this.syncDb !== this.db) await this.syncDb.close();
  }

  async call(raw: unknown, principal: Principal) {
    const started = performance.now();
    try {
      const input = inputSchema.parse(raw);
      // Local atomic snapshot only. Never introspect information_schema on a chat request.
      const state = await readCatalogState(this.config.stateDirectory);
      const active = state?.active;
      if (!active) return failure("metadata_not_ready", "OA 查询元数据尚未发布，后台会自动同步，请稍后重试。");
      if (active.schema.database !== new URL(this.config.databaseUrl).pathname.slice(1)) return failure("metadata_database_mismatch", "发布的元数据与当前查询库不匹配，请重新同步。");
      if (state.report.status === "rejected") return failure("metadata_validation_failed", "结构或语义定义发生变化且验证未通过，OA 查询已暂停，需修复元数据后重新同步。");
      const allowed = active.semantic.entities.filter(e => accessible(e, principal, active.schema));
      if (input.action === "catalog") {
        const terms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        return { ok: true, version: active.version, publishedAt: active.publishedAt, rules: active.semantic.rules, entities: allowed.filter(e => !terms.length || terms.some(t => `${e.name} ${e.description}`.toLowerCase().includes(t))).map(e => ({ name: e.name, description: e.description, scope: tableAccess(e.table, active.schema) })) };
      }
      if (input.action === "describe") {
        if (input.entities.some(name => !allowed.some(e => e.name === name))) return failure("entity_forbidden", "实体未发布或当前用户无权访问。");
        return { ok: true, version: active.version, entities: allowed.filter(e => input.entities.includes(e.name)).map(e => ({
          ...e, access: tableAccess(e.table, active.schema), ownerColumn: undefined, references: e.references.filter(r => allowed.some(a => a.name === r.entity)),
          columns: Object.fromEntries(Object.entries(e.columns).map(([name, meaning]) => [name, { ...meaning, type: active.schema.tables.find(t => t.name === e.table)?.columns.find(c => c.name === name)?.type }])),
        })) };
      }
      if (input.version !== active.version) return failure("metadata_version_changed", "元数据已更新，请重新 describe 后生成查询。");
      const compiled = compileQuery(input.query, active, principal, this.config.maxRows, this.config.queryTimeoutMs);
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
      return { ok: true, version: active.version, durationMs, rows: result, returned: result.length, hasMore, nextOffset: hasMore ? compiled.offset + result.length : null, textLimit: 6000, coverage: hasMore ? "partial" : compiled.offset ? "last_page" : "complete" };
    } catch (e) {
      if (e instanceof z.ZodError) return failure("invalid_query", "查询参数不符合结构化查询规范。");
      const code = (e as NodeJS.ErrnoException).code;
      if (code) {
        console.error(JSON.stringify({ event: "oa_read_query_failed", code, durationMs: Math.round(performance.now() - started) }));
        return failure("database_query_failed", "只读查询失败或超时，请缩小查询范围；若表或字段刚有变化，后台会在下一次检查时自动同步。");
      }
      return failure("query_rejected", e instanceof Error ? e.message : "查询被拒绝");
    }
  }
}

function failure(code: string, message: string) { return { ok: false, error: { code, message } }; }
const instances = new Map<string, OaReadService>();
export function getOaReadService(config: OaReadConfig): OaReadService {
  const key = JSON.stringify(config);
  let service = instances.get(key);
  if (!service) { service = new OaReadService(config); instances.set(key, service); }
  return service;
}
