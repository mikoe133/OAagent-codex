import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { validateHeaderName } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseAutomationConfig, type AutomationConfig } from "./automationConfig.js";
import {
  getDefaultModel,
  resolveRequestedModel,
  resolveRequestedProvider,
  type ModelProviderId,
} from "./modelCatalog.js";

const DEFAULT_NEXTTOKEN_BASE_URL = "https://next-token.cc/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL_PROVIDER: ModelProviderId = "nexttoken";
const DEFAULT_OPENAPI_URL = "https://api-oa.rwkvos.com/openapi_json";
const DEFAULT_KNOWLEDGE_BASE_API_BASE_URL =
  "https://oa-kb.rwkvos.com/api/agent/v1";

export type AppConfig = {
  /** 后端包根目录(openapi/、prompts/ 所在目录)。 */
  projectRoot: string;
  /** 仓库根目录(frontend/、agent/ 所在目录)。 */
  repoRoot: string;
  /** 本地兜底 openapi/openapi.json 的绝对路径。 */
  openapiPath: string;
  /** 优先读取的远程 OA OpenAPI 地址。 */
  openapiUrl: string;
  /** 可切换模型服务配置。API key 只用于模型调用。 */
  modelProviders: Record<ModelProviderId, ModelProviderConfig>;
  /** Codex model provider 标识。 */
  modelProvider: ModelProviderId;
  /** 模型服务上的模型 ID。 */
  model: string;
  /** Codex 命令沙箱。为空时根据 OA 工具是否启用自动选择。 */
  codexSandboxMode: CodexSandboxMode | null;
  /** 运行时创建的本地 HTTP/1.1 模型中继地址。 */
  modelRelayBaseUrl: string | null;
  /** OA 后端地址。未配置时只做接口分析。 */
  oaApiBaseUrl: string | null;
  /** OA 数据源别名。 */
  oaAuthAlias: string;
  /** OA token header 名称。 */
  oaApiTokenHeader: string;
  /** OA token header 值前缀。为空时直接使用 token。 */
  oaApiTokenPrefix: string;
  /** 从前端请求读取用户 OA token 的 header 名称。 */
  oaUserTokenHeader: string;
  /** 前端请求用户 OA token header 的值前缀。为空时直接读取完整 header 值。 */
  oaUserTokenPrefix: string;
  /** Codex 子进程调用服务端受控 OA API 工具的短期 token。 */
  oaApiToolToken: string;
  /** 知识库 Agent API 地址。 */
  knowledgeBaseApiBaseUrl: string;
  /** OA 后端与知识库共享的固定服务 Token。 */
  knowledgeBaseApiToken: string | null;
  /** 知识库只读 OpenAPI 文档。 */
  knowledgeBaseReadOpenapiPath: string;
  /** 预留的知识库写 OpenAPI 文档；文件可暂不存在。 */
  knowledgeBaseWriteOpenapiPath: string;
  /** 知识库调用说明文档。 */
  knowledgeBaseApiGuidePath: string;
  /** OA 后端调用自动化模型目录与校验接口的专用 token。 */
  automationApiToken: string | null;
  /** Node 自动任务存储、认证与 maintenance 配置。 */
  automation: AutomationConfig;
  /** 后台服务监听端口。 */
  serverPort: number;
  /** 后台服务监听地址。 */
  serverHost: string;
  /** 后台服务 session 映射持久化文件。 */
  sessionStorePath: string;
};

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type ModelProviderConfig = {
  name: string;
  apiKey: string;
  baseUrl: string;
  envKey: "NEXTTOKEN_API_KEY" | "OPENROUTER_API_KEY";
};

/**
 * 读取 .env 并做启动前校验:
 * - 缺少 NEXTTOKEN_API_KEY 或 OPENROUTER_API_KEY:直接失败。
 * - 缺少本地兜底 openapi/openapi.json:直接失败。
 * - 缺少 OA_API_BASE_URL:允许启动,agent 仍可基于所选 OpenAPI 契约做接口分析。
 */
