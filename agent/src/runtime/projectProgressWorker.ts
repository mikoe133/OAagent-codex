import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { runProjectProgressAutomation } from "../application/runProjectProgressAutomation.js";
import { syncWeeklyReportProjectSummaries } from "../application/weeklyReportProjectSummarySync.js";
import { CodexWeeklyReportProjectSummaryAgent } from "../application/weeklyReportAgentSummarizer.js";
import { CodexProjectProgressSummarizer } from "../application/projectProgressAgentSummarizer.js";
import {
  resolveProjectProgressAutomationParameters,
  splitWeeklyReportAutomationModelParameters,
} from "../application/projectProgressAutomationParameters.js";
import {
  projectProgressExecutionPolicy,
  syncProjectProgress,
} from "../application/syncProjectProgress.js";
import { loadProjectProgressConfig } from "../config/projectProgressConfig.js";
import { GitHubRestProjectReader } from "../infrastructure/github/githubClient.js";
import { GitHubRequestExecutor } from "../infrastructure/github/githubRequestExecutor.js";
import { AutomationOaClient, SUPPORTED_JOB_TYPES } from "../infrastructure/oa/automationOaClient.js";
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
      const automationRequestScheduler = new OaRequestScheduler();
      const projectOaRequestScheduler = new OaRequestScheduler({
        totalConcurrency: Math.max(4, baseConfig.concurrency.oaWrite),
        laneConcurrency: { p1: baseConfig.concurrency.oaWrite },
      });
      const heartbeatLimiter = new AsyncSemaphore(1);
      const automationClient = new AutomationOaClient({
        baseUrl: baseConfig.automation.baseUrl,
        token: automationToken,
      }, fetch, operationMetrics, {
        scheduler: automationRequestScheduler,
        heartbeatLimiter,
      });
      const result = await runProjectProgressAutomation({
        automationClient,
        workerInstance: baseConfig.automation.workerInstance,
        leaseSeconds: baseConfig.automation.leaseSeconds,
        heartbeatSeconds: baseConfig.automation.heartbeatSeconds,
        supportedJobTypes: [...SUPPORTED_JOB_TYPES],
        claimIdentityStore: store,
        traceSpool: store,
        resolveExecution: async (claim) => {
          const executionPolicy = projectProgressExecutionPolicy(claim.triggerSource);
          const automationParameters = claim.jobType === "weekly_report_project_summary_sync"
            ? null
            : resolveProjectProgressAutomationParameters(
                claim.modelParameters,
                claim.executionParameters,
              );
          const automationModelParameters = automationParameters?.modelParameters ??
            splitWeeklyReportAutomationModelParameters(claim.modelParameters);
          const config = loadProjectProgressConfig(process.env, repoRoot, {
            modelProvider: claim.modelProvider,
            modelId: claim.modelId,
            modelParameters: automationModelParameters,
          });
          if (config.stateDatabasePath !== baseConfig.stateDatabasePath) {
            throw new Error("运行期间 PROJECT_PROGRESS_STATE_DB 不允许变化。");
          }
          const githubRequestLimiter = new AsyncSemaphore(config.concurrency.github);
          const githubRequestExecutor = new GitHubRequestExecutor({
            requestLimiter: githubRequestLimiter,
            maxConcurrentRequestsPerRepository: config.concurrency.github,
            maxRequestsPerRun: config.githubLimits.maxRequestsPerRun,
            maxRequestsPerRepository: config.githubLimits.maxRequestsPerRepository,
          });
          const projectOaClient = new ProjectProgressOaClient(
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
            { scheduler: projectOaRequestScheduler },
          );
          if (claim.jobType === "weekly_report_project_summary_sync") {
            const weeklyParameters = claim.modelParameters as Record<string, unknown>;
            const weeklyReportAgent = new CodexWeeklyReportProjectSummaryAgent({
              model: config.model,
              workingDirectory: repoRoot,
              runId: claim.runId,
              ...(claim.modelCatalogVersion
                ? { modelCatalogVersion: claim.modelCatalogVersion }
                : {}),
              promptProfile: claim.promptProfile
                ? {
                    promptVersion: claim.promptProfile.promptVersion,
                    systemPrompt: claim.promptProfile.systemPrompt,
                  }
                : null,
            });
            return async (shouldCancel, trace) => {
              await trace?.({
                eventKey: "weekly_report_source",
                sequence: 300,
                phase: "load_weekly_report",
                status: "running",
                title: "读取周报快照",
                message: "正在读取周报当前版本",
              });
              const source = await (async () => {
                try {
                  const snapshot = claim.sourceSnapshot;
                  const source = snapshot && typeof snapshot.source_report_id === "string" &&
                    typeof snapshot.source_version === "number" &&
                    typeof snapshot.weekly_num === "number" &&
                    typeof snapshot.updated_at === "string" &&
                    typeof snapshot.content === "string"
                    ? {
                        id: snapshot.source_report_id,
                        weeklyNum: snapshot.weekly_num,
                        content: snapshot.content,
                        version: snapshot.source_version,
                        updatedAt: snapshot.updated_at,
                        ownerId: null,
                      }
                    : snapshot && typeof snapshot.source_report_id === "string"
                      ? await projectOaClient.getWeeklyReport(snapshot.source_report_id).then((current) => {
                          if (current.version !== snapshot.source_version) {
                            throw new Error(
                              `周报源版本已推进:${snapshot.source_version}->${current.version}`,
                            );
                          }
                          return current;
                        })
                      : null;
                  if (!source) {
                    throw new Error("事件缺少可读取的周报源快照。");
                  }
                  return source;
                } catch (error) {
                  await trace?.({
                    eventKey: "weekly_report_source",
                    sequence: 300,
                    phase: "load_weekly_report",
                    status: "failed",
                    title: "读取周报快照",
                    message: safeTraceError(error, "读取周报失败"),
                  });
                  throw error;
                }
              })();
              await trace?.({
                eventKey: "weekly_report_projects",
                sequence: 400,
                phase: "load_projects",
                status: "running",
                title: "读取项目目录",
                message: "正在读取项目目录",
              });
              const projects = await (async () => {
                try {
                  return await projectOaClient.listProjects();
                } catch (error) {
                  await trace?.({
                    eventKey: "weekly_report_projects",
                    sequence: 400,
                    phase: "load_projects",
                    status: "failed",
                    title: "读取项目目录",
                    message: safeTraceError(error, "读取项目目录失败"),
                  });
                  throw error;
                }
              })();
              return syncWeeklyReportProjectSummaries({
                report: source,
                projects,
                oaClient: projectOaClient,
                includeArchivedProjects: true,
                writeArchivedProjects: true,
                minimumConfidence: typeof weeklyParameters.minimum_confidence === "number"
                  ? weeklyParameters.minimum_confidence
                  : 0.8,
                shouldCancel,
                summarizer: weeklyReportAgent,
                pendingItemSink: async (items) => {
                  for (let offset = 0; offset < items.length; offset += 100) {
                    await automationClient.upsertWeeklyReportPendingItems({
                      claim,
                      workerInstance: baseConfig.automation.workerInstance,
                      items: items.slice(offset, offset + 100),
                    });
                  }
                },
                summaryBindingStore: {
                  findBinding: async ({ projectId, summaryDate }) =>
                    automationClient.getWeeklyReportSummaryBinding({
                      claim,
                      workerInstance: baseConfig.automation.workerInstance,
                      projectId,
                      summaryDate,
                    }),
                  saveBinding: async ({
                    projectId,
                    summaryDate,
                    commitSummaryId,
                  }) => automationClient.saveWeeklyReportSummaryBinding({
                    claim,
                    workerInstance: baseConfig.automation.workerInstance,
                    projectId,
                    summaryDate,
                    commitSummaryId,
                  }),
                },
                trace,
                oaWriteConcurrency: config.concurrency.oaWrite,
              });
            };
          }
          if (!automationParameters) {
            throw new Error("GitHub 项目进度任务缺少自动化参数。");
          }
          return async (shouldCancel, trace) => {
            return await syncProjectProgress({
              observedAt: new Date(claim.scheduledAt),
              oaClient: projectOaClient,
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
                  maxCommitPagesPerBranch:
                    config.githubLimits.maxCommitPagesPerBranch,
                  commitSelection: automationParameters.summaryScope ===
                      "latest_commit_of_updating_projects"
                    ? "latest"
                    : "lookback",
                },
              ),
              summarizer: new CodexProjectProgressSummarizer({
                model: config.model,
                githubToken: config.githubToken,
                githubApiBaseUrl: config.githubApiBaseUrl,
                agent: config.agent,
                workingDirectory: repoRoot,
                workspaceRoot: config.workspaceRoot,
                runId: claim.runId,
                ...(claim.modelCatalogVersion
                  ? { modelCatalogVersion: claim.modelCatalogVersion }
                  : {}),
                repositorySummaryCache: store,
                bypassRepositorySummaryCacheRead:
                  executionPolicy.forceRegenerateSummaries,
                githubRequestLimiter,
                githubRequestExecutor,
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
              ...(automationParameters.projectId === undefined
                ? {}
                : { projectId: automationParameters.projectId }),
              summaryScope: automationParameters.summaryScope,
              ...executionPolicy,
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

function safeTraceError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sessionid=[^\s;]+/gi, "sessionid=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
}

main().catch((error: unknown) => {
  console.error(
    `项目进度 Worker 失败:${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
