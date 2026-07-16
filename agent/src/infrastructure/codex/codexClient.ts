import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type { AppConfig } from "../../config/config.js";

/**
 * codex 子进程只拿到运行必需的变量。.env 中的其余凭证
 * (OA session、client keys 等)不进入子进程环境,也就不会被
 * agent 的 printenv/shell 命令读到。
 */
function buildChildEnv(
  config: AppConfig,
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
  env.NEXTTOKEN_API_KEY = config.modelApiKey;
  env.CALL_OA_API_URL = `http://127.0.0.1:${config.serverPort}/__internal/call-oa-api`;
  env.CALL_OA_API_TOKEN = config.oaApiToolToken;
  if (toolSessionId) {
    env.CALL_OA_API_SESSION_ID = toolSessionId;
  }
  return env;
}

export function createCodexClient(
  config: AppConfig,
  toolSessionId?: string,
): Codex {
  return new Codex({
    env: buildChildEnv(config, toolSessionId),
    config: {
      model_provider: config.modelProvider,
      model_providers: {
        [config.modelProvider]: {
          name: "Nexttoken",
          base_url: config.modelBaseUrl,
          env_key: "NEXTTOKEN_API_KEY",
          wire_api: "responses",
        },
      },
    },
  });
}

export function createThreadOptions(
  config: AppConfig,
  model: string = config.model,
): ThreadOptions {
  const oaToolEnabled = Boolean(config.oaApiBaseUrl);
  return {
    model,
    sandboxMode: oaToolEnabled ? "workspace-write" : "read-only",
    workingDirectory: config.projectRoot,
    skipGitRepoCheck: true,
    networkAccessEnabled: oaToolEnabled,
    webSearchMode: "disabled",
  };
}

export function startOrResumeThread(
  codex: Codex,
  config: AppConfig,
  threadId: string | null,
  model: string = config.model,
): Thread {
  const options = createThreadOptions(config, model);
  return threadId
    ? codex.resumeThread(threadId, options)
    : codex.startThread(options);
}
