import type { OpenApiOperationIndex, OpenApiOperationIndexEntry } from "../oa/openApiIndex.js";
import { isOaReadOperation } from "../oa/oaApiTool.js";

export function withDatabaseReadRouting(index: OpenApiOperationIndex): OpenApiOperationIndex {
  const database: OpenApiOperationIndexEntry = {
    catalog: "oa", operationId: "oa_database_read", method: "GET", path: "/oa-database/read",
    summary: "OA 只读数据库：查询、搜索、统计、汇总、关联分析员工/实习成员/部门/项目进展/周报/月报/任务/议题/公告/资产/考勤/状态/资料；使用语义元数据，不是 HTTP API",
    tags: ["oa", "database", "user", "projects", "weekly", "report", "查询", "统计"],
    permissionLevel: "user", parameters: [], requestBodyFields: [], mainResponseFields: ["version", "rows", "hasMore"],
  };
  return { ...index, operations: [...index.operations.filter(op => op.catalog !== "oa" || !isOaReadOperation(op.method, op.operationId, op.path, op.summary)), database] };
}

export function databaseReadGuidance(sessionArg: string): string {
  return [
    "- OA 数据读取模式：database。所有 OA 只读/查询/统计/搜索/报表任务（含写操作前定位和写后核验）统一使用只读数据库工具；不要查 OA 业务 GET 接口或为查询探索 OpenAPI。",
    "- 数据库连接凭据仅在服务端；禁止读取 .env、直接执行 mysql、任意 SQL、扫描 information_schema 或从文件读取完整结构快照。",
    "- 先调用一次目录，再按问题选择相关实体 describe；随后尽量用一次关联/聚合查询完成。权限或元数据不支持时明确说明缺失能力，不绕过或回退业务 API。",
    "- 表权限：全员禁读表对管理员同样禁读；薪资、AI报告和文件存储仅管理员可读；其余已发布表允许已登录用户跨成员查询，没有默认的仅本人过滤。全公司成员/项目统计使用 members 关联，不要沿用旧对话的本人范围限制。确有受限实体或数据缺失时说明具体缺口。",
    "- 命令：node scripts/queryOaDatabase.mjs --input '<JSON>'。session 由工具环境自动绑定。",
    '- 目录参数：{"action":"catalog"}；可加 search（空格分隔关键词，未命中可查看不带 search 的目录）。',
    '- 实体定义：{"action":"describe","entities":["members","projects","project_participants","project_github_commit_summaries"]}。以实际 catalog 为准。',
    '- 查询参数：{"action":"query","version":"describe 返回的 version","query":{"from":{"entity":"projects","as":"p"},"select":[{"field":"p.id","as":"id"},{"field":"p.project_name","as":"name"}],"where":[{"field":"p.project_name","op":"contains","value":"关键词"}],"orderBy":[{"field":"p.id","direction":"asc"}],"limit":100}}',
    '- query 仅接受结构化 JSON：from；joins（最多5个，{entity,as,type:"inner"|"left",on:{left:"别名.字段",right:"别名.字段"}}，只能使用 describe 的 references）；select（{field,as} 或 {field?,aggregate:"count"|"countDistinct"|"sum"|"avg"|"min"|"max",as}）；where（AND）；anyOf（OR，与 where 整体 AND）；groupBy（字段数组）；orderBy（字段或输出别名及 asc/desc）；limit；offset。',
    '- 条件格式 {field:"别名.字段",op:"eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"in"|"notIn"|"contains"|"isNull"|"isNotNull",value:标量或in数组}。字段只可引用已 describe 的元数据；禁止原始 SQL、函数、子查询字符串。',
    '- 统计在数据库做 count/groupBy；查询需要分页时按稳定唯一字段排序并使用 nextOffset；hasMore=false 才结束。聚合跨关联需考虑一对多重复，用 countDistinct 或拆为少量查询。',
    '- 日期范围用 >= 当月1日、< 次月1日；时区 Asia/Shanghai。不能用项目最新 updated_at 替代期间进展，不能用当前归档状态排除历史活动。',
    '- employee_type 等枚举遵循语义定义，缺失/未知身份不得视为非实习。历史身份/历史成员关系不存在时说明采用当前口径。textLimit 表示长文本可能截断，不能声称原文完整；需要全文时 select 项增加 textOffset（从0开始）和 textLength（最多6000）逐块读取。',
    '- 元数据版本变更时重新 describe；验证失败时停止查询并说明数据定义待修复，不反复探索其他工具。',
    `- OA 创建/更新/删除/审批等写操作继续使用候选 OpenAPI 和 node scripts/callOaApi.mjs${sessionArg}，遵守原有确认及管理员权限校验。oa_database_read 是路由标识，不是可调用的 HTTP operation。`,
  ].join("\n");
}
