import { createHash } from "node:crypto";
import type {
  AutomationJobClaim,
  AutomationOaClient,
  AutomationRunProjectInput,
} from "../infrastructure/oa/automationOaClient.js";
import {
  AutomationLeaseLostError,
  AutomationOaRequestError,
} from "../infrastructure/oa/automationOaClient.js";
import type {
  ProjectProgressProjectReport,
  ProjectProgressSyncReport,
  ProjectProgressSummaryProposal,
} from "./syncProjectProgress.js";

export class ProjectProgressConfigurationError extends Error {
  override name = "ProjectProgressConfigurationError";
}

const SUPPORTED_PROMPT_CAPABILITIES = new Set([
  "github_project_tracking",
  "rwkvos_system_calls",
]);

export type ProjectProgressAutomationResult = {
  claimed: boolean;
  runId: string | null;
  status: "idle" | "succeeded" | "partial_failed" | "failed" | "configuration_error" | "cancelled";
  report: ProjectProgressSyncReport | null;
};

export async function runProjectProgressAutomation(input: {
  automationClient: AutomationOaClient;
  workerInstance: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  resolveExecution: (
    claim: AutomationJobClaim,
  ) => Promise<(shouldCancel: () => boolean) => Promise<ProjectProgressSyncReport>>;
}): Promise<ProjectProgressAutomationResult> {
  const claim = await input.automationClient.claim(
    input.workerInstance,
    input.leaseSeconds,
  );
  if (!claim) {
    return { claimed: false, runId: null, status: "idle", report: null };
  }

  let execute: (shouldCancel: () => boolean) => Promise<ProjectProgressSyncReport>;
  try {
    validateClaim(claim);
    execute = await input.resolveExecution(claim);
  } catch (error) {
    const summary = safeErrorSummary(error);
    await input.automationClient.updateRun({
      claim,
      workerInstance: input.workerInstance,
      status: "configuration_error",
      mutationsApplied: false,
      retryRecommended: false,
      errorCode: "worker_configuration_error",
      errorSummary: summary,
    });
    return {
      claimed: true,
      runId: claim.runId,
      status: "configuration_error",
      report: null,
    };
  }

  await input.automationClient.updateRun({
    claim,
    workerInstance: input.workerInstance,
    status: "running",
  });
  const heartbeat = new HeartbeatController({
    automationClient: input.automationClient,
    claim,
    workerInstance: input.workerInstance,
    leaseSeconds: input.leaseSeconds,
    intervalSeconds: input.heartbeatSeconds,
  });
  heartbeat.start();

  try {
    const startedAt = new Date();
    const report = await execute(() => heartbeat.shouldStop());
    heartbeat.assertLease();

    for (const project of report.projects) {
      heartbeat.assertLease();
      const finishedAt = new Date();
      const projectResult = buildProjectResult(
        project,
        startedAt,
        finishedAt,
      );
      const runProjectId = await input.automationClient.upsertProjectResult({
        claim,
        workerInstance: input.workerInstance,
        projectId: project.projectId,
        result: projectResult,
      });
      for (const summary of project.summaries) {
        const interactions = summary.repositoryInteractions?.length
          ? summary.repositoryInteractions
          : summary.interaction
            ? [{ repositoryKey: null, interaction: summary.interaction }]
            : [];
        for (const repositoryInteraction of interactions) {
          const interaction = repositoryInteraction.interaction;
          const promptVersion = claim.promptProfile?.promptVersion ??
            interaction.promptVersion;
          const systemPromptSnapshot = claim.promptProfile?.systemPrompt ??
            interaction.systemPromptSnapshot;
          await input.automationClient.upsertAiInteraction({
            claim,
            workerInstance: input.workerInstance,
            interaction: {
              runProjectId,
              interactionKey: interactionKey(
                project.projectId,
                summary,
                repositoryInteraction.repositoryKey,
              ),
              provider: interaction.provider,
              model: interaction.model,
              modelCatalogVersion: claim.modelCatalogVersion,
              promptVersion,
              systemPromptSnapshot,
              requestPayloadSanitized: {
                ...interaction.requestPayloadSanitized,
                ...(repositoryInteraction.repositoryKey
                  ? {
                    repository_full_name: repositoryInteraction.repositoryKey,
                    summary_date: summary.summaryDate,
                  }
                  : {}),
              },
              responsePayloadSanitized: interaction.responsePayloadSanitized,
              finalSummary: interaction.finalSummary,
              limitations: interaction.limitations.map((message) => ({ message })),
              fallbackUsed: interaction.fallbackUsed,
              upstreamRequestId: interaction.upstreamRequestId,
              inputTokens: interaction.inputTokens,
              outputTokens: interaction.outputTokens,
              latencyMs: interaction.latencyMs,
              status: interaction.status,
              errorCode: interaction.errorCode,
              errorSummary: interaction.errorSummary,
            },
          });
        }
      }
    }

    await heartbeat.stop();
    heartbeat.assertLease();
    const terminal = resolveTerminal(report, heartbeat.cancelRequested);
    await input.automationClient.updateRun({
      claim,
      workerInstance: input.workerInstance,
      status: terminal.status,
      mutationsApplied: report.mutationsApplied > 0,
      retryRecommended: terminal.retryRecommended,
      errorCode: terminal.errorCode,
      errorSummary: terminal.errorSummary,
    });
    return {
      claimed: true,
      runId: claim.runId,
      status: terminal.status,
      report,
    };
  } catch (error) {
    await heartbeat.stop();
    if (error instanceof AutomationLeaseLostError || heartbeat.leaseLost) {
      throw error;
    }
    const retryRecommended = isRetryable(error);
    await input.automationClient.updateRun({
      claim,
      workerInstance: input.workerInstance,
      status: heartbeat.cancelRequested ? "cancelled" : "failed",
      mutationsApplied: false,
      retryRecommended: heartbeat.cancelRequested ? false : retryRecommended,
      errorCode: heartbeat.cancelRequested
        ? "cancel_requested"
        : "worker_execution_failed",
      errorSummary: safeErrorSummary(error),
    });
    return {
      claimed: true,
      runId: claim.runId,
      status: heartbeat.cancelRequested ? "cancelled" : "failed",
      report: null,
    };
  }
}

