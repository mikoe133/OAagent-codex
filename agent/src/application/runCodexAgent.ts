import type { ThreadItem } from "@openai/codex-sdk";
import path from "node:path";
import type { AppConfig } from "../config/config.js";
import type { OpenApiOperationIndexEntry } from "../infrastructure/oa/openApiIndex.js";
import {
  createCodexClient,
  startOrResumeThread,
} from "../infrastructure/codex/codexClient.js";
import { loadSystemPrompt } from "../infrastructure/prompts/promptLoader.js";
import {
  beginOaTurn,
  finishOaTurn,
  resolveOaQueryPolicy,
  type OaQueryPolicy,
} from "../infrastructure/oa/oaQueryPolicy.js";
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
  oaQueryPolicy?: OaQueryPolicy;
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
  const oaApiBudgetContext = formatOaQueryPolicy(runtime.oaQueryPolicy);
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
    "- 必须优先从候选接口索引中选择 operation。候选接口未包含语义上可满足用户意图的 operation 时,允许在候选以外的完整 OpenAPI 中进行一次受限检索;只按业务关键词、已知 path 片段、summary、tag 或 operationId 定位,不得遍历或转储整个文档。",
    `- 候选索引包含主要请求字段和响应字段。候选信息不足,或受限检索发现候选外 operation 时,才读取完整 schema,并精确限定到该 operation;具体读取次数服从本 turn 的动态查询模式。不得因候选接口未命中就直接断言接口不存在。`,
    "- 已确认的批量写操作按记录独立处理;单条失败时记录结果并继续处理其余记录,只有认证、权限、确认或共享前置条件失败才停止整批。",
    "- 项目 ID 缺失时先通过只读项目列表和详情重新发现并处理分页;历史或归档状态不是项目不可更新的证据,无法唯一匹配时只跳过该条。",
    "- 维护项目 GitHub 地址时先映射项目名称和 ID,再使用请求 schema 声明 github_urls 的项目更新接口;不得误用 Commit 摘要接口,写入后应回查并汇总每条结果。",
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
          `- 处理 OA 查询时不要修改工作区文件;只允许按上述规则受限检索或精确读取 ${openapiPath} 并运行 scripts/callOaApi.mjs`,
          "- 不要读取或输出 CALL_OA_API_URL、CALL_OA_API_TOKEN、请求 token 或 Authorization header",
        ].join("\n")
      : "- 受控 OA API 调用工具: 不可用;只能基于候选接口索引、至多一次候选外受限检索和精确 schema 读取做接口分析,不能声称已执行真实后端操作",
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
    oaQueryPolicy: runtime.oaQueryPolicy ?? resolveOaQueryPolicy(userTask),
  };
  if (runtime.sessionId) {
    beginOaTurn(runtime.sessionId, resolvedRuntime.oaQueryPolicy);
  }
  const turn = await (async () => {
    try {
      return await thread.run(buildTaskPrompt(config, userTask, resolvedRuntime));
    } finally {
      if (runtime.sessionId) {
        finishOaTurn(runtime.sessionId);
      }
    }
  })();

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

function formatOpenApiCandidates(
  candidates: OpenApiOperationIndexEntry[],
): string {
  if (candidates.length === 0) {
    return "- 候选接口索引:不可用;必须对指定的完整 OpenAPI 执行一次受限检索后再判断接口能力,不得猜测。";
  }
  return [
    `- 候选接口索引:已按当前任务筛选 ${candidates.length} 个最相关接口。`,
    "<candidate_operations>",
    JSON.stringify(candidates),
    "</candidate_operations>",
  ].join("\n");
}

function formatOaQueryPolicy(policy: OaQueryPolicy | undefined): string | null {
  if (!policy) {
    return null;
  }
  if (policy.mode === "single_step") {
    return [
      "- 本 turn 是高置信度单步查询:最多读取一次选定 operation 的精确 schema;目标数据完整时最多调用一次 OA API。",
      "- 如果首次结果明确提示响应截断、仍有分页、缺少关联 ID/编号或必须依赖后续查询,受控工具会自动把本 turn 升级为多步;只有收到这类不完整信号后才继续调用。",
    ].join("\n");
  }
  if (policy.mode === "multi_step") {
    return "- 本 turn 是复杂查询、列表/报表或写操作:保留自主多步能力;可按需读取多个相关 operation 的精确 schema,但每个 operation 最多读取一次;按完成任务所需的最少次数调用 OA API。";
  }
  return "- 本 turn 的复杂度不确定:不设置单次调用硬限制;先用最少调用探索,可按需读取相关 operation 的精确 schema且每个最多一次,发现分页、依赖或关联关系时继续完成任务。";
}
