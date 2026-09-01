import { performance } from "node:perf_hooks";

export const PROJECT_PROGRESS_ENDPOINTS = {
  oaAutomationClaim: "oa.automation.claim",
  oaAutomationHeartbeat: "oa.automation.heartbeat",
  oaAutomationRunUpdate: "oa.automation.run.update",
  oaAutomationRunProjectUpsert: "oa.automation.run-project.upsert",
  oaAutomationAiInteractionUpsert: "oa.automation.ai-interaction.upsert",
  oaAutomationWeeklyReportPendingItemsUpsert:
    "oa.automation.weekly-report-pending-items.upsert",
  oaAutomationWeeklyReportSummaryBindingGet:
    "oa.automation.weekly-report-summary-binding.get",
  oaAutomationWeeklyReportSummaryBindingSave:
    "oa.automation.weekly-report-summary-binding.save",
  oaAutomationTraceUpsert: "oa.automation.trace.upsert",
  oaProjectList: "oa.project.list",
  oaProjectGet: "oa.project.get",
  oaProjectStatusUpdate: "oa.project.status.update",
  oaSummaryList: "oa.summary.list",
  oaSummaryGet: "oa.summary.get",
  oaSummaryCreate: "oa.summary.create",
  oaSummaryUpdate: "oa.summary.update",
  oaWeeklyReportGet: "oa.weekly-report.get",
  githubRepositoryGet: "github.repository.get",
  githubBranchesList: "github.branches.list",
  githubCommitsList: "github.commits.list",
  githubCommitGet: "github.commit.get",
  modelProjectProgressSummarize: "model.project-progress.summarize",
} as const;

export type DistributionSnapshot = {
  count: number;
  min: number;
  max: number;
  average: number;
  p50: number;
  p95: number;
};

export type OperationMetricSnapshot = {
  endpoint: string;
  requests: number;
  successes: number;
  failures: number;
  durationMs: DistributionSnapshot | null;
  queueWaitMs: DistributionSnapshot | null;
};

type EndpointMetrics = {
  requests: number;
  successes: number;
  failures: number;
  durations: number[];
  queueWaits: number[];
};

export class OperationMetricsRecorder {
  private readonly endpoints = new Map<string, EndpointMetrics>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  async measure<T>(endpoint: string, operation: () => Promise<T>): Promise<T> {
    const metrics = this.getEndpoint(endpoint);
    const startedAt = this.now();
    metrics.requests += 1;
    try {
      const result = await operation();
      metrics.successes += 1;
      return result;
    } catch (error) {
      metrics.failures += 1;
      throw error;
    } finally {
      metrics.durations.push(elapsedMilliseconds(startedAt, this.now()));
    }
  }

  startQueueWait(endpoint: string): () => void {
    const metrics = this.getEndpoint(endpoint);
    const startedAt = this.now();
    let recorded = false;
    return () => {
      if (recorded) {
        return;
      }
      recorded = true;
      metrics.queueWaits.push(elapsedMilliseconds(startedAt, this.now()));
    };
  }

  snapshot(): OperationMetricSnapshot[] {
    return [...this.endpoints.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([endpoint, metrics]) => ({
        endpoint,
        requests: metrics.requests,
        successes: metrics.successes,
        failures: metrics.failures,
        durationMs: distribution(metrics.durations),
        queueWaitMs: distribution(metrics.queueWaits),
      }));
  }

  private getEndpoint(endpoint: string): EndpointMetrics {
    assertStableEndpoint(endpoint);
    const existing = this.endpoints.get(endpoint);
    if (existing) {
      return existing;
    }
    const created: EndpointMetrics = {
      requests: 0,
      successes: 0,
      failures: 0,
      durations: [],
      queueWaits: [],
    };
    this.endpoints.set(endpoint, created);
    return created;
  }
}

function assertStableEndpoint(endpoint: string): void {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(endpoint)) {
    throw new Error(`指标 endpoint 必须是稳定的逻辑名称:${endpoint}`);
  }
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function distribution(values: number[]): DistributionSnapshot | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    average: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}
