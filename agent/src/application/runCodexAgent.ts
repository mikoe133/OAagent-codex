import type { ThreadItem } from "@openai/codex-sdk";
import path from "node:path";
import type { AppConfig } from "../config/config.js";
import type { OpenApiOperationIndexEntry } from "../infrastructure/oa/openApiIndex.js";
import {
  createCodexClient,
  startOrResumeThread,
} from "../infrastructure/codex/codexClient.js";
import { loadSystemPrompt } from "../infrastructure/prompts/promptLoader.js";
import { resolveTaskReasoningEffort } from "./taskReasoningPolicy.js";

export type AgentRunResult = {
  finalResponse: string;
  /** 过程中执行的命令,用于人工验收 agent 是否真的读取了所选 OpenAPI 契约。 */
  executedCommands: string[];
};

export type AgentRuntimeContext = {
  sessionId?: string | null;
  hasSessionOaApiToken?: boolean;
  openApiCandidates?: OpenApiOperationIndexEntry[];
  oaApiCallLimit?: number | null;
};

/**
 * 按规划 §7 组装任务提示词:系统提示词在前,用户任务在后,
 * 不写入 API key、token 或完整环境变量值。
 */
export function buildTaskPrompt(
  config: AppConfig,
  userTask: string,
  runtime: AgentRuntimeContext = {},
): string {
  const systemPrompt = loadSystemPrompt(config.projectRoot);
  const runtimeContext = buildRuntimeContext(config, runtime);

  return [
    "<system_prompt>",
    systemPrompt,
    "</system_prompt>",
    "",
    "<runtime_context>",
    runtimeContext,
    "</runtime_context>",
    "",
    "<user_task>",
    userTask,
    "</user_task>",
  ].join("\n");
}

