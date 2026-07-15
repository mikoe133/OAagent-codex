import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { validateHeaderName } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PROVIDER = "openrouter";
const DEFAULT_OPENAPI_URL = "https://api-oa.rwkvos.com/openapi_json";

export type AppConfig = {
  /** 后端包根目录(openapi/、prompts/ 所在目录)。 */
  projectRoot: string;
  /** 仓库根目录(frontend/、agent/ 所在目录)。 */
  repoRoot: string;
  /** 本地兜底 openapi/openapi.json 的绝对路径。 */
  openapiPath: string;
  /** 优先读取的远程 OA OpenAPI 地址。 */
  openapiUrl: string;
  /** OpenRouter API key。只用于模型调用,不允许写入 prompt、日志或最终回答。 */
  openrouterApiKey: string;
  /** OpenRouter OpenAI-compatible base URL。 */
  openrouterBaseUrl: string;
  /** Codex model provider 标识。 */
  modelProvider: string;
  /** OpenRouter 上的模型 slug。 */
  model: string;
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
  /** 后台服务监听端口。 */
  serverPort: number;
  /** 后台服务监听地址。 */
  serverHost: string;
  /** 后台服务 session 映射持久化文件。 */
  sessionStorePath: string;
};

/**
 * 读取 .env 并做启动前校验:
 * - 缺少 OPENROUTER_API_KEY:直接失败。
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

  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openrouterApiKey) {
    throw new Error(
      "缺少 OPENROUTER_API_KEY。请在 .env 中配置(参考 .env.example),它只用于模型调用,不会写入 prompt 或日志。",
    );
  }

  const openapiPath = path.join(projectRoot, "openapi", "openapi.json");
  if (!existsSync(openapiPath)) {
    throw new Error(
      `缺少本地兜底接口文档:${openapiPath} 不存在。远程 OpenAPI 不可用时必须使用该文件。`,
    );
  }

  const openrouterBaseUrl =
    process.env.OPENROUTER_BASE_URL?.trim() ||
    process.env.OPENROUTER_API_BASE_URL?.trim() ||
    DEFAULT_OPENROUTER_BASE_URL;

  const model = normalizeModelId(
    process.env.CODEX_MODEL?.trim() ||
      process.env.OPENROUTER_MODEL?.trim() ||
      DEFAULT_MODEL,
  );

  const modelProvider =
    process.env.CODEX_MODEL_PROVIDER?.trim() || DEFAULT_MODEL_PROVIDER;
  // provider id 会被 SDK 拼进 TOML 覆盖路径(model_providers.<id>.*),
  // 非 bare key 字符会静默生成错误配置,必须在启动时拦下。
  if (!/^[A-Za-z0-9_-]+$/.test(modelProvider)) {
    throw new Error(
      `CODEX_MODEL_PROVIDER 只能包含字母、数字、下划线和连字符,当前值:${modelProvider}。注意它是 provider 标识(如 openrouter),不是模型 slug。`,
    );
  }

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
    openrouterApiKey,
    openrouterBaseUrl,
    modelProvider,
    model,
    oaApiBaseUrl: process.env.OA_API_BASE_URL?.trim() || null,
    oaAuthAlias: process.env.OA_AUTH_ALIAS?.trim() || "default",
    oaApiTokenHeader,
    oaApiTokenPrefix,
    oaUserTokenHeader,
    oaUserTokenPrefix,
    oaApiToolToken:
      process.env.AGENT_OA_TOOL_TOKEN?.trim() || randomBytes(32).toString("hex"),
    serverPort,
    serverHost,
    sessionStorePath,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数,当前值:${value}。`);
  }
  return port;
}

function normalizeModelId(value: string): string {
  if (value === "gpt5.5") {
    return "gpt-5.5";
  }
  return value;
}

function validateConfiguredHeaderName(name: string, value: string): void {
  try {
    validateHeaderName(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} 不是合法 HTTP header 名称:${message}`);
  }
}
