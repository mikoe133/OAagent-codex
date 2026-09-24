import { createHash } from "node:crypto";
import { z } from "zod";
import { DENIED_TABLES, tableAccess, TABLE_ACCESS_RULES } from "./accessPolicy.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64);
export const semanticSchema = z.object({
  format: z.literal(1),
  description: z.string(),
  rules: z.array(z.string()),
  entities: z.array(z.object({
    name: identifier,
    table: identifier,
    description: z.string(),
    access: z.enum(["authenticated", "self", "admin"]),
    ownerColumn: identifier.optional(),
    columns: z.record(identifier, z.object({ description: z.string(), values: z.record(z.string()).optional() }).strict()),
    filters: z.array(z.object({ column: identifier, value: z.union([z.string(), z.number(), z.boolean()]) }).strict()).default([]),
    references: z.array(z.object({ column: identifier, entity: identifier, targetColumn: identifier }).strict()).default([]),
  }).strict()).max(500),
}).strict();
export type SemanticMetadata = z.infer<typeof semanticSchema>;
export type Entity = SemanticMetadata["entities"][number];
export type Principal = { userId: string; isAdmin: boolean };
export type Column = { name: string; type: string; nullable: string; defaultValue: unknown; comment: string; extra: string; ordinal: number; collation: string | null; generation: string };
export type SchemaTable = { name: string; kind: string; comment: string; columns: Column[]; indexes: Record<string, unknown>[]; foreignKeys: Record<string, unknown>[]; viewDefinition: string | null; dependencies: string[] };
export type SchemaSnapshot = { database: string; tables: SchemaTable[] };
export type Change = { table: string; field?: string; kind: "added" | "removed" | "changed"; aspect: "table" | "column" | "indexes" | "foreignKeys" | "view" };
export type PublishedMetadata = { version: string; publishedAt: string; schema: SchemaSnapshot; semantic: SemanticMetadata };
export const sensitiveColumn = /password|passwd|secret|token|private_key|credential|sessionid|session_key|claim_token/i;
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseMetadata(value: unknown): SemanticMetadata {
  const metadata = semanticSchema.parse(value);
  const names = new Set<string>();
  for (const entity of metadata.entities) {
    if (names.has(entity.name)) throw new Error(`重复实体: ${entity.name}`);
    names.add(entity.name);
    if (!Object.keys(entity.columns).length) throw new Error(`实体没有字段: ${entity.name}`);
    if (entity.access === "self" && (!entity.ownerColumn || !entity.columns[entity.ownerColumn])) throw new Error(`缺少行权限字段: ${entity.name}`);
    for (const column of Object.keys(entity.columns)) if (sensitiveColumn.test(column)) throw new Error(`禁止公开凭据字段: ${entity.name}.${column}`);
  }
  return metadata;
}

export function diffSchema(previous: SchemaSnapshot | null, next: SchemaSnapshot): Change[] {
  const changes: Change[] = [];
  const old = new Map(previous?.tables.map(t => [t.name, t]) ?? []);
  for (const table of next.tables) {
    const before = old.get(table.name); old.delete(table.name);
    if (!before) { changes.push({ table: table.name, kind: "added", aspect: "table" }); continue; }
    if (before.kind !== table.kind || before.comment !== table.comment) changes.push({ table: table.name, kind: "changed", aspect: "table" });
    const columns = new Map(before.columns.map(c => [c.name, c]));
    for (const column of table.columns) {
      const previousColumn = columns.get(column.name); columns.delete(column.name);
      if (!previousColumn || hash(previousColumn) !== hash(column)) changes.push({ table: table.name, field: column.name, kind: previousColumn ? "changed" : "added", aspect: "column" });
    }
    for (const column of columns.keys()) changes.push({ table: table.name, field: column, kind: "removed", aspect: "column" });
    for (const aspect of ["indexes", "foreignKeys"] as const) if (hash(before[aspect]) !== hash(table[aspect])) changes.push({ table: table.name, kind: "changed", aspect });
    if (before.viewDefinition !== table.viewDefinition || hash(before.dependencies) !== hash(table.dependencies)) changes.push({ table: table.name, kind: "changed", aspect: "view" });
  }
  for (const table of old.keys()) changes.push({ table, kind: "removed", aspect: "table" });
  return changes;
}