export function buildRuntimeContext(
  config: AppConfig,
  runtime: AgentRuntimeContext = {},
): string {
  const hasAnyOaApiToken = Boolean(runtime.hasSessionOaApiToken);
  const openapiPath = displayOpenApiPath(config);
  const candidateContext = formatOpenApiCandidates(runtime.openApiCandidates ?? []);
  const oaApiBudgetContext =
    runtime.oaApiCallLimit === 1
      ? "- 本 turn 是普通查询:最多读取一次选定 operation 的精确 schema,并且最多调用一次 OA API;调用失败后不得换接口重试。"
      : runtime.oaApiCallLimit === null
        ? "- 本 turn 是复杂分析或写操作:按完成任务所需的最少次数调用 OA API。"
        : null;
  const commandSessionArg = runtime.sessionId
    ? ` --sessionId ${runtime.sessionId}`
    : "";

  return [
    `- 模型 provider: ${config.modelProvider}`,
    `- 模型: ${config.model}`,
    runtime.sessionId ? `- 当前 sessionId: ${runtime.sessionId}` : null,
    `- 完整接口文档: ${openapiPath}`,
    candidateContext,
    oaApiBudgetContext,
    "- 必须优先从候选接口索引中选择 operation,不得用任何命令宽泛扫描完整 OpenAPI。",
    `- 只有候选信息不足以确认参数或响应结构时,最多允许读取一次选定 operation 的完整 schema;读取范围必须精确限定到该 operation。`,
    "- 不使用额外 Skill、MCP 或自定义 function tools",
    config.oaApiBaseUrl && hasAnyOaApiToken
      ? [
          "- 受控 OA API 调用工具: 可用",
          "- OA 登录态: 已从当前请求 header 绑定到 session;不要读取、输出或转述该 token",
          `- 接口中的 alias 是 OA 数据源别名,不是姓名或业务筛选条件;受控工具会自动固定为 ${config.oaAuthAlias},调用时不要传 alias`,
          "- 需要真实调用 OA 后端时,先从候选接口索引选择 operationId,必要时按上述规则读取一次精确 schema,再运行:",
          `  node scripts/callOaApi.mjs${commandSessionArg} --operationId <operationId> --query '<JSON对象>'`,
          "- 有 path parameters 时加 --pathParams '<JSON对象>';有 request body 时加 --body '<JSON值>'",
          "- 查询/读取/列表/搜索/统计/报表/下载/导出类接口不需要用户确认",
          "- 修改数据、删除数据、创建数据、上传文件、提交审批、修改密码或变更权限等操作必须先取得用户确认,再加 --confirmed true",
          `- 处理 OA 查询时不要修改工作区文件;只允许按上述规则精确读取 ${openapiPath} 并运行 scripts/callOaApi.mjs`,
          "- 不要读取或输出 CALL_OA_API_URL、CALL_OA_API_TOKEN、请求 token 或 Authorization header",
        ].join("\n")
      : "- 受控 OA API 调用工具: 不可用;只能基于候选接口索引和至多一次精确 schema 读取做接口分析,不能声称已执行真实后端操作",
    `- OA_API_BASE_URL: ${config.oaApiBaseUrl ? "已配置" : "未配置"}`,
    `- OA 登录态: ${hasAnyOaApiToken ? "已配置" : "未配置"}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function displayOpenApiPath(config: AppConfig): string {
  const relativePath = path.relative(config.projectRoot, config.openapiPath);
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return `./${relativePath.split(path.sep).join("/")}`;
  }
  return config.openapiPath;
}

/** 把已知密钥值从将要打印的文本中移除,防止密钥进入 stdout/日志。 */
export function redactSecrets(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      text,
    );
}

/**
 * 创建 Codex SDK 会话并执行一次任务:
 * - 通过 --config 覆盖将 provider 指向 nexttoken,API key 只经 env_key 机制传递。
 * - 沙箱为 read-only:agent 只需要读取运行时选中的 OpenAPI 契约。
 * - 禁用 web search:运行时选中的 OpenAPI 契约是唯一事实来源(规划 §9.1)。
 * - 不注册额外 function tools,不加载额外 skills。
 */
export async function runCodexAgent(
  config: AppConfig,
  userTask: string,
  runtime: AgentRuntimeContext = {},
): Promise<AgentRunResult> {
  const codex = createCodexClient(config);
  const thread = startOrResumeThread(
    codex,
    config,
    null,
    config.model,
    resolveTaskReasoningEffort(userTask),
  );

  const resolvedRuntime = {
    ...runtime,
    oaApiCallLimit:
      runtime.oaApiCallLimit === undefined
        ? resolveOaApiCallLimit(userTask)
        : runtime.oaApiCallLimit,
  };
  const turn = await thread.run(
    buildTaskPrompt(config, userTask, resolvedRuntime),
  );

  if (!turn.finalResponse.trim()) {
    const itemTypes = turn.items.map((item) => item.type).join(", ") || "无";
    throw new Error(
      `agent 未返回最终回答(turn 已结束但没有 agent_message)。过程 items: ${itemTypes}。`,
    );
  }

  const secrets = [
    ...Object.values(config.modelProviders).map((provider) => provider.apiKey),
    config.oaApiToolToken,
  ];
  return {
    finalResponse: redactSecrets(turn.finalResponse, secrets),
    executedCommands: collectExecutedCommands(turn.items).map((command) =>
      redactSecrets(command, secrets),
    ),
  };
}

export function collectExecutedCommands(items: ThreadItem[]): string[] {
  return items
    .filter((item) => item.type === "command_execution")
    .map((item) => item.command);
}

function resolveOaApiCallLimit(task: string): number | null {
  return resolveTaskReasoningEffort(task) === "medium" ? 1 : null;
}

function formatOpenApiCandidates(
  candidates: OpenApiOperationIndexEntry[],
): string {
  if (candidates.length === 0) {
    return "- 候选接口索引:不可用;不得猜测接口能力。";
  }
  return [
    `- 候选接口索引:已按当前任务筛选 ${candidates.length} 个最相关接口。`,
    "<candidate_operations>",
    JSON.stringify(candidates),
    "</candidate_operations>",
  ].join("\n");
}
