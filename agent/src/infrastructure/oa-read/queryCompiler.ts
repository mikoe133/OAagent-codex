import { z } from "zod";
import { accessible, type Entity, type Principal, type PublishedMetadata } from "./metadata.js";
import { quoteIdentifier as qi, type SqlValue } from "./database.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64);
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/).max(129);
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const condition = z.object({ field, op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "contains", "isNull", "isNotNull"]), value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional() }).strict();
const source = z.object({ entity: identifier, as: identifier }).strict();
export const querySchema = z.object({
  from: source,
  joins: z.array(source.extend({ type: z.enum(["inner", "left"]).default("inner"), on: z.object({ left: field, right: field }).strict() }).strict()).max(5).default([]),
  select: z.array(z.object({ field: field.optional(), aggregate: z.enum(["count", "countDistinct", "sum", "avg", "min", "max"]).optional(), as: identifier, textOffset: z.number().int().min(0).max(10000000).optional(), textLength: z.number().int().min(1).max(6000).optional() }).strict()).min(1).max(30),
  where: z.array(condition).max(30).default([]),
  anyOf: z.array(condition).max(15).default([]),
  groupBy: z.array(field).max(10).default([]),
  orderBy: z.array(z.object({ field: z.union([field, identifier]), direction: z.enum(["asc", "desc"]).default("asc") }).strict()).max(5).default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).max(10000).default(0),
}).strict();
export type QueryPlan = z.input<typeof querySchema>;

export function compileQuery(raw: unknown, metadata: PublishedMetadata, principal: Principal, maxRows: number, timeoutMs: number) {
  const plan = querySchema.parse(raw);
  const bindings: SqlValue[] = [];
  const aliases = new Map<string, Entity>();
  for (const src of [plan.from, ...plan.joins]) {
    if (aliases.has(src.as)) throw new Error("重复数据源别名");
    const entity = metadata.semantic.entities.find(e => e.name === src.entity);
    if (!entity || !accessible(entity, principal, metadata.schema)) throw new Error(`实体不可访问: ${src.entity}`);
    aliases.set(src.as, entity);
  }
  const ref = (name: string) => {
    const [alias, column] = name.split(".") as [string, string];
    const entity = aliases.get(alias);
    if (!entity || !Object.hasOwn(entity.columns, column)) throw new Error(`字段不可访问: ${name}`);
    return { alias, column, entity, sql: `${qi(alias)}.${qi(column)}` };
  };
  const readSource = (src: { entity: string; as: string }) => {
    const entity = aliases.get(src.as)!;
    const clauses = entity.filters.map(f => { bindings.push(f.value); return `${qi(f.column)} = ?`; });
    return `(SELECT ${Object.keys(entity.columns).map(qi).join(", ")} FROM ${qi(entity.table)}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}) AS ${qi(src.as)}`;
  };
  const selectionNames = new Set<string>();
  const selection = plan.select.map(s => {
    if (selectionNames.has(s.as)) throw new Error("重复返回字段名");
    selectionNames.add(s.as);
    let expression: string;
    if (s.aggregate) {
      if (!s.field && s.aggregate !== "count") throw new Error("聚合缺少字段");
      const f = s.field ? ref(s.field).sql : "*";
      expression = s.aggregate === "countDistinct" ? `COUNT(DISTINCT ${f})` : `${s.aggregate.toUpperCase()}(${f})`;
    } else {
      if (!s.field) throw new Error("查询缺少字段");
      if (plan.select.some(v => v.aggregate) && !plan.groupBy.includes(s.field)) throw new Error("非聚合字段必须列入 groupBy");
      expression = ref(s.field).sql;
    }
    // Bound large text/JSON in SQL before materializing the result in the process.
    if (s.field && (!s.aggregate || s.aggregate === "min" || s.aggregate === "max")) {
      const f = ref(s.field);
      const type = metadata.schema.tables.find(t => t.name === f.entity.table)?.columns.find(c => c.name === f.column)?.type;
      if (type && /char|text|json|blob|binary/i.test(type)) expression = `SUBSTRING(CAST(${expression} AS CHAR), ${(s.textOffset ?? 0) + 1}, ${s.textLength ?? 6000})`;
    }
    return `${expression} AS ${qi(s.as)}`;
  });
  let from = readSource(plan.from);
  const joined = new Set([plan.from.as]);
  for (const join of plan.joins) {
    const left = ref(join.on.left), right = ref(join.on.right);
    if (!((joined.has(left.alias) && right.alias === join.as) || (joined.has(right.alias) && left.alias === join.as))) throw new Error("关联必须连接已声明数据源与当前数据源");
    const relation = (a: typeof left, b: typeof right) => a.entity.references.some(r => r.column === a.column && r.entity === b.entity.name && r.targetColumn === b.column);
    if (!relation(left, right) && !relation(right, left)) throw new Error("关联关系未在语义元数据中声明");
    from += ` ${join.type.toUpperCase()} JOIN ${readSource(join)} ON ${left.sql} = ${right.sql}`;
    joined.add(join.as);
  }
  const compileCondition = (c: z.infer<typeof condition>) => {
    const f = ref(c.field).sql;
    if (c.op === "isNull" || c.op === "isNotNull") return `${f} IS ${c.op === "isNotNull" ? "NOT " : ""}NULL`;
    if (c.value === undefined || c.value === null) throw new Error("筛选值缺失；空值请使用 isNull/isNotNull");
    if (c.op === "in" || c.op === "notIn") {
      if (!Array.isArray(c.value) || c.value.some(v => v === null)) throw new Error("in/notIn 需要非空值数组");
      bindings.push(...c.value); return `${f} ${c.op === "notIn" ? "NOT " : ""}IN (${c.value.map(() => "?").join(", ")})`;
    }
    if (Array.isArray(c.value)) throw new Error("该筛选不接受数组");
    if (c.op === "contains") {
      if (typeof c.value !== "string") throw new Error("contains 需要字符串");
      bindings.push(`%${c.value.replace(/[!%_]/g, m => `!${m}`)}%`); return `${f} LIKE ? ESCAPE '!'`;
    }
    bindings.push(c.value);
    const operators = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    return `${f} ${operators[c.op]} ?`;
  };
  const clauses = plan.where.map(compileCondition);
  if (plan.anyOf.length) clauses.push(`(${plan.anyOf.map(compileCondition).join(" OR ")})`);
  const limit = Math.min(plan.limit, maxRows);
  let sql = `SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ ${selection.join(", ")} FROM ${from}`;
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  if (plan.groupBy.length) sql += ` GROUP BY ${plan.groupBy.map(f => ref(f).sql).join(", ")}`;
  if (plan.orderBy.length) sql += ` ORDER BY ${plan.orderBy.map(o => `${selectionNames.has(o.field) ? qi(o.field) : ref(o.field).sql} ${o.direction.toUpperCase()}`).join(", ")}`;
  else if (plan.offset) throw new Error("分页必须指定稳定排序（包含唯一 ID）");
  sql += ` LIMIT ${limit + 1} OFFSET ${plan.offset}`;
  return { sql, bindings, limit, offset: plan.offset, entities: [...aliases.values()].map(e => e.name) };
}
