import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { CodexProjectProgressSummarizer } from "../application/projectProgressAgentSummarizer.js";
import { syncProjectProgress } from "../application/syncProjectProgress.js";
import { loadProjectProgressConfig } from "../config/projectProgressConfig.js";
import { GitHubRestProjectReader } from "../infrastructure/github/githubClient.js";
import { GitHubRequestExecutor } from "../infrastructure/github/githubRequestExecutor.js";
import { ProjectProgressOaClient } from "../infrastructure/oa/projectProgressOaClient.js";
import { ProjectProgressStore } from "../infrastructure/persistence/projectProgressStore.js";
import { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import { OperationMetricsRecorder } from "../infrastructure/observability/operationMetrics.js";
import { parseProjectProgressOptions } from "./projectProgressOptions.js";

async function main(): Promise<void> {
  const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = path.resolve(agentRoot, "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(agentRoot, ".env"), override: true });
  const options = parseProjectProgressOptions(process.argv.slice(2));
  const config = loadProjectProgressConfig(process.env, repoRoot, {
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    modelParameters: options.modelParameters,
  });
  if (
    options.writeMode === "unsafe-test" &&
    config.writeAuthorization !== "unsafe-test"
  ) {
    throw new Error(
      "--apply-test 需要 PROJECT_PROGRESS_WRITE_ENABLED=true 和测试写入确认变量。",
    );
  }
  if (
    options.writeMode === "production" &&
    config.writeAuthorization !== "production"
  ) {
    throw new Error(
      "--apply 需要 PROJECT_PROGRESS_WRITE_ENABLED=true 和生产写入确认变量。",
    );
  }
  const store = new ProjectProgressStore(config.stateDatabasePath);
  const operationMetrics = new OperationMetricsRecorder();
  const githubRequestLimiter = new AsyncSemaphore(config.concurrency.github);
  const githubRequestExecutor = new GitHubRequestExecutor({
    requestLimiter: githubRequestLimiter,
    maxRequestsPerRun: config.githubLimits.maxRequestsPerRun,
    maxRequestsPerRepository: config.githubLimits.maxRequestsPerRepository,
  });

  try {
    const report = await syncProjectProgress({
      observedAt: options.observedAt ?? new Date(),
      oaClient: new ProjectProgressOaClient(config.oa, fetch, operationMetrics),
      githubReader: new GitHubRestProjectReader(
        config.githubToken,
        fetch,
        config.githubApiBaseUrl,
        undefined,
        githubRequestLimiter,
        operationMetrics,
        {
          requestExecutor: githubRequestExecutor,
          maxBranches: config.githubLimits.maxBranches,
          maxCommitPagesPerBranch: config.githubLimits.maxCommitPagesPerBranch,
        },
      ),
      summarizer: new CodexProjectProgressSummarizer({
        model: config.model,
        githubToken: config.githubToken,
        githubApiBaseUrl: config.githubApiBaseUrl,
        agent: config.agent,
        workingDirectory: repoRoot,
        workspaceRoot: config.workspaceRoot,
        runId: `manual-${Date.now()}`,
        githubRequestLimiter,
        githubRequestExecutor,
        operationMetrics,
      }),
      store,
      writeMode: options.writeMode,
      concurrency: config.concurrency,
      githubRequestLimiter,
      operationMetrics,
      projectDetailCompatibilityMode: config.oa.projectDetailCompatibilityMode,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    });
    console.log(JSON.stringify({
      ...report,
      model: {
        model_provider: config.model.provider,
        model_id: config.model.model,
        model_parameters: config.model.parameters,
      },
    }, null, 2));
    if (options.writeMode === "production" && report.retryRecommended) {
      console.error("项目进度同步存在可重试失败，将由调度器重试。");
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`项目进度同步失败:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
