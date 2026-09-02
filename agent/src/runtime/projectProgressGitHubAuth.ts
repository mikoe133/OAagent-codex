import { readFile } from "node:fs/promises";
import type { ProjectProgressConfig } from "../config/projectProgressConfig.js";
import { createGitHubAppAuth, type GitHubRequestAuth } from "../infrastructure/github/githubAppAuth.js";
import type { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import type { GitHubRequestExecutor } from "../infrastructure/github/githubRequestExecutor.js";
import type { OperationMetricsRecorder } from "../infrastructure/observability/operationMetrics.js";

export async function createProjectProgressGitHubAuth(input: {
  config: ProjectProgressConfig;
  requestLimiter?: AsyncSemaphore;
  requestExecutor?: GitHubRequestExecutor;
  operationMetrics?: OperationMetricsRecorder;
  signal?: AbortSignal;
}): Promise<GitHubRequestAuth> {
  const privateKey = await readFile(
    input.config.githubAuth.privateKeyPath,
    "utf8",
  );
  return createGitHubAppAuth({
    appId: input.config.githubAuth.appId,
    privateKey,
    apiBaseUrl: input.config.githubApiBaseUrl,
    ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
    ...(input.requestExecutor ? { requestExecutor: input.requestExecutor } : {}),
    ...(input.operationMetrics ? { operationMetrics: input.operationMetrics } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