export function impactedEntities(changes: Change[], schema: SchemaSnapshot, metadata: SemanticMetadata): string[] {
  const affectedTables = new Set(changes.map(c => c.table));
  for (let i = 0; i < schema.tables.length; i++) {
    let grew = false;
    for (const table of schema.tables) if (!affectedTables.has(table.name) && table.dependencies.some(d => affectedTables.has(d))) { affectedTables.add(table.name); grew = true; }
    if (!grew) break;
  }
  const affected = new Set(metadata.entities.filter(entity => {
    if (!affectedTables.has(entity.table)) return false;
    const direct = changes.filter(c => c.table === entity.table);
    return !direct.length || direct.some(c => !c.field || !!entity.columns[c.field!] || entity.ownerColumn === c.field || entity.filters.some(f => f.column === c.field));
  }).map(e => e.name));
  for (let i = 0; i < metadata.entities.length; i++) {
    let grew = false;
    for (const entity of metadata.entities) if (!affected.has(entity.name) && entity.references.some(r => affected.has(r.entity))) {
      affected.add(entity.name); grew = true;
    }
    if (!grew) break;
  }
  return [...affected];
}

export function validateReferences(schema: SchemaSnapshot, metadata: SemanticMetadata): string[] {
  const errors: string[] = [];
  for (const entity of metadata.entities) {
    const table = schema.tables.find(t => t.name === entity.table);
    if (!table) { errors.push(`${entity.name}: 表不存在 ${entity.table}`); continue; }
    const required = new Set([...Object.keys(entity.columns), ...entity.filters.map(f => f.column), ...(entity.ownerColumn ? [entity.ownerColumn] : [])]);
    for (const column of required) if (!table.columns.some(c => c.name === column)) errors.push(`${entity.name}: 字段不存在 ${column}`);
    for (const ref of entity.references) {
      const target = metadata.entities.find(e => e.name === ref.entity);
      if (!entity.columns[ref.column] || !target?.columns[ref.targetColumn]) errors.push(`${entity.name}: 关联字段不存在 ${ref.column} -> ${ref.entity}.${ref.targetColumn}`);
    }
  }
  return errors;
}

export function accessible(entity: Entity, principal: Principal, schema: SchemaSnapshot): boolean {
  const access = tableAccess(entity.table, schema);
  return access !== "denied" && (access !== "admin" || principal.isAdmin);
}

// The manifest supplies business meaning; the database supplies physical fields;
// the server policy supplies access. A stale manifest cannot relax a denial.
export function materializeMetadata(schema: SchemaSnapshot, definitions: SemanticMetadata): SemanticMetadata {
  const entities: Entity[] = [];
  const named = new Set(definitions.entities.map(e => e.name));
  const add = (entity: Entity) => {
    const access = tableAccess(entity.table, schema);
    if (access === "denied") return;
    const table = schema.tables.find(t => t.name === entity.table);
    const { ownerColumn: _owner, ...copy } = entity;
    const columns = { ...copy.columns };
    for (const column of table?.columns ?? []) {
      if (!sensitiveColumn.test(column.name) && !Object.hasOwn(columns, column.name)) {
        columns[column.name] = { description: column.comment
          ? `数据库注释：${column.comment}；未另行定义的枚举、JSON结构和业务口径不得推测。`
          : `${column.name}；业务含义未标注，不得推测枚举或JSON结构。` };
      }
    }
    if (Object.keys(columns).length) entities.push({ ...copy, columns, access, references: [...copy.references] });
  };
  for (const entity of definitions.entities) {
    if (DENIED_TABLES.has(entity.table.toLowerCase())) continue;
    // Preserve missing configured tables so validation reports broken references.
    if (!schema.tables.some(t => t.name === entity.table)) {
      entities.push(entity);
    } else add(entity);
  }
  for (const table of schema.tables) {
    if (definitions.entities.some(e => e.table === table.name)) continue;
    let name = table.name;
    if (named.has(name)) name = `table_${hash(table.name).slice(0, 16)}`;
    named.add(name);
    add({ name, table: table.name, description: table.comment || `${table.name} 业务记录`, access: "authenticated", columns: {}, filters: [], references: [] });
  }
  const byTable = new Map(entities.map(e => [e.table, e]));
  for (const entity of entities) {
    entity.references = entity.references.filter(r => entities.some(e => e.name === r.entity));
    const keys = schema.tables.find(t => t.name === entity.table)?.foreignKeys ?? [];
    for (const key of keys) {
      // Multi-column keys need an explicit query relation, not a partial join.
      if (keys.filter(k => k.CONSTRAINT_NAME === key.CONSTRAINT_NAME).length !== 1 || key.REFERENCED_TABLE_SCHEMA !== schema.database) continue;
      const target = byTable.get(String(key.REFERENCED_TABLE_NAME));
      const column = String(key.COLUMN_NAME), targetColumn = String(key.REFERENCED_COLUMN_NAME);
      if (!target || !Object.hasOwn(entity.columns, column) || !Object.hasOwn(target.columns, targetColumn)) continue;
      if (!entity.references.some(r => r.column === column && r.entity === target.name && r.targetColumn === targetColumn)) {
        entity.references.push({ column, entity: target.name, targetColumn });
      }
    }
  }
  return parseMetadata({ ...definitions, rules: [...definitions.rules, ...TABLE_ACCESS_RULES], entities });
}
