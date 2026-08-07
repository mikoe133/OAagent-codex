import { validateHeaderName } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import {
  getDefaultModel,
  resolveAutomationModelSelection,
  type AutomationModelParameters,
  type ModelProviderId,
} from "./modelCatalog.js";

const DEFAULT_NEXTTOKEN_BASE_URL = "https://next-token.cc/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type ProjectProgressRequestedModel = {
  modelProvider?: string;
  modelId?: string;
  modelParameters?: AutomationModelParameters;
};

export type ProjectProgressConfig = {
  oa: {
    baseUrl: string;
    alias: string;
    token: string;
    tokenHeader: string;
    tokenPrefix: string;
    projectDetailCompatibilityMode: boolean;
  };
  githubToken: string;
  githubApiBaseUrl: string;
  model: {
    provider: ModelProviderId;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    parameters: AutomationModelParameters;
  };
  agent: {
    maxCandidateCommits: number;
    maxDetailCalls: number;
    maxFilesPerCommit: number;
    maxFilenameChars: number;
    maxPatchCharsPerFile: number;
    maxTotalPatchChars: number;
  };
  automation: {
    token: string | null;
    workerInstance: string;
    leaseSeconds: number;
    heartbeatSeconds: number;
  };
  concurrency: {
    github: number;
    agent: number;
    oaWrite: 1;
  };
  workspaceRoot: string;
  stateDatabasePath: string;
  writeEnabled: boolean;
  writeAuthorization: "disabled" | "unsafe-test" | "production";
};

export function loadProjectProgressConfig(
  environment: Record<string, string | undefined> = process.env,
  repoRoot = process.cwd(),
  requestedModel: ProjectProgressRequestedModel = {},
): ProjectProgressConfig {
  const writeEnabled = parseBoolean(environment.PROJECT_PROGRESS_WRITE_ENABLED, false);
  const oaBaseUrl = requireValue(environment, "OA_API_BASE_URL");
  const writeAuthorization = resolveWriteAuthorization(
    environment,
    writeEnabled,
    oaBaseUrl,
  );
  const tokenHeader = environment.OA_PROJECT_SYNC_TOKEN_HEADER?.trim() || "Authorization";
  try {
    validateHeaderName(tokenHeader);
  } catch {
    throw new Error(`OA_PROJECT_SYNC_TOKEN_HEADER 不是合法 header:${tokenHeader}`);
  }
  const configuredProvider = environment.PROJECT_PROGRESS_MODEL_PROVIDER?.trim() ||
    environment.CODEX_MODEL_PROVIDER?.trim() ||
    "nexttoken";
  const configuredModel = environment.PROJECT_PROGRESS_MODEL?.trim() ||
    modelFromProvider(environment, configuredProvider);
  const configuredParameters = decodeEnvironmentModelParameters(environment);
  const leaseSeconds = parseIntegerInRange(
    environment.PROJECT_PROGRESS_LEASE_SECONDS,
    300,
    60,
    600,
    "PROJECT_PROGRESS_LEASE_SECONDS",
  );
  const heartbeatSeconds = parseIntegerInRange(
    environment.PROJECT_PROGRESS_HEARTBEAT_SECONDS,
    60,
    10,
    300,
    "PROJECT_PROGRESS_HEARTBEAT_SECONDS",
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error("PROJECT_PROGRESS_HEARTBEAT_SECONDS 必须小于租约秒数。");
  }
  const modelSelection = resolveAutomationModelSelection(
    {
      modelProvider: requestedModel.modelProvider,
      modelId: requestedModel.modelId,
      modelParameters: requestedModel.modelParameters,
    },
    {
      modelProvider: resolveConfiguredProvider(configuredProvider),
      modelId: configuredModel || getDefaultModel(resolveConfiguredProvider(configuredProvider)),
      modelParameters: configuredParameters,
    },
  );
  const maxPatchCharsPerFile = parseIntegerInRange(
    environment.PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE,
    1_200,
    100,
    20_000,
    "PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE",
  );
  const maxTotalPatchChars = parseIntegerInRange(
    environment.PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS,
    12_000,
    100,
    100_000,
    "PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS",
  );
  if (maxTotalPatchChars < maxPatchCharsPerFile) {
    throw new Error(
      "PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS 不能小于单文件 Patch 上限。",
    );
  }
  const oaWriteConcurrency = parseIntegerInRange(
    environment.PROJECT_PROGRESS_OA_WRITE_CONCURRENCY,
    1,
    1,
    20,
    "PROJECT_PROGRESS_OA_WRITE_CONCURRENCY",
  );
  if (oaWriteConcurrency !== 1) {
    throw new Error("PROJECT_PROGRESS_OA_WRITE_CONCURRENCY 当前必须为 1。");
  }

  return {
    oa: {
      baseUrl: oaBaseUrl,
      alias: environment.OA_AUTH_ALIAS?.trim() || "default",
      token: requireValue(environment, "OA_PROJECT_SYNC_TOKEN"),
      tokenHeader,
      tokenPrefix: environment.OA_PROJECT_SYNC_TOKEN_PREFIX === undefined
        ? "Bearer"
        : environment.OA_PROJECT_SYNC_TOKEN_PREFIX.trim(),
      projectDetailCompatibilityMode: parseBoolean(
        environment.PROJECT_PROGRESS_OA_PROJECT_DETAIL_COMPATIBILITY_MODE,
        false,
      ),
    },
    githubToken: requireValue(environment, "PROJECT_PROGRESS_GITHUB_TOKEN"),
    githubApiBaseUrl: environment.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    model: {
      provider: modelSelection.modelProvider,
      apiBaseUrl: normalizeModelBaseUrl(
        environment.PROJECT_PROGRESS_MODEL_API_BASE_URL?.trim() ||
          providerBaseUrl(environment, modelSelection.modelProvider),
      ),
      apiKey: environment.PROJECT_PROGRESS_MODEL_API_KEY?.trim() ||
        requireValue(environment, providerApiKeyName(modelSelection.modelProvider)),
      model: modelSelection.modelId,
      parameters: modelSelection.modelParameters,
    },
    agent: {
      maxCandidateCommits: 50,
      maxDetailCalls: parseIntegerInRange(
        environment.PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS,
        12,
        1,
        50,
        "PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS",
      ),
      maxFilesPerCommit: parseIntegerInRange(
        environment.PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT,
        20,
        1,
        100,
        "PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT",
      ),
      maxFilenameChars: 240,
      maxPatchCharsPerFile,
      maxTotalPatchChars,
    },
    automation: {
      token: environment.OA_AGENT_AUTOMATION_TOKEN?.trim() || null,
      workerInstance: resolveWorkerInstance(environment.PROJECT_PROGRESS_WORKER_INSTANCE),
      leaseSeconds,
      heartbeatSeconds,
    },
    concurrency: {
      github: parseIntegerInRange(
        environment.PROJECT_PROGRESS_GITHUB_CONCURRENCY,
        6,
        1,
        20,
        "PROJECT_PROGRESS_GITHUB_CONCURRENCY",
      ),
      agent: parseIntegerInRange(
        environment.PROJECT_PROGRESS_AGENT_CONCURRENCY,
        2,
        1,
        4,
        "PROJECT_PROGRESS_AGENT_CONCURRENCY",
      ),
      oaWrite: oaWriteConcurrency,
    },
    workspaceRoot: path.resolve(
      repoRoot,
      environment.PROJECT_PROGRESS_WORKSPACE_ROOT?.trim() ||
        path.join(repoRoot, ".context", "project-progress-workspaces"),
    ),
    stateDatabasePath: environment.PROJECT_PROGRESS_STATE_DB?.trim() ||
      path.join(repoRoot, ".context", "project-progress.sqlite"),
    writeEnabled,
    writeAuthorization,
  };
}

