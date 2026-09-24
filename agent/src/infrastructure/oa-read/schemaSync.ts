import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { OaReadConfig } from "../../config/oaReadConfig.js";
import { ReadDatabase, quoteIdentifier, type ReadQuery } from "./database.js";
import { diffSchema, hash, impactedEntities, materializeMetadata, parseMetadata, validateReferences, type PublishedMetadata, type SchemaSnapshot, type Change } from "./metadata.js";
import { tableAccess } from "./accessPolicy.js";

export type SyncReport = {
  status: "published" | "unchanged" | "rejected";
  checkedAt: string;
  trigger: string;
  candidateVersion: string;
  activeVersion: string | null;
  changes: Change[];
  impacted: string[];
  errors: string[];
};
export type CatalogState = { active: PublishedMetadata | null; report: SyncReport };

export async function inspectSchema(query: ReadQuery, database: string): Promise<SchemaSnapshot> {
  const tables = await query("SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
  const columns = await query("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, EXTRA, ORDINAL_POSITION, COLLATION_NAME, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [database]);
  const indexes = await query("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, INDEX_TYPE, IS_VISIBLE, EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX", [database]);
  const foreignKeys = await query("SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION", [database]);
  const views = await query("SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
  const usage = await query("SELECT VIEW_NAME, TABLE_NAME, TABLE_SCHEMA FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA = ? ORDER BY VIEW_NAME,TABLE_SCHEMA,TABLE_NAME", [database]);
  return { database, tables: tables.map(t => ({
    name: t.TABLE_NAME, kind: t.TABLE_TYPE, comment: t.TABLE_COMMENT,
    columns: columns.filter(c => c.TABLE_NAME === t.TABLE_NAME).map(c => ({ name: c.COLUMN_NAME, type: c.COLUMN_TYPE, nullable: c.IS_NULLABLE, defaultValue: c.COLUMN_DEFAULT, comment: c.COLUMN_COMMENT, extra: c.EXTRA, ordinal: c.ORDINAL_POSITION, collation: c.COLLATION_NAME, generation: c.GENERATION_EXPRESSION })),
    indexes: indexes.filter(i => i.TABLE_NAME === t.TABLE_NAME),
    foreignKeys: foreignKeys.filter(k => k.TABLE_NAME === t.TABLE_NAME),
    viewDefinition: views.find(v => v.TABLE_NAME === t.TABLE_NAME)?.VIEW_DEFINITION ?? null,
    dependencies: usage.filter(v => v.VIEW_NAME === t.TABLE_NAME).map(v => v.TABLE_SCHEMA === database ? v.TABLE_NAME : `${v.TABLE_SCHEMA}.${v.TABLE_NAME}`),
  })) };
}

export async function readCatalogState(directory: string): Promise<CatalogState | null> {
  try { return JSON.parse(await readFile(path.join(directory, "current.json"), "utf8")) as CatalogState; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

async function atomicJson(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}

// Single writer across background polling and optional manual refreshes.
export async function synchronizeMetadata(config: OaReadConfig, db: Pick<ReadDatabase, "read">, trigger: string): Promise<SyncReport> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(config.stateDirectory, "sync.lock");
  // Never steal a lock: stale detection + deletion has a cross-process TOCTOU
  // race. Crash leftovers require an operator to confirm the recorded owner is dead.
  try { await mkdir(lock); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("metadata_sync_busy");
    throw e;
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ host: os.hostname(), pid: process.pid }), { mode: 0o600 });
    const previous = await readCatalogState(config.stateDirectory);
    const definitions = parseMetadata(JSON.parse(await readFile(config.metadataPath, "utf8")));
    const database = new URL(config.databaseUrl).pathname.slice(1);
    const schema = await db.read(q => inspectSchema(q, database));
    const semantic = materializeMetadata(schema, definitions);
    const version = hash({ schema, semantic });
    const changes = diffSchema(previous?.active?.schema ?? null, schema);
    const impacted = [...new Set([
      ...impactedEntities(changes, schema, semantic),
      ...(previous?.active ? impactedEntities(changes, previous.active.schema, previous.active.semantic) : []),
    ])];
    const errors = validateReferences(schema, semantic);
    // Widening varchar preserves its meaning. Other type/comment changes need
    // acknowledgement in the semantic definition before queries can use them.
    for (const change of changes.filter(c => c.kind === "changed" && c.aspect === "column")) {
      const oldColumn = previous?.active?.schema.tables.find(t => t.name === change.table)?.columns.find(c => c.name === change.field);
      const newColumn = schema.tables.find(t => t.name === change.table)?.columns.find(c => c.name === change.field);
      const oldVarchar = /^varchar\((\d+)\)$/i.exec(oldColumn?.type ?? "");
      const newVarchar = /^varchar\((\d+)\)$/i.exec(newColumn?.type ?? "");
      const compatibleType = oldColumn?.type === newColumn?.type ||
        (oldVarchar && newVarchar && Number(newVarchar[1]) >= Number(oldVarchar[1]));
      if (compatibleType && oldColumn?.comment === newColumn?.comment &&
          oldColumn?.collation === newColumn?.collation && oldColumn?.generation === newColumn?.generation) continue;
      for (const entity of semantic.entities.filter(e => e.table === change.table && e.columns[change.field!])) {
        const old = previous?.active?.semantic.entities.find(e => e.name === entity.name)?.columns[change.field!];
        if (old && hash(old) === hash(entity.columns[change.field!])) errors.push(`${entity.name}.${change.field}: 类型、注释或取值规则变化，请复核并更新字段语义定义`);
      }
    }
    if (!errors.length) {
      await db.read(async query => {
        for (const entity of semantic.entities) {
          try { await query(`SELECT ${Object.keys(entity.columns).map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(entity.table)} LIMIT 0`); }
          catch { errors.push(`${entity.name}: 业务视图/字段不可查询`); }
        }
        for (const view of schema.tables.filter(t => t.kind === "VIEW" && tableAccess(t.name, schema) !== "denied")) {
          try { await query(`SELECT * FROM ${quoteIdentifier(view.name)} LIMIT 0`); }
          catch { errors.push(`${view.name}: 数据库视图不可查询`); }
        }
      });
      const after = await db.read(q => inspectSchema(q, database));
      if (hash(after) !== hash(schema)) errors.push("同步期间结构再次变化，下一次后台检查将自动重试");
    }
    const report: SyncReport = {
      status: errors.length ? "rejected" : previous?.active?.version === version ? "unchanged" : "published",
      checkedAt: new Date().toISOString(), trigger, candidateVersion: version,
      activeVersion: errors.length ? previous?.active?.version ?? null : version,
      changes, impacted, errors,
    };
    const candidate: PublishedMetadata = previous?.active?.version === version ? previous.active : { version, publishedAt: report.checkedAt, schema, semantic };
    await mkdir(path.join(config.stateDirectory, "versions"), { recursive: true, mode: 0o700 });
    // Published versions are immutable; rejected candidates are separate from published artifacts.
    const artifact = path.join(config.stateDirectory, "versions", `${version}${errors.length ? ".rejected" : ""}.json`);
    try { await writeFile(artifact, JSON.stringify({ candidate, report }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await atomicJson(path.join(config.stateDirectory, "current.json"), { active: errors.length ? previous?.active ?? null : candidate, report } satisfies CatalogState);
    return report;
  } catch {
    const previous = await readCatalogState(config.stateDirectory);
    const report: SyncReport = {
      status: "rejected", checkedAt: new Date().toISOString(), trigger,
      candidateVersion: "unavailable", activeVersion: previous?.active?.version ?? null,
      changes: [], impacted: previous?.active?.semantic.entities.map(e => e.name) ?? [],
      errors: ["结构同步失败：连接、元数据格式或结构读取不可用；保留旧版本并暂停查询。"],
    };
    await atomicJson(path.join(config.stateDirectory, "current.json"), { active: previous?.active ?? null, report } satisfies CatalogState);
    return report;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