function validateClaim(claim: AutomationJobClaim): void {
  if (claim.jobType !== "github_project_progress_sync") {
    throw new ProjectProgressConfigurationError(`不支持的任务类型:${claim.jobType}`);
  }
  if (claim.timezone !== "Asia/Shanghai") {
    throw new ProjectProgressConfigurationError(`不支持的任务时区:${claim.timezone}`);
  }
  if (Date.parse(claim.deadlineAt) <= Date.now()) {
    throw new ProjectProgressConfigurationError("任务 deadline 已过期。");
  }
  if (claim.cancelRequested) {
    throw new ProjectProgressConfigurationError("任务在 claim 时已请求取消。");
  }
  const unsupportedCapabilities = claim.promptProfile?.requiredCapabilities.filter(
    (capability) => !SUPPORTED_PROMPT_CAPABILITIES.has(capability),
  ) ?? [];
  if (unsupportedCapabilities.length > 0) {
    throw new ProjectProgressConfigurationError(
      `任务提示词要求不支持的能力:${unsupportedCapabilities.join(",")}`,
    );
  }
}

function buildProjectResult(
  project: ProjectProgressProjectReport,
  startedAt: Date,
  finishedAt: Date,
): AutomationRunProjectInput {
  const summary = project.summaries.at(-1) ?? null;
  return {
    projectNameSnapshot: project.projectName,
    statusBefore: project.currentStatus,
    statusAfter: project.targetStatus,
    outcome: mapProjectOutcome(project),
    repositoryCount: project.repositoryCount ?? 0,
    commitCount: project.commitCount ??
      project.summaries.reduce((total, item) => total + item.commitCount, 0),
    summaryDate: summary?.summaryDate ?? null,
    sourceDigest: summary ? `sha256:${summary.sourceDigest}` : null,
    generatedSummary: summary?.summary ?? null,
    aiConfidence: summary?.aiConfidence ?? null,
    aiNote: summary?.aiNote ?? null,
    warnings: project.warnings.map((code) => ({ code: code.slice(0, 1_000) })),
    mutationsApplied: (project.mutationsApplied ?? 0) > 0,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

function mapProjectOutcome(
  project: ProjectProgressProjectReport,
): AutomationRunProjectInput["outcome"] {
  if (project.warnings.some(isWriteConflictWarning)) {
    return "write_conflict";
  }
  return project.outcome;
}

function isWriteConflictWarning(warning: string): boolean {
  return warning.startsWith("summary_conflict:") ||
    warning.startsWith("summary_unmanaged:") ||
    warning.startsWith("summary_external_edit:") ||
    warning.startsWith("write_cancelled:");
}

function interactionKey(
  projectId: number,
  summary: ProjectProgressSummaryProposal,
  repositoryKey: string | null,
): string {
  const repositorySuffix = repositoryKey
    ? `-${createHash("sha256").update(repositoryKey).digest("hex").slice(0, 16)}`
    : "";
  return `project-${projectId}-${summary.summaryDate}-${summary.sourceDigest.slice(0, 32)}${repositorySuffix}`;
}

function resolveTerminal(
  report: ProjectProgressSyncReport,
  cancelRequested: boolean,
): {
  status: "succeeded" | "partial_failed" | "failed" | "cancelled";
  retryRecommended: boolean;
  errorCode: string | null;
  errorSummary: string | null;
} {
  if (cancelRequested || report.cancelled) {
    return {
      status: "cancelled",
      retryRecommended: false,
      errorCode: "cancel_requested",
      errorSummary: "任务已按取消请求停止。",
    };
  }
  const failed = report.projects.filter((project) =>
    mapProjectOutcome(project) === "invalid_github_urls" ||
    mapProjectOutcome(project) === "incomplete" ||
    mapProjectOutcome(project) === "write_conflict" ||
    mapProjectOutcome(project) === "failed"
  ).length;
  if (failed === 0) {
    return {
      status: "succeeded",
      retryRecommended: false,
      errorCode: null,
      errorSummary: null,
    };
  }
  const status = failed === report.projects.length ? "failed" : "partial_failed";
  return {
    status,
    retryRecommended: report.retryRecommended,
    errorCode: status === "failed"
      ? "project_processing_failed"
      : "project_processing_partial_failed",
    errorSummary: `${report.projects.length} 个项目中 ${failed} 个处理失败。`,
  };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AutomationOaRequestError) {
    return error.status >= 500;
  }
  return error instanceof TypeError ||
    (error instanceof Error && /timeout|timed out|fetch failed/i.test(error.message));
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Worker 执行失败";
  return message
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sessionid=[^\s;]+/gi, "sessionid=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 1_000);
}

class HeartbeatController {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private error: unknown = null;
  cancelRequested = false;
  leaseLost = false;

  constructor(private readonly input: {
    automationClient: AutomationOaClient;
    claim: AutomationJobClaim;
    workerInstance: string;
    leaseSeconds: number;
    intervalSeconds: number;
  }) {}

  start(): void {
    this.timer = setInterval(() => {
      if (!this.inFlight) {
        this.inFlight = this.send().finally(() => {
          this.inFlight = null;
        });
      }
    }, this.input.intervalSeconds * 1_000);
  }

  shouldStop(): boolean {
    return this.cancelRequested || this.error !== null;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  assertLease(): void {
    if (this.error) {
      throw this.error;
    }
  }

  private async send(): Promise<void> {
    try {
      const heartbeat = await this.input.automationClient.heartbeat({
        claim: this.input.claim,
        workerInstance: this.input.workerInstance,
        leaseSeconds: this.input.leaseSeconds,
      });
      this.cancelRequested ||= heartbeat.cancelRequested;
    } catch (error) {
      this.error = error;
      this.leaseLost = error instanceof AutomationLeaseLostError;
    }
  }
}
