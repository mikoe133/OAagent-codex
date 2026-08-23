import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { AppConfig } from "../../config/config.js";
import {
  normalizeModelReasoningEffort,
  type ModelProviderId,
} from "../../config/modelCatalog.js";
import { resolveCodexModelCatalogPath } from "./modelMetadataCatalog.js";

/**
 * codex 子进程只拿到运行必需的变量。.env 中的其余凭证
 * (OA session、client keys 等)不进入子进程环境,也就不会被
 * agent 的 printenv/shell 命令读到。
 */
function buildChildEnv(
  config: AppConfig,
  providerConfig: AppConfig["modelProviders"][AppConfig["modelProvider"]],
  toolSessionId?: string,
): Record<string, string> {
  const passthroughKeys = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM"];
  const env: Record<string, string> = {};
  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env[providerConfig.envKey] = providerConfig.apiKey;
  env.CALL_OA_API_URL = `http://127.0.0.1:${config.serverPort}/__internal/call-oa-api`;
  env.CALL_OA_API_TOKEN = config.oaApiToolToken;
  env.CALL_KNOWLEDGE_BASE_API_URL = `http://127.0.0.1:${config.serverPort}/__internal/call-knowledge-base-api`;
  env.CALL_KNOWLEDGE_BASE_API_TOKEN = config.oaApiToolToken;
  if (toolSessionId) {
    env.CALL_OA_API_SESSION_ID = toolSessionId;
    env.CALL_KNOWLEDGE_BASE_API_SESSION_ID = toolSessionId;
  }
  return env;
}

export function createCodexClient(
  config: AppConfig,
  toolSessionId?: string,
): Codex {
  const providerConfig = config.modelProviders[config.modelProvider];
  const modelCatalogPath = resolveCodexModelCatalogPath(config.model);
  return new Codex({
    env: buildChildEnv(config, providerConfig, toolSessionId),
    config: {
      ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {}),
      model_provider: config.modelProvider,
      model_providers: {
        [config.modelProvider]: {
          name: providerConfig.name,
          base_url: resolveCodexModelBaseUrl(config, config.modelProvider),
          env_key: providerConfig.envKey,
          wire_api: "responses",
        },
      },
    },
  });
}

export function resolveCodexModelBaseUrl(
  config: AppConfig,
  provider: ModelProviderId,
): string {
  if (!config.modelRelayBaseUrl) {
    return config.modelProviders[provider].baseUrl;
  }

  return `${config.modelRelayBaseUrl.replace(/\/+$/, "")}/${provider}/v1`;
}

export function createThreadOptions(
  config: AppConfig,
  model: string = config.model,
  modelReasoningEffort: ModelReasoningEffort = "medium",
): ThreadOptions {
  const oaToolEnabled = Boolean(config.oaApiBaseUrl);
  const knowledgeBaseToolEnabled = Boolean(
    config.knowledgeBaseApiBaseUrl && config.knowledgeBaseApiToken,
  );
  const controlledApiToolEnabled = oaToolEnabled || knowledgeBaseToolEnabled;
  const sandboxMode =
    config.codexSandboxMode ??
    (controlledApiToolEnabled ? "workspace-write" : "read-only");
  return {
    model,
    modelReasoningEffort: normalizeModelReasoningEffort(
      model,
      modelReasoningEffort,
    ),
    sandboxMode,
    workingDirectory: config.projectRoot,
    skipGitRepoCheck: true,
    networkAccessEnabled:
      sandboxMode === "workspace-write" ? controlledApiToolEnabled : undefined,
    webSearchMode: "disabled",
  };
}

export function startOrResumeThread(
  codex: Codex,
  config: AppConfig,
  threadId: string | null,
  model: string = config.model,
  modelReasoningEffort: ModelReasoningEffort = "medium",
): Thread {
  const options = createThreadOptions(config, model, modelReasoningEffort);
  return threadId
    ? codex.resumeThread(threadId, options)
    : codex.startThread(options);
}
