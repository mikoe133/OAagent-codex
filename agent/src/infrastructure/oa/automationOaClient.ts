import {
  buildFencedMutationBody,
  isDefinitiveLeaseLossErrorCode,
  type FencedMutationContext,
} from "./fencedMutation.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
} from "../observability/operationMetrics.js";
import { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";
import {
  OaRequestScheduler,
  type OaRequestExecutor,
  type OaRequestLane,
} from "./oaRequestScheduler.js";

const OA_AUTOMATION_REQUEST_TIMEOUT_MS = 15_000;
const OA_AUTOMATION_TRACE_REQUEST_TIMEOUT_MS = 3_000;
const SUPPORTED_JOB_TYPE = "github_project_progress_sync";

type OaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AutomationRunStatus =
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "configuration_error"
  | "cancelled";

export type AutomationPromptProfileSnapshot = {
  promptVersion: string;
  systemPrompt: string;
  requiredCapabilities: string[];
};

export type AutomationJobClaim = {
  runId: string;
  leaseToken: string;
  runMutationToken?: string;
  fencingToken?: number;
  concurrencyKey?: string;
  jobId: number;
  jobKey: string;
  jobType: string;
  name: string;
  triggerSource: string;
  scheduledAt: string;
  timezone: string;
  modelProvider: string;
  modelId: string;
  modelParameters: Record<string, unknown>;
  modelCatalogVersion: string | null;
  promptProfile: AutomationPromptProfileSnapshot | null;
  retryPolicy: {
    attempt: number;
    maxAttempts: number;
    intervalSeconds: number;
  };
  timeoutSeconds: number;
  deadlineAt: string;
  leaseExpiresAt: string;
  cancelRequested: boolean;
};

export type AutomationHeartbeat = {
  status: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  cancelRequested: boolean;
};

export type AutomationRunProjectInput = {
  projectNameSnapshot: string;
  statusBefore: string | null;
  statusAfter: string | null;
  outcome:
    | "evaluated"
    | "archived"
    | "no_github_urls"
    | "no_commits"
    | "invalid_github_urls"
    | "incomplete"
    | "write_conflict"
    | "failed";
  repositoryCount: number;
  commitCount: number;
  summaryDate: string | null;
  sourceDigest: string | null;
  generatedSummary: string | null;
  aiConfidence: number | null;
  aiNote: string | null;
  warnings: Array<Record<string, unknown>>;
  mutationsApplied: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type AutomationAiInteractionInput = {
  runProjectId: number;
  interactionKey: string;
  provider: string;
  model: string;
  modelCatalogVersion: string | null;
  promptVersion: string;
  systemPromptSnapshot: string;
  requestPayloadSanitized: Record<string, unknown>;
  responsePayloadSanitized: Record<string, unknown>;
  finalSummary: string | null;
  limitations: Array<Record<string, unknown>>;
  fallbackUsed: boolean;
  upstreamRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "succeeded" | "failed" | "fallback";
  errorCode: string | null;
  errorSummary: string | null;
};

export type AutomationTraceEventInput = {
  eventKey: string;
  sequence: number;
  phase: string;
  status: "pending" | "running" | "succeeded" | "fallback" | "failed" | "cancelled";
  title: string;
  message: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  projectId: number | null;
  repositoryFullName: string | null;
  metadataSanitized: Record<string, unknown>;
  occurredAt: string;
};

export type AutomationOaClientConfig = {
  baseUrl: string;
  token: string;
};

export type AutomationOaClientExecution = {
  scheduler?: OaRequestExecutor;
  heartbeatLimiter?: AsyncSemaphore;
};

export type AutomationClaimInput = {
  workerInstance: string;
  leaseSeconds: number;
  claimRequestId: string;
  signal?: AbortSignal;
};

export class AutomationOaContractError extends Error {
  override name = "AutomationOaContractError";
}

export class AutomationOaRequestError extends Error {
  override name = "AutomationOaRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
  ) {
    super(message);
  }
}

export class AutomationLeaseLostError extends AutomationOaRequestError {
  override name = "AutomationLeaseLostError";
}

export class AutomationOaClient {
  private readonly scheduler: OaRequestExecutor;
  private readonly heartbeatLimiter: AsyncSemaphore;

  constructor(
    private readonly config: AutomationOaClientConfig,
    private readonly fetchImpl: OaFetch = fetch,
    private readonly operationMetrics?: OperationMetricsRecorder,
    execution: AutomationOaClientExecution = {},
  ) {
    this.scheduler = execution.scheduler ?? new OaRequestScheduler();
    this.heartbeatLimiter = execution.heartbeatLimiter ?? new AsyncSemaphore(1);
  }

  async claim(workerInstance: string, leaseSeconds: number): Promise<AutomationJobClaim | null>;
  async claim(input: AutomationClaimInput): Promise<AutomationJobClaim | null>;
  async claim(
    input: string | AutomationClaimInput,
    legacyLeaseSeconds?: number,
  ): Promise<AutomationJobClaim | null> {
    const workerInstance = typeof input === "string" ? input : input.workerInstance;
    const leaseSeconds = typeof input === "string" ? legacyLeaseSeconds : input.leaseSeconds;
    if (!Number.isInteger(leaseSeconds) || (leaseSeconds as number) < 1) {
      throw new AutomationOaContractError("claim leaseSeconds 必须是正整数。");
    }
    if (typeof input !== "string" && !isUuid(input.claimRequestId)) {
      throw new AutomationOaContractError("claimRequestId 必须是合法 UUID。");
    }
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationClaim,
      "/internal/automation-job-runs/claim",
      "POST",
      {
        worker_instance: workerInstance,
        supported_job_types: [SUPPORTED_JOB_TYPE],
        lease_seconds: leaseSeconds as number,
        ...(typeof input === "string"
          ? {}
          : { claim_request_id: input.claimRequestId }),
      },
      {
        lane: "p0",
        allowNoContent: true,
        ...(typeof input === "string" || !input.signal ? {} : { signal: input.signal }),
      },
    );
    return payload === null ? null : decodeClaim(decodeEnvelope(payload).data);
  }

  async updateRun(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    status: AutomationRunStatus;
    mutationsApplied?: boolean;
    retryRecommended?: boolean;
    errorCode?: string | null;
    errorSummary?: string | null;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationRunUpdate,
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}`,
      "PATCH",
      scopedMutationBody(input.claim, "automation.run.update", {
        worker_instance: input.workerInstance,
        lease_token: input.claim.leaseToken,
        status: input.status,
        ...(input.mutationsApplied === undefined
          ? {}
          : { mutations_applied: input.mutationsApplied }),
        retry_recommended: input.retryRecommended ?? false,
        ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
        ...(input.errorSummary === undefined ? {} : { error_summary: input.errorSummary }),
      }),
      { lane: "p0", ...(input.signal ? { signal: input.signal } : {}) },
    );
  }

  async heartbeat(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    leaseSeconds: number;
    signal?: AbortSignal;
  }): Promise<AutomationHeartbeat> {
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationHeartbeat,
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/heartbeat`,
      "POST",
      {
        worker_instance: input.workerInstance,
        lease_token: input.claim.leaseToken,
        lease_seconds: input.leaseSeconds,
      },
      {
        heartbeat: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return decodeHeartbeat(decodeEnvelope(payload).data);
  }

  async upsertProjectResult(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    projectId: number;
    result: AutomationRunProjectInput;
    signal?: AbortSignal;
  }): Promise<number> {
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationRunProjectUpsert,
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/projects/${encodeURIComponent(String(input.projectId))}`,
      "PUT",
      scopedMutationBody(
        input.claim,
        `automation.run.project.upsert:${input.projectId}`,
        {
          worker_instance: input.workerInstance,
          lease_token: input.claim.leaseToken,
          project_name_snapshot: input.result.projectNameSnapshot,
          status_before: input.result.statusBefore,
          status_after: input.result.statusAfter,
          outcome: input.result.outcome,
          repository_count: input.result.repositoryCount,
          commit_count: input.result.commitCount,
          summary_date: input.result.summaryDate,
          source_digest: input.result.sourceDigest,
          generated_summary: input.result.generatedSummary,
          ai_confidence: input.result.aiConfidence,
          ai_note: input.result.aiNote,
          warnings: input.result.warnings,
          mutations_applied: input.result.mutationsApplied,
          started_at: input.result.startedAt,
          finished_at: input.result.finishedAt,
          duration_ms: input.result.durationMs,
        },
      ),
      { lane: "p1", ...(input.signal ? { signal: input.signal } : {}) },
    );
    const data = decodeEnvelope(payload).data;
    if (!isRecord(data) || !isPositiveInteger(data.run_project_id)) {
      throw new AutomationOaContractError("OA 项目运行结果缺少 run_project_id。");
    }
    return data.run_project_id;
  }

  async upsertAiInteraction(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    interaction: AutomationAiInteractionInput;
    signal?: AbortSignal;
  }): Promise<number> {
    const interaction = input.interaction;
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationAiInteractionUpsert,
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/ai-interactions`,
      "POST",
      scopedMutationBody(
        input.claim,
        `automation.run.ai-interaction.upsert:${interaction.interactionKey}`,
        {
          worker_instance: input.workerInstance,
          lease_token: input.claim.leaseToken,
          run_project_id: interaction.runProjectId,
          interaction_key: interaction.interactionKey,
          provider: interaction.provider,
          model: interaction.model,
          model_catalog_version: interaction.modelCatalogVersion,
          prompt_version: interaction.promptVersion,
          system_prompt_snapshot: interaction.systemPromptSnapshot,
          request_payload_sanitized: interaction.requestPayloadSanitized,
          response_payload_sanitized: interaction.responsePayloadSanitized,
          final_summary: interaction.finalSummary,
          limitations: interaction.limitations,
          fallback_used: interaction.fallbackUsed,
          upstream_request_id: interaction.upstreamRequestId,
          input_tokens: interaction.inputTokens,
          output_tokens: interaction.outputTokens,
          latency_ms: interaction.latencyMs,
          status: interaction.status,
          error_code: interaction.errorCode,
          error_summary: interaction.errorSummary,
        },
      ),
      { lane: "p1", ...(input.signal ? { signal: input.signal } : {}) },
    );
    const data = decodeEnvelope(payload).data;
    if (!isRecord(data) || !isPositiveInteger(data.interaction_id)) {
      throw new AutomationOaContractError("OA AI 审计响应缺少 interaction_id。");
    }
    return data.interaction_id;
  }

  async upsertTraceEvent(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    event: AutomationTraceEventInput;
    signal?: AbortSignal;
  }): Promise<void> {
    const event = input.event;
    await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaAutomationTraceUpsert,
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/trace-events`,
      "POST",
      scopedMutationBody(
        input.claim,
        `automation.run.trace-event.upsert:${event.eventKey}`,
        {
          worker_instance: input.workerInstance,
          lease_token: input.claim.leaseToken,
          event_key: event.eventKey,
          sequence: event.sequence,
          phase: event.phase,
          status: event.status,
          title: event.title,
          message: event.message,
          progress_current: event.progressCurrent,
          progress_total: event.progressTotal,
          project_id: event.projectId,
          repository_full_name: event.repositoryFullName,
          metadata_sanitized: event.metadataSanitized,
          occurred_at: event.occurredAt,
        },
      ),
      {
        lane: "p3",
        allowNoContent: true,
        timeoutMs: OA_AUTOMATION_TRACE_REQUEST_TIMEOUT_MS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  }

  private async request(
    endpoint: string,
    path: string,
    method: "POST" | "PUT" | "PATCH",
    body: Record<string, unknown>,
    options: {
      lane?: OaRequestLane;
      heartbeat?: boolean;
      signal?: AbortSignal;
      allowNoContent?: boolean;
      timeoutMs?: number;
    },
  ): Promise<unknown | null> {
    const executeHttp = async () => {
      const timeoutMs = options.timeoutMs ?? OA_AUTOMATION_REQUEST_TIMEOUT_MS;
      const response = await this.fetchImpl(
        new URL(path, ensureTrailingSlash(this.config.baseUrl)),
        {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.config.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: combineWithTimeout(options.signal, timeoutMs),
        },
      );
      if (options.allowNoContent && response.status === 204) {
        return null;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AutomationOaContractError("OA 自动化响应不是合法 JSON。");
      }
      if (!response.ok) {
        const errorCode = decodeErrorCode(payload);
        const ErrorType = response.status === 409 && isDefinitiveLeaseLossErrorCode(errorCode)
          ? AutomationLeaseLostError
          : AutomationOaRequestError;
        throw new ErrorType(
          `OA 自动化请求失败:HTTP ${response.status}${errorCode ? `:${errorCode}` : ""}`,
          response.status,
          errorCode,
        );
      }
      return payload;
    };
    const execute = async () => {
      const finishQueueWait = this.operationMetrics?.startQueueWait(endpoint);
      try {
        if (options.heartbeat) {
          return await this.heartbeatLimiter.run(async () => {
            finishQueueWait?.();
            return await executeHttp();
          }, options.signal);
        }
        if (!options.lane) {
          throw new Error(`OA 自动化 endpoint 缺少调度 lane:${endpoint}`);
        }
        return await this.scheduler.run(options.lane, async () => {
          finishQueueWait?.();
          return await executeHttp();
        }, options.signal ? { signal: options.signal } : {});
      } finally {
        finishQueueWait?.();
      }
    };
    return this.operationMetrics
      ? this.operationMetrics.measure(endpoint, execute)
      : execute();
  }
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function decodeClaim(value: unknown): AutomationJobClaim {
  if (!isRecord(value)) {
    throw new AutomationOaContractError("OA claim data 不是对象。");
  }
  const retryPolicy = value.retry_policy;
  const promptProfile = decodePromptProfile(value.prompt_profile);
  const mutationContext = decodeClaimMutationContext(value);
  if (
    !isNonEmptyString(value.run_id) ||
    !isNonEmptyString(value.lease_token) ||
    !isPositiveInteger(value.job_id) ||
    !isNonEmptyString(value.job_key) ||
    !isNonEmptyString(value.job_type) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.trigger_source) ||
    !isIsoDate(value.scheduled_at) ||
    !isNonEmptyString(value.timezone) ||
    !isNonEmptyString(value.model_provider) ||
    !isNonEmptyString(value.model_id) ||
    !isRecord(value.model_parameters) ||
    !(value.model_catalog_version === null || isNonEmptyString(value.model_catalog_version)) ||
    !isRecord(retryPolicy) ||
    !isPositiveInteger(retryPolicy.attempt) ||
    !isPositiveInteger(retryPolicy.max_attempts) ||
    !Number.isInteger(retryPolicy.interval_seconds) ||
    !isPositiveInteger(value.timeout_seconds) ||
    !isIsoDate(value.deadline_at) ||
    !isIsoDate(value.lease_expires_at) ||
    typeof value.cancel_requested !== "boolean"
  ) {
    throw new AutomationOaContractError("OA claim data 字段无效。");
  }
  return {
    runId: value.run_id,
    leaseToken: value.lease_token,
    ...(mutationContext ?? {}),
    jobId: value.job_id,
    jobKey: value.job_key,
    jobType: value.job_type,
    name: value.name,
    triggerSource: value.trigger_source,
    scheduledAt: new Date(value.scheduled_at).toISOString(),
    timezone: value.timezone,
    modelProvider: value.model_provider,
    modelId: value.model_id,
    modelParameters: value.model_parameters,
    modelCatalogVersion: value.model_catalog_version,
    promptProfile,
    retryPolicy: {
      attempt: retryPolicy.attempt,
      maxAttempts: retryPolicy.max_attempts,
      intervalSeconds: retryPolicy.interval_seconds,
    },
    timeoutSeconds: value.timeout_seconds,
    deadlineAt: new Date(value.deadline_at).toISOString(),
    leaseExpiresAt: new Date(value.lease_expires_at).toISOString(),
    cancelRequested: value.cancel_requested,
  };
}

function decodeClaimMutationContext(
  value: Record<string, any>,
): Pick<AutomationJobClaim, "runMutationToken" | "fencingToken" | "concurrencyKey"> | null {
  const fields = ["run_mutation_token", "fencing_token", "concurrency_key"] as const;
  const present = fields.map((field) => Object.hasOwn(value, field));
  if (!present.some(Boolean)) {
    return null;
  }
  if (
    !present.every(Boolean) ||
    !isNonEmptyString(value.run_mutation_token) ||
    !isPositiveInteger(value.fencing_token) ||
    !isNonEmptyString(value.concurrency_key)
  ) {
    throw new AutomationOaContractError(
      "OA claim fencing 字段必须完整且类型有效。",
    );
  }
  return {
    runMutationToken: value.run_mutation_token,
    fencingToken: value.fencing_token,
    concurrencyKey: value.concurrency_key,
  };
}

function scopedMutationBody(
  claim: AutomationJobClaim,
  operation: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const context = claimMutationContext(claim);
  return context === null
    ? body
    : buildFencedMutationBody(context, operation, body);
}

function claimMutationContext(
  claim: AutomationJobClaim,
): FencedMutationContext | null {
  const values = [
    claim.runMutationToken,
    claim.fencingToken,
    claim.concurrencyKey,
  ];
  if (values.every((value) => value === undefined)) {
    return null;
  }
  if (
    !isNonEmptyString(claim.runMutationToken) ||
    !isPositiveInteger(claim.fencingToken) ||
    !isNonEmptyString(claim.concurrencyKey)
  ) {
    throw new AutomationOaContractError(
      "Automation claim fencing context 不完整。",
    );
  }
  return {
    runId: claim.runId,
    runMutationToken: claim.runMutationToken,
    fencingToken: claim.fencingToken,
  };
}

function decodePromptProfile(value: unknown): AutomationPromptProfileSnapshot | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.prompt_version) ||
    !isNonEmptyString(value.system_prompt) ||
    !Array.isArray(value.required_capabilities) ||
    !value.required_capabilities.every(isNonEmptyString)
  ) {
    throw new AutomationOaContractError("OA claim prompt_profile 字段无效。");
  }
  return {
    promptVersion: value.prompt_version,
    systemPrompt: value.system_prompt,
    requiredCapabilities: [...value.required_capabilities],
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function decodeHeartbeat(value: unknown): AutomationHeartbeat {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.status) ||
    !isIsoDate(value.heartbeat_at) ||
    !isIsoDate(value.lease_expires_at) ||
    typeof value.cancel_requested !== "boolean"
  ) {
    throw new AutomationOaContractError("OA heartbeat data 字段无效。");
  }
  return {
    status: value.status,
    heartbeatAt: new Date(value.heartbeat_at).toISOString(),
    leaseExpiresAt: new Date(value.lease_expires_at).toISOString(),
    cancelRequested: value.cancel_requested,
  };
}

function decodeEnvelope(payload: unknown): { data: unknown } {
  if (!isRecord(payload) || !("data" in payload) || payload.success === false) {
    throw new AutomationOaContractError("OA 自动化响应 envelope 无效。");
  }
  return { data: payload.data };
}

function decodeErrorCode(payload: unknown): string | null {
  return isRecord(payload) && isRecord(payload.data) &&
      typeof payload.data.error_code === "string"
    ? payload.data.error_code
    : null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export { SUPPORTED_JOB_TYPE };
