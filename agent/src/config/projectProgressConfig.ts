import { validateHeaderName } from "node:http";
import path from "node:path";
import { getDefaultModel, resolveRequestedModel } from "./modelCatalog.js";

const DEFAULT_NEXTTOKEN_BASE_URL = "https://next-token.cc/v1";

export type ProjectProgressConfig = {
  oa: {
    baseUrl: string;
    alias: string;
    token: string;
    tokenHeader: string;
    tokenPrefix: string;
  };
  githubToken: string;
  githubApiBaseUrl: string;
  model: {
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  };
  stateDatabasePath: string;
  writeEnabled: boolean;
};

export function loadProjectProgressConfig(
  environment: Record<string, string | undefined> = process.env,
  repoRoot = process.cwd(),
): ProjectProgressConfig {
  const writeEnabled = parseBoolean(environment.PROJECT_PROGRESS_WRITE_ENABLED, false);
  if (
    writeEnabled &&
    environment.PROJECT_PROGRESS_UNSAFE_TEST_WRITES !== "I_UNDERSTAND_TEST_ONLY"
  ) {
    throw new Error(
      "测试写入必须设置 PROJECT_PROGRESS_UNSAFE_TEST_WRITES=I_UNDERSTAND_TEST_ONLY。",
    );
  }
  const oaBaseUrl = requireValue(environment, "OA_API_BASE_URL");
  if (writeEnabled && !isLoopbackUrl(oaBaseUrl)) {
    throw new Error("测试写入只允许通过 loopback OA 服务访问测试数据库。");
  }
  const tokenHeader = environment.OA_PROJECT_SYNC_TOKEN_HEADER?.trim() || "Authorization";
  try {
    validateHeaderName(tokenHeader);
  } catch {
    throw new Error(`OA_PROJECT_SYNC_TOKEN_HEADER 不是合法 header:${tokenHeader}`);
  }
  const model = resolveRequestedModel(
    "nexttoken",
    environment.PROJECT_PROGRESS_MODEL?.trim() || environment.NEXTTOKEN_MODEL?.trim(),
    getDefaultModel("nexttoken"),
  );

  return {
    oa: {
      baseUrl: oaBaseUrl,
      alias: environment.OA_AUTH_ALIAS?.trim() || "default",
      token: requireValue(environment, "OA_PROJECT_SYNC_TOKEN"),
      tokenHeader,
      tokenPrefix: environment.OA_PROJECT_SYNC_TOKEN_PREFIX === undefined
        ? "Bearer"
        : environment.OA_PROJECT_SYNC_TOKEN_PREFIX.trim(),
    },
    githubToken: requireValue(environment, "GITHUB_PROJECT_SYNC_TOKEN"),
    githubApiBaseUrl: environment.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    model: {
      apiBaseUrl: normalizeModelBaseUrl(
        environment.PROJECT_PROGRESS_MODEL_API_BASE_URL?.trim() ||
          environment.NEXTTOKEN_API_BASE_URL?.trim() ||
          DEFAULT_NEXTTOKEN_BASE_URL,
      ),
      apiKey: environment.PROJECT_PROGRESS_MODEL_API_KEY?.trim() ||
        requireValue(environment, "NEXTTOKEN_API_KEY"),
      model,
    },
    stateDatabasePath: environment.PROJECT_PROGRESS_STATE_DB?.trim() ||
      path.join(repoRoot, ".context", "project-progress.sqlite"),
    writeEnabled,
  };
}

function requireValue(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`缺少 ${name}。`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`布尔配置必须是 true 或 false,当前值:${value}`);
}

function normalizeModelBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`模型 API 地址必须是 HTTP(S):${value}`);
  }
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) {
    return false;
  }
  return url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
}
