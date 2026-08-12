import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { syncProjectProgress } from "../application/syncProjectProgress.js";
import { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import { GitHubRestProjectReader } from "../infrastructure/github/githubClient.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
  type DistributionSnapshot,
} from "../infrastructure/observability/operationMetrics.js";
import { ProjectProgressOaClient } from "../infrastructure/oa/projectProgressOaClient.js";

const PROJECT_COUNT = 100;
const REPOSITORY_COUNT = 50;
const AGENT_TASK_COUNT = 20;
const OBSERVED_AT = new Date("2026-08-07T12:00:00.000Z");

export type ProjectProgressBaseline = {
  scenario: {
    projects: number;
    repositories: number;
    agentTasks: number;
  };
  durationMs: number;
  memory: {
    rssStartBytes: number;
    rssPeakBytes: number;
    rssDeltaBytes: number;
  };
  requestCounts: Record<string, number>;
  agentQueueWait: DistributionSnapshot;
  report: Awaited<ReturnType<typeof syncProjectProgress>>;
};

export async function runProjectProgressBaseline(): Promise<ProjectProgressBaseline> {
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => {
    const id = index + 1;
    const repositoryId = (index % REPOSITORY_COUNT) + 1;
    return {
      id,
      project_name: `project-${id}`,
      status: "updating",
      github_urls: [`https://github.com/example/repository-${repositoryId}`],
    };
  });
  const server = createServer((request, response) => {
    void handleFakeRequest(request, response, projects).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: errorMessage(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const operationMetrics = new OperationMetricsRecorder();
  const githubRequestLimiter = new AsyncSemaphore(6);
  const rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes;
  const memorySampler = setInterval(() => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }, 2);
  memorySampler.unref();
  const startedAt = performance.now();

  try {
    const report = await syncProjectProgress({
      observedAt: OBSERVED_AT,
      operationMetrics,
      concurrency: { github: 6, agent: 2, oaWrite: 1 },
      oaClient: new ProjectProgressOaClient(
        {
          baseUrl,
          alias: "baseline",
          token: "baseline-token",
          tokenHeader: "Authorization",
          tokenPrefix: "Bearer",
        },
        fetch,
        operationMetrics,
      ),
      githubReader: new GitHubRestProjectReader(
        "baseline-token",
        fetch,
        baseUrl,
        undefined,
        githubRequestLimiter,
        operationMetrics,
      ),
      githubRequestLimiter,
      summarizer: {
        summarize: async (input) => {
          await delay(2);
          return {
            summary: `${input.repositoryFullName} 完成基线变更。`,
            limitations: [],
          };
        },
      },
    });
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
    const durationMs = performance.now() - startedAt;
    const requestCounts = Object.fromEntries(
      operationMetrics.snapshot().map((metric) => [metric.endpoint, metric.requests]),
    );
    const agentQueueWait = operationMetrics.snapshot().find(
      (metric) => metric.endpoint === PROJECT_PROGRESS_ENDPOINTS.modelProjectProgressSummarize,
    )?.queueWaitMs;
    if (!agentQueueWait) {
      throw new Error("基线缺少 Agent 排队指标。");
    }
    return {
      scenario: {
        projects: PROJECT_COUNT,
        repositories: REPOSITORY_COUNT,
        agentTasks: AGENT_TASK_COUNT,
      },
      durationMs,
      memory: {
        rssStartBytes,
        rssPeakBytes,
        rssDeltaBytes: Math.max(0, rssPeakBytes - rssStartBytes),
      },
      requestCounts,
      agentQueueWait,
      report,
    };
  } finally {
    clearInterval(memorySampler);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function handleFakeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projects: Array<Record<string, unknown>>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  await delay(1);
  if (url.pathname === "/internal/project-sync/projects") {
    sendJson(response, { data: { total: projects.length, items: projects } });
    return;
  }
  const projectMatch = url.pathname.match(/^\/internal\/project-sync\/projects\/(\d+)$/);
  if (projectMatch) {
    const project = projects[Number(projectMatch[1]) - 1];
    sendJson(response, { data: project });
    return;
  }
  const repositoryMatch = url.pathname.match(/^\/repos\/example\/repository-(\d+)$/);
  if (repositoryMatch) {
    const repositoryId = Number(repositoryMatch[1]);
    sendJson(response, {
      id: repositoryId,
      full_name: `example/repository-${repositoryId}`,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    return;
  }
  const branchesMatch = url.pathname.match(
    /^\/repos\/example\/repository-(\d+)\/branches$/,
  );
  if (branchesMatch) {
    sendJson(response, [{ name: "main" }]);
    return;
  }
  const commitsMatch = url.pathname.match(
    /^\/repos\/example\/repository-(\d+)\/commits$/,
  );
  if (commitsMatch) {
    const repositoryId = Number(commitsMatch[1]);
    sendJson(response, repositoryId <= AGENT_TASK_COUNT ? [{
      sha: `sha-${repositoryId}`,
      commit: {
        message: `complete baseline change ${repositoryId}`,
        committer: { date: "2026-08-07T01:00:00.000Z" },
      },
    }] : []);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProjectProgressBaseline()
    .then((baseline) => console.log(JSON.stringify({
      scenario: baseline.scenario,
      durationMs: baseline.durationMs,
      memory: baseline.memory,
      requestCounts: baseline.requestCounts,
      agentQueueWait: baseline.agentQueueWait,
      concurrency: {
        githubPeak: baseline.report.metrics.githubPeakConcurrency,
        agentPeak: baseline.report.metrics.agentPeakConcurrency,
        oaWritePeak: baseline.report.metrics.oaWritePeakConcurrency,
      },
      operationMetrics: baseline.report.operationMetrics,
    }, null, 2)))
    .catch((error: unknown) => {
      console.error(`项目进度基线失败:${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
