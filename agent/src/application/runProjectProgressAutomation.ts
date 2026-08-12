import { createHash } from "node:crypto";
import type {
  AutomationJobClaim,
  AutomationOaClient,
  AutomationRunProjectInput,
  AutomationTraceEventInput,
} from "../infrastructure/oa/automationOaClient.js";
import {
  AutomationLeaseLostError,
  AutomationOaRequestError,
  SUPPORTED_JOB_TYPE,
} from "../infrastructure/oa/automationOaClient.js";
import { ProjectProgressLeaseLostError } from "../infrastructure/oa/projectProgressOaClient.js";
import {
  AutomationTraceDrainTimeoutError,
  BoundedAutomationTraceQueue,
  type AutomationTraceSpool,
} from "../infrastructure/oa/automationTraceQueue.js";
import type {
  ProjectProgressProjectReport,
  ProjectProgressSyncReport,
  ProjectProgressSummaryProposal,
  ProjectProgressTraceEvent,
  ProjectProgressTraceSink,
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

export type AutomationClaimIdentityStore = {
  getOrCreateAutomationClaimIdentity(input: {
    workerInstance: string;
    supportedJobTypes: string[];
    leaseSeconds: number;
  }): {
    claimRequestId: string;
    requestDigest: string;
  };
  clearAutomationClaimIdentity(claimRequestId: string): void;
};

export async function runProjectProgressAutomation(input: {
  automationClient: AutomationOaClient;
  workerInstance: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  claimIdentityStore?: AutomationClaimIdentityStore;
  traceSpool?: AutomationTraceSpool;
  resolveExecution: (
    claim: AutomationJobClaim,
  ) => Promise<(
    shouldCancel: () => boolean,
    trace?: ProjectProgressTraceSink,
  ) => Promise<ProjectProgressSyncReport>>;
}): Promise<ProjectProgressAutomationResult> {
  const claimIdentity = input.claimIdentityStore?.getOrCreateAutomationClaimIdentity({
    workerInstance: input.workerInstance,
    supportedJobTypes: [SUPPORTED_JOB_TYPE],
    leaseSeconds: input.leaseSeconds,
  });
  const claim = claimIdentity
    ? await input.automationClient.claim({
        workerInstance: input.workerInstance,
        leaseSeconds: input.leaseSeconds,
        claimRequestId: claimIdentity.claimRequestId,
      })
    : await input.automationClient.claim(
        input.workerInstance,
        input.leaseSeconds,
      );
  if (!claim) {
    clearClaimIdentity(input.claimIdentityStore, claimIdentity?.claimRequestId);
    return { claimed: false, runId: null, status: "idle", report: null };
  }
  const traceReporter = new AutomationTraceReporter({
    automationClient: input.automationClient,
    claim,
    workerInstance: input.workerInstance,
    ...(input.traceSpool ? { spool: input.traceSpool } : {}),
  });
  await traceReporter.publish({
    eventKey: "worker_claimed",
    sequence: 10,
    phase: "worker_claimed",
    status: "succeeded",
    title: "Worker 已领取任务",
    message: input.workerInstance,
  });

  let execute: (
    shouldCancel: () => boolean,
    trace?: ProjectProgressTraceSink,
  ) => Promise<ProjectProgressSyncReport>;
  try {
    validateClaim(claim);
    execute = await input.resolveExecution(claim);
  } catch (error) {
    const summary = safeErrorSummary(error);
    await traceReporter.publish({
      eventKey: "validate_configuration",
      sequence: 20,
      phase: "validate_configuration",
      status: "failed",
      title: "校验任务配置",
      message: summary,
    });
    await traceReporter.drain();
    await input.automationClient.updateRun({
      claim,
      workerInstance: input.workerInstance,
      status: "configuration_error",
      mutationsApplied: false,
      retryRecommended: false,
      errorCode: "worker_configuration_error",
      errorSummary: summary,
    });
    clearClaimIdentity(input.claimIdentityStore, claimIdentity?.claimRequestId);
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
  await traceReporter.publish({
    eventKey: "validate_configuration",
    sequence: 20,
    phase: "validate_configuration",
    status: "succeeded",
    title: "校验任务配置",
    message: `${claim.modelProvider}/${claim.modelId}`,
  });
  const heartbeat = new HeartbeatController({
    automationClient: input.automationClient,
    claim,
    workerInstance: input.workerInstance,
    leaseSeconds: input.leaseSeconds,
    intervalSeconds: input.heartbeatSeconds,
  });
  await heartbeat.start();
  heartbeat.assertLease();
  let terminalUpdateStarted = false;

  try {
    const startedAt = new Date();
    const report = await execute(
      () => heartbeat.shouldStop(),
      (event) => traceReporter.publish(event),
    );
    heartbeat.assertLease();

    await traceReporter.publish({
      eventKey: "upload_run_audit",
      sequence: 700,
      phase: "upload_run_audit",
      status: "running",
      title: "写入项目结果与 AI 审计",
      progressCurrent: 0,
      progressTotal: report.projects.length,
    });
    let uploadedProjects = 0;
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
      uploadedProjects += 1;
      await traceReporter.publish({
        eventKey: "upload_run_audit",
        sequence: 700,
        phase: "upload_run_audit",
        status: uploadedProjects === report.projects.length ? "succeeded" : "running",
        title: "写入项目结果与 AI 审计",
        message: `已上传 ${uploadedProjects}/${report.projects.length} 个项目`,
        progressCurrent: uploadedProjects,
        progressTotal: report.projects.length,
        projectId: project.projectId,
      });
    }
    if (report.projects.length === 0) {
      await traceReporter.publish({
        eventKey: "upload_run_audit",
        sequence: 700,
        phase: "upload_run_audit",
        status: "succeeded",
        title: "写入项目结果与 AI 审计",
        message: "没有需要上传的项目结果",
        progressCurrent: 0,
        progressTotal: 0,
      });
    }

    await heartbeat.stop();
    heartbeat.assertLease();
    const terminal = resolveTerminal(report, heartbeat.cancelRequested);
    await traceReporter.publish({
      eventKey: "finalize_run",
      sequence: 900,
      phase: "finalize_run",
      status: terminal.status === "cancelled"
        ? "cancelled"
        : terminal.status === "failed"
          ? "failed"
          : terminal.status === "partial_failed"
            ? "fallback"
            : "succeeded",
      title: "完成自动任务运行",
      message: terminal.errorSummary ?? "运行成功完成",
      metadataSanitized: {
        projects_total: report.projects.length,
        mutations_applied: report.mutationsApplied,
        retry_recommended: terminal.retryRecommended,
      },
    });
    await traceReporter.drain();
    terminalUpdateStarted = true;
    await input.automationClient.updateRun({
      claim,
      workerInstance: input.workerInstance,
      status: terminal.status,
      mutationsApplied: report.mutationsApplied > 0,
      retryRecommended: terminal.retryRecommended,
      errorCode: terminal.errorCode,
      errorSummary: terminal.errorSummary,
    });
    clearClaimIdentity(input.claimIdentityStore, claimIdentity?.claimRequestId);
    return {
      claimed: true,
      runId: claim.runId,
      status: terminal.status,
      report,
    };
  } catch (error) {
    await heartbeat.stop();
    if (
      error instanceof AutomationLeaseLostError ||
      error instanceof ProjectProgressLeaseLostError ||
      heartbeat.leaseLost
    ) {
      traceReporter.abort(error);
      throw error;
    }
    if (terminalUpdateStarted) {
      throw error;
    }
    const retryRecommended = false;
    await traceReporter.publish({
      eventKey: "finalize_run",
      sequence: 900,
      phase: "finalize_run",
      status: heartbeat.cancelRequested ? "cancelled" : "failed",
      title: "自动任务运行终止",
      message: heartbeat.cancelRequested
        ? "任务已按取消请求停止"
        : safeErrorSummary(error),
      metadataSanitized: { retry_recommended: retryRecommended },
    });
    await traceReporter.drain();
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
    clearClaimIdentity(input.claimIdentityStore, claimIdentity?.claimRequestId);
    return {
      claimed: true,
      runId: claim.runId,
      status: heartbeat.cancelRequested ? "cancelled" : "failed",
      report: null,
    };
  }
}

function clearClaimIdentity(
  store: AutomationClaimIdentityStore | undefined,
  claimRequestId: string | undefined,
): void {
  if (store && claimRequestId) {
    store.clearAutomationClaimIdentity(claimRequestId);
  }
}

class AutomationTraceReporter {
  private disabled = false;
  private consecutiveFailures = 0;
  private readonly deliveryController = new AbortController();
  private readonly queue: BoundedAutomationTraceQueue;

  constructor(private readonly input: {
    automationClient: AutomationOaClient;
    claim: AutomationJobClaim;
    workerInstance: string;
    spool?: AutomationTraceSpool;
  }) {
    this.queue = new BoundedAutomationTraceQueue({
      runId: input.claim.runId,
      deliver: (event, signal) => this.deliver(event, signal),
      signal: this.deliveryController.signal,
      ...(input.spool ? { spool: input.spool } : {}),
    });
  }

  async publish(event: ProjectProgressTraceEvent): Promise<void> {
    const payload: AutomationTraceEventInput = {
      eventKey: event.eventKey.slice(0, 200),
      sequence: event.sequence,
      phase: event.phase.slice(0, 100),
      status: event.status,
      title: event.title.slice(0, 200),
      message: event.message?.slice(0, 1_000) ?? null,
      progressCurrent: event.progressCurrent ?? null,
      progressTotal: event.progressTotal ?? null,
      projectId: event.projectId ?? null,
      repositoryFullName: event.repositoryFullName?.slice(0, 255) ?? null,
      metadataSanitized: event.metadataSanitized ?? {},
      occurredAt: new Date().toISOString(),
    };
    this.queue.tryEnqueue(payload);
  }

  async drain(): Promise<void> {
    try {
      await this.queue.drain({ timeoutMs: 3_000 });
    } catch (error) {
      if (!(error instanceof AutomationTraceDrainTimeoutError)) {
        throw error;
      }
      this.abort(error);
      try {
        await this.queue.drain({ timeoutMs: 100 });
      } catch (settleError) {
        if (!(settleError instanceof AutomationTraceDrainTimeoutError)) {
          throw settleError;
        }
      }
    }
  }

  abort(reason: unknown): void {
    if (!this.deliveryController.signal.aborted) {
      this.deliveryController.abort(reason);
    }
  }

  private async deliver(
    event: AutomationTraceEventInput,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.disabled) {
      return false;
    }
    try {
      await this.input.automationClient.upsertTraceEvent({
        claim: this.input.claim,
        workerInstance: this.input.workerInstance,
        event,
        ...(signal ? { signal } : {}),
      });
      this.consecutiveFailures = 0;
      return true;
    } catch (error) {
      if (error instanceof AutomationLeaseLostError) {
        throw error;
      }
      this.consecutiveFailures += 1;
      if (
        error instanceof AutomationOaRequestError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        this.disabled = true;
      } else if (this.consecutiveFailures >= 3) {
        this.disabled = true;
      }
      return false;
    }
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
  const summaryFailures = report.projects.filter((project) =>
    project.warnings.some(isSummaryRetryWarning)
  ).length;
  if (failed === 0) {
    if (report.retryRecommended && summaryFailures > 0) {
      return {
        status: "partial_failed",
        retryRecommended: true,
        errorCode: "project_summary_failed",
        errorSummary: `${summaryFailures} 个项目总结失败，已写入兜底结果。`,
      };
    }
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

function isSummaryRetryWarning(warning: string): boolean {
  return warning.startsWith("repository_summary_fallback:") ||
    warning.startsWith("repository_summary_failed:") ||
    warning.startsWith("repository_summary_incomplete:");
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

  async start(): Promise<void> {
    await this.send();
    if (this.shouldStop()) {
      return;
    }
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
