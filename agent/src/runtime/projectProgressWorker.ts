import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { runProjectProgressAutomation } from "../application/runProjectProgressAutomation.js";
import { CodexProjectProgressSummarizer } from "../application/projectProgressAgentSummarizer.js";
import { syncProjectProgress } from "../application/syncProjectProgress.js";
import { loadProjectProgressConfig } from "../config/projectProgressConfig.js";
import { GitHubRestProjectReader } from "../infrastructure/github/githubClient.js";
import { AutomationOaClient } from "../infrastructure/oa/automationOaClient.js";
import { ProjectProgressOaClient } from "../infrastructure/oa/projectProgressOaClient.js";
import { OaRequestScheduler } from "../infrastructure/oa/oaRequestScheduler.js";
import { ProjectProgressStore } from "../infrastructure/persistence/projectProgressStore.js";
import { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import {
  OperationMetricsRecorder,
  type OperationMetricSnapshot,
} from "../infrastructure/observability/operationMetrics.js";

const WORKER_POLL_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  const agentRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const repoRoot = path.resolve(agentRoot, "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(agentRoot, ".env"), override: true });

  const baseConfig = loadProjectProgressConfig(process.env, repoRoot);
  const automationToken = baseConfig.automation.token;
  if (!automationToken) {
    throw new Error("缺少 OA_AGENT_AUTOMATION_TOKEN。");
  }
  if (baseConfig.writeAuthorization !== "production") {
    throw new Error(
      "Worker 需要 PROJECT_PROGRESS_WRITE_ENABLED=true 和生产写入确认变量。",
    );
  }
  if (baseConfig.automation.heartbeatSeconds >= baseConfig.automation.leaseSeconds) {
    throw new Error("PROJECT_PROGRESS_HEARTBEAT_SECONDS 必须小于租约秒数。");
  }

  const store = new ProjectProgressStore(baseConfig.stateDatabasePath);
  try {
    const runOnce = async () => {
      const operationMetrics = new OperationMetricsRecorder();
      const oaRequestScheduler = new OaRequestScheduler();
      const heartbeatLimiter = new AsyncSemaphore(1);
      const result = await runProjectProgressAutomation({
        automationClient: new AutomationOaClient({
          baseUrl: baseConfig.oa.baseUrl,
          token: automationToken,
        }, fetch, operationMetrics, {
          scheduler: oaRequestScheduler,
          heartbeatLimiter,
        }),
        workerInstance: baseConfig.automation.workerInstance,
        leaseSeconds: baseConfig.automation.leaseSeconds,
        heartbeatSeconds: baseConfig.automation.heartbeatSeconds,
        claimIdentityStore: store,
        traceSpool: store,
        resolveExecution: async (claim) => {
          const config = loadProjectProgressConfig(process.env, repoRoot, {
            modelProvider: claim.modelProvider,
            modelId: claim.modelId,
            modelParameters: claim.modelParameters,
          });
          if (config.stateDatabasePath !== baseConfig.stateDatabasePath) {
            throw new Error("运行期间 PROJECT_PROGRESS_STATE_DB 不允许变化。");
          }
          const githubRequestLimiter = new AsyncSemaphore(config.concurrency.github);
          return async (shouldCancel, trace) => {
            return await syncProjectProgress({
              observedAt: new Date(claim.scheduledAt),
              oaClient: new ProjectProgressOaClient(
                {
                  ...config.oa,
                  ...(claim.runMutationToken && claim.fencingToken
                    ? {
                        mutationContext: {
                          runId: claim.runId,
                          runMutationToken: claim.runMutationToken,
                          fencingToken: claim.fencingToken,
                        },
                      }
                    : {}),
                },
                fetch,
                operationMetrics,
                { scheduler: oaRequestScheduler },
              ),
              githubReader: new GitHubRestProjectReader(
                config.githubToken,
                fetch,
                config.githubApiBaseUrl,
                undefined,
                githubRequestLimiter,
                operationMetrics,
              ),
              summarizer: new CodexProjectProgressSummarizer({
                model: config.model,
                githubToken: config.githubToken,
                githubApiBaseUrl: config.githubApiBaseUrl,
                agent: config.agent,
                workingDirectory: repoRoot,
                workspaceRoot: config.workspaceRoot,
                runId: claim.runId,
                githubRequestLimiter,
                operationMetrics,
                promptProfile: claim.promptProfile,
              }),
              store,
              writeMode: "production",
              concurrency: config.concurrency,
              githubRequestLimiter,
              operationMetrics,
              projectDetailCompatibilityMode: config.oa.projectDetailCompatibilityMode,
              shouldCancel,
              trace,
            });
          };
        },
      });
      return { result, operationMetrics: operationMetrics.snapshot() };
    };

    const runOnceOnly = process.argv.slice(2).includes("--once");
    let stopRequested = false;
    const requestStop = () => {
      stopRequested = true;
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);

    do {
      try {
        const execution = await runOnce();
        const { result } = execution;
        if (result.claimed || runOnceOnly) {
          logResult(result, execution.operationMetrics);
        }
        if (!result.claimed && !runOnceOnly && !stopRequested) {
          await delay(WORKER_POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (runOnceOnly) {
          throw error;
        }
        console.error(
          `项目进度 Worker 本轮失败:${error instanceof Error ? error.message : String(error)}`,
        );
        if (!stopRequested) {
          await delay(WORKER_POLL_INTERVAL_MS);
        }
      }
    } while (!runOnceOnly && !stopRequested);
  } finally {
    store.close();
  }
}

function logResult(
  result: Awaited<ReturnType<typeof runProjectProgressAutomation>>,
  operationMetrics: OperationMetricSnapshot[],
): void {
  console.log(JSON.stringify({
    claimed: result.claimed,
    run_id: result.runId,
    status: result.status,
    projects_total: result.report?.projects.length ?? 0,
    mutations_applied: result.report?.mutationsApplied ?? 0,
    retry_recommended: result.report?.retryRecommended ?? false,
    repositories_discovered: result.report?.metrics.repositoriesDiscovered ?? 0,
    repositories_with_commits: result.report?.metrics.repositoriesWithCommits ?? 0,
    repository_tasks: result.report?.metrics.repositoryTasksTotal ?? 0,
    repository_tasks_succeeded: result.report?.metrics.repositoryTasksSucceeded ?? 0,
    repository_tasks_fallback: result.report?.metrics.repositoryTasksFallback ?? 0,
    repository_tasks_failed: result.report?.metrics.repositoryTasksFailed ?? 0,
    agent_peak_concurrency: result.report?.metrics.agentPeakConcurrency ?? 0,
    github_peak_concurrency: result.report?.metrics.githubPeakConcurrency ?? 0,
    oa_write_peak_concurrency: result.report?.metrics.oaWritePeakConcurrency ?? 0,
    operation_metrics: operationMetrics,
  }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  console.error(
    `项目进度 Worker 失败:${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
