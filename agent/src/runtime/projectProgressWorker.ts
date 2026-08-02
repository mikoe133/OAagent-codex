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
import { ProjectProgressStore } from "../infrastructure/persistence/projectProgressStore.js";

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

  const runOnce = () => runProjectProgressAutomation({
    automationClient: new AutomationOaClient({
      baseUrl: baseConfig.oa.baseUrl,
      token: automationToken,
    }),
    workerInstance: baseConfig.automation.workerInstance,
    leaseSeconds: baseConfig.automation.leaseSeconds,
    heartbeatSeconds: baseConfig.automation.heartbeatSeconds,
    resolveExecution: async (claim) => {
      const config = loadProjectProgressConfig(process.env, repoRoot, {
        modelProvider: claim.modelProvider,
        modelId: claim.modelId,
        modelParameters: claim.modelParameters,
      });
      return async (shouldCancel) => {
        const store = new ProjectProgressStore(config.stateDatabasePath);
        try {
          return await syncProjectProgress({
            observedAt: new Date(claim.scheduledAt),
            oaClient: new ProjectProgressOaClient(config.oa),
            githubReader: new GitHubRestProjectReader(
              config.githubToken,
              fetch,
              config.githubApiBaseUrl,
            ),
            summarizer: new CodexProjectProgressSummarizer({
              model: config.model,
              githubToken: config.githubToken,
              githubApiBaseUrl: config.githubApiBaseUrl,
              agent: config.agent,
              workingDirectory: repoRoot,
            }),
            store,
            writeMode: "production",
            shouldCancel,
          });
        } finally {
          store.close();
        }
      };
    },
  });

  const runOnceOnly = process.argv.slice(2).includes("--once");
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  do {
    try {
      const result = await runOnce();
      if (result.claimed || runOnceOnly) {
        logResult(result);
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
}

function logResult(result: Awaited<ReturnType<typeof runProjectProgressAutomation>>): void {
  console.log(JSON.stringify({
    claimed: result.claimed,
    run_id: result.runId,
    status: result.status,
    projects_total: result.report?.projects.length ?? 0,
    mutations_applied: result.report?.mutationsApplied ?? 0,
    retry_recommended: result.report?.retryRecommended ?? false,
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