export function loadConfig(): AppConfig {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const repoRoot = path.resolve(projectRoot, "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(projectRoot, ".env"), override: true });

  const nexttokenApiKey = requireModelApiKey("NEXTTOKEN_API_KEY");
  const openrouterApiKey = requireModelApiKey("OPENROUTER_API_KEY");

  const openapiPath = path.join(projectRoot, "openapi", "openapi.json");
  if (!existsSync(openapiPath)) {
    throw new Error(
      `缺少本地兜底接口文档:${openapiPath} 不存在。远程 OpenAPI 不可用时必须使用该文件。`,
    );
  }
  const knowledgeBaseReadOpenapiPath = path.join(
    projectRoot,
    "knowledgebaseapi",
    "knowledgebaseapi.yaml",
  );
  const knowledgeBaseWriteOpenapiPath = path.join(
    projectRoot,
    "knowledgebaseapi",
    "knowledgebase-write-api.yaml",
  );
  const knowledgeBaseApiGuidePath = path.join(
    projectRoot,
    "knowledgebaseapi",
    "AGENT_API.md",
  );
  for (const requiredPath of [
    knowledgeBaseReadOpenapiPath,
    knowledgeBaseApiGuidePath,
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`缺少知识库接口文档:${requiredPath} 不存在。`);
    }
  }

  const modelProviders: Record<ModelProviderId, ModelProviderConfig> = {
    nexttoken: {
      name: "Nexttoken",
      apiKey: nexttokenApiKey,
      baseUrl: normalizeModelBaseUrl(
        process.env.NEXTTOKEN_API_BASE_URL?.trim() || DEFAULT_NEXTTOKEN_BASE_URL,
        "NEXTTOKEN_API_BASE_URL",
      ),
      envKey: "NEXTTOKEN_API_KEY",
    },
    openrouter: {
      name: "OpenRouter",
      apiKey: openrouterApiKey,
      baseUrl: normalizeModelBaseUrl(
        process.env.OPENROUTER_BASE_URL?.trim() ||
          process.env.OPENROUTER_API_BASE_URL?.trim() ||
          DEFAULT_OPENROUTER_BASE_URL,
        "OPENROUTER_API_BASE_URL",
      ),
      envKey: "OPENROUTER_API_KEY",
    },
  };
  const modelProvider = resolveRequestedProvider(
    process.env.CODEX_MODEL_PROVIDER?.trim(),
    DEFAULT_MODEL_PROVIDER,
  );
  const model = resolveRequestedModel(
    modelProvider,
    normalizeModelId(
      process.env.CODEX_MODEL?.trim() ||
        (modelProvider === "nexttoken"
          ? process.env.NEXTTOKEN_MODEL?.trim()
          : process.env.OPENROUTER_MODEL?.trim()),
    ),
    getDefaultModel(modelProvider),
  );

  const serverPort = parsePort(process.env.PORT?.trim() || "3000");
  const serverHost = process.env.HOST?.trim() || "127.0.0.1";
  const sessionStorePath =
    process.env.AGENT_SESSION_STORE?.trim() ||
    path.join(repoRoot, ".context", "agent-sessions.json");
  const oaApiTokenHeader =
    process.env.OA_API_TOKEN_HEADER?.trim() || "Cookie";
  validateConfiguredHeaderName("OA_API_TOKEN_HEADER", oaApiTokenHeader);
  const oaApiTokenPrefix =
    process.env.OA_API_TOKEN_PREFIX === undefined
      ? "sessionid="
      : process.env.OA_API_TOKEN_PREFIX.trim();
  const oaUserTokenHeader =
    process.env.OA_USER_TOKEN_HEADER?.trim() || "Authorization";
  validateConfiguredHeaderName("OA_USER_TOKEN_HEADER", oaUserTokenHeader);
  const oaUserTokenPrefix =
    process.env.OA_USER_TOKEN_PREFIX === undefined
      ? "Bearer"
      : process.env.OA_USER_TOKEN_PREFIX.trim();

  return {
    projectRoot,
    repoRoot,
    openapiPath,
    openapiUrl: process.env.OA_OPENAPI_URL?.trim() || DEFAULT_OPENAPI_URL,
    modelProviders,
    modelProvider,
    model,
    codexSandboxMode: parseCodexSandboxMode(process.env.CODEX_SANDBOX_MODE),
    modelRelayBaseUrl: null,
    oaApiBaseUrl: process.env.OA_API_BASE_URL?.trim() || null,
    oaAuthAlias: process.env.OA_AUTH_ALIAS?.trim() || "default",
    oaApiTokenHeader,
    oaApiTokenPrefix,
    oaUserTokenHeader,
    oaUserTokenPrefix,
    oaApiToolToken:
      process.env.AGENT_OA_TOOL_TOKEN?.trim() || randomBytes(32).toString("hex"),
    knowledgeBaseApiBaseUrl: normalizeHttpServiceBaseUrl(
      process.env.OA_KNOWLEDGE_API_BASE_URL?.trim() ||
        DEFAULT_KNOWLEDGE_BASE_API_BASE_URL,
      "OA_KNOWLEDGE_API_BASE_URL",
    ),
    knowledgeBaseApiToken: process.env.OA_KNOWLEDGE_API_KEY?.trim() || null,
    knowledgeBaseReadOpenapiPath,
    knowledgeBaseWriteOpenapiPath,
    knowledgeBaseApiGuidePath,
    automationApiToken: process.env.OA_AGENT_AUTOMATION_TOKEN?.trim() || null,
    automation: parseAutomationConfig(process.env),
    serverPort,
    serverHost,
    sessionStorePath,
  };
}

export function parseCodexSandboxMode(
  value: string | undefined,
): CodexSandboxMode | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (
    normalized === "read-only" ||
    normalized === "workspace-write" ||
    normalized === "danger-full-access"
  ) {
    return normalized;
  }
  throw new Error(
    "CODEX_SANDBOX_MODE 必须是 read-only、workspace-write 或 danger-full-access。",
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数,当前值:${value}。`);
  }
  return port;
}

function normalizeModelId(value: string | undefined): string | undefined {
  if (value === "gpt5.6-terra") {
    return "gpt-5.6-terra";
  }
  if (value === "glm5.3") {
    return "z-ai/glm-5.3";
  }
  return value;
}

export function normalizeModelBaseUrl(value: string, variableName = "MODEL_API_BASE_URL"): string {
  const normalized = value.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`${variableName} 必须是 HTTP(S) 地址,当前值:${value}。`);
  }
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function normalizeHttpServiceBaseUrl(value: string, variableName: string): string {
  const normalized = value.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${variableName} 必须是 HTTP(S) 地址,当前值:${value}。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variableName} 必须是 HTTP(S) 地址,当前值:${value}。`);
  }
  return normalized;
}

function requireModelApiKey(name: "NEXTTOKEN_API_KEY" | "OPENROUTER_API_KEY"): string {
  const apiKey = process.env[name]?.trim();
  if (!apiKey) {
    throw new Error(
      `缺少 ${name}。请在 .env 中配置(参考 .env.example),它只用于模型调用,不会写入 prompt 或日志。`,
    );
  }
  return apiKey;
}

function validateConfiguredHeaderName(name: string, value: string): void {
  try {
    validateHeaderName(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} 不是合法 HTTP header 名称:${message}`);
  }
}
