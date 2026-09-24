import type { SchemaSnapshot } from "./metadata.js";

// Physical table names, never model-facing aliases. Denial takes precedence.
export const DENIED_TABLES = new Set([
  "enterprise_wechat_mcp_token_state", "enterprise_wechat_mcp_user_map", "oa_mcp_grants",
  "ws_chat_messages", "ws_chat_turns", "ws_task_confirmations", "ws_task_entries",
  "ws_task_events", "ws_task_members", "async_task", "async_task_run",
]);
export const ADMIN_TABLES = new Set(["user_weekly_salary", "ai_reports", "file_storage"]);
export type TableAccess = "authenticated" | "admin" | "denied";

export const TABLE_ACCESS_RULES = [
  "权限按物理表判断：全员禁读优先，其次管理员专用，其余表所有已登录成员可跨成员查询；没有仅本人过滤。",
  `所有人（含管理员）禁读：${[...DENIED_TABLES].join("、")}。`,
  `仅经 OA 验证的管理员可读：${[...ADMIN_TABLES].join("、")}。`,
  "新表与新字段在后台同步验证后按同一策略发布；密码、Token 等凭据字段仍不公开。",
];

export function tableAccess(tableName: string, schema: SchemaSnapshot, visiting = new Set<string>()): TableAccess {
  const name = tableName.toLowerCase();
  if (DENIED_TABLES.has(name) || visiting.has(name)) return "denied";
  const table = schema.tables.find(t => t.name.toLowerCase() === name);
  if (!table) return "denied";
  let access: TableAccess = ADMIN_TABLES.has(name) ? "admin" : "authenticated";
  if (table.kind === "VIEW") {
    // Do not let a renamed or nested view bypass restrictions on its sources.
    // Unknown/cross-database dependencies cannot be authorized by this catalog.
    if (!table.viewDefinition || !table.dependencies.length) return "denied";
    const next = new Set(visiting).add(name);
    for (const dependency of table.dependencies) {
      const source = tableAccess(dependency, schema, next);
      if (source === "denied") return "denied";
      if (source === "admin") access = "admin";
    }
  }
  return access;
}