function resolveWorkerInstance(value: string | undefined): string {
  const resolved = value?.trim() || `oaagent-${hostname()}`;
  if (!resolved || resolved.length > 255 || /[\r\n\u0000]/.test(resolved)) {
    throw new Error("PROJECT_PROGRESS_WORKER_INSTANCE 必须是 1-255 字符的单行文本。");
  }
  return resolved;
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数。`);
  }
  return parsed;
}

function resolveConfiguredProvider(value: string): ModelProviderId {
  return resolveAutomationModelSelection(
    { modelProvider: value },
    {
      modelProvider: "nexttoken",
      modelId: getDefaultModel("nexttoken"),
    },
  ).modelProvider;
}

function modelFromProvider(
  environment: Record<string, string | undefined>,
  provider: string,
): string | undefined {
  return provider === "openrouter"
    ? environment.OPENROUTER_MODEL?.trim()
    : environment.NEXTTOKEN_MODEL?.trim();
}

function providerBaseUrl(
  environment: Record<string, string | undefined>,
  provider: ModelProviderId,
): string {
  return provider === "openrouter"
    ? environment.OPENROUTER_API_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL
    : environment.NEXTTOKEN_API_BASE_URL?.trim() || DEFAULT_NEXTTOKEN_BASE_URL;
}

function providerApiKeyName(
  provider: ModelProviderId,
): "NEXTTOKEN_API_KEY" | "OPENROUTER_API_KEY" {
  return provider === "openrouter" ? "OPENROUTER_API_KEY" : "NEXTTOKEN_API_KEY";
}

function decodeEnvironmentModelParameters(
  environment: Record<string, string | undefined>,
): AutomationModelParameters {
  const parameters: AutomationModelParameters = {};
  const reasoningEffort = environment.PROJECT_PROGRESS_MODEL_REASONING_EFFORT?.trim();
  if (reasoningEffort) {
    parameters.reasoning_effort = reasoningEffort as AutomationModelParameters["reasoning_effort"];
  }
  const maxOutputTokens = environment.PROJECT_PROGRESS_MODEL_MAX_OUTPUT_TOKENS?.trim();
  if (maxOutputTokens) {
    parameters.max_output_tokens = Number(maxOutputTokens);
  }
  return resolveAutomationModelSelection(
    { modelParameters: parameters },
    {
      modelProvider: "nexttoken",
      modelId: getDefaultModel("nexttoken"),
    },
  ).modelParameters;
}

function resolveWriteAuthorization(
  environment: Record<string, string | undefined>,
  writeEnabled: boolean,
  oaBaseUrl: string,
): ProjectProgressConfig["writeAuthorization"] {
  if (!writeEnabled) {
    return "disabled";
  }
  const testAcknowledged =
    environment.PROJECT_PROGRESS_UNSAFE_TEST_WRITES === "I_UNDERSTAND_TEST_ONLY";
  const productionAcknowledged =
    environment.PROJECT_PROGRESS_PRODUCTION_WRITES ===
      "I_UNDERSTAND_PRODUCTION_WRITES";
  if (testAcknowledged && productionAcknowledged) {
    throw new Error("PROJECT_PROGRESS 只能选择一种写入确认。");
  }
  if (productionAcknowledged) {
    return "production";
  }
  if (testAcknowledged) {
    if (!isLoopbackUrl(oaBaseUrl)) {
      throw new Error("测试写入只允许通过 loopback OA 服务访问测试数据库。");
    }
    return "unsafe-test";
  }
  throw new Error(
    "写入必须设置 PROJECT_PROGRESS_UNSAFE_TEST_WRITES 或 PROJECT_PROGRESS_PRODUCTION_WRITES 的显式确认值。",
  );
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
