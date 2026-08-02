const OA_AUTOMATION_REQUEST_TIMEOUT_MS = 15_000;
const SUPPORTED_JOB_TYPE = "github_project_progress_sync";

type OaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AutomationRunStatus =
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "configuration_error"
  | "cancelled";

export type AutomationJobClaim = {
  runId: string;
  leaseToken: string;
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

export type AutomationOaClientConfig = {
  baseUrl: string;
  token: string;
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
  constructor(
    private readonly config: AutomationOaClientConfig,
    private readonly fetchImpl: OaFetch = fetch,
  ) {}

  async claim(workerInstance: string, leaseSeconds: number): Promise<AutomationJobClaim | null> {
    const payload = await this.request(
      "/internal/automation-job-runs/claim",
      "POST",
      {
        worker_instance: workerInstance,
        supported_job_types: [SUPPORTED_JOB_TYPE],
        lease_seconds: leaseSeconds,
      },
      true,
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
  }): Promise<void> {
    await this.request(
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}`,
      "PATCH",
      {
        worker_instance: input.workerInstance,
        lease_token: input.claim.leaseToken,
        status: input.status,
        ...(input.mutationsApplied === undefined
          ? {}
          : { mutations_applied: input.mutationsApplied }),
        retry_recommended: input.retryRecommended ?? false,
        ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
        ...(input.errorSummary === undefined ? {} : { error_summary: input.errorSummary }),
      },
    );
  }

  async heartbeat(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    leaseSeconds: number;
  }): Promise<AutomationHeartbeat> {
    const payload = await this.request(
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/heartbeat`,
      "POST",
      {
        worker_instance: input.workerInstance,
        lease_token: input.claim.leaseToken,
        lease_seconds: input.leaseSeconds,
      },
    );
    return decodeHeartbeat(decodeEnvelope(payload).data);
  }

  async upsertProjectResult(input: {
    claim: AutomationJobClaim;
    workerInstance: string;
    projectId: number;
    result: AutomationRunProjectInput;
  }): Promise<number> {
    const payload = await this.request(
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/projects/${encodeURIComponent(String(input.projectId))}`,
      "PUT",
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
  }): Promise<number> {
    const interaction = input.interaction;
    const payload = await this.request(
      `/internal/automation-job-runs/${encodeURIComponent(input.claim.runId)}/ai-interactions`,
      "POST",
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
    );
    const data = decodeEnvelope(payload).data;
    if (!isRecord(data) || !isPositiveInteger(data.interaction_id)) {
      throw new AutomationOaContractError("OA AI 审计响应缺少 interaction_id。");
    }
    return data.interaction_id;
  }

  private async request(
    path: string,
    method: "POST" | "PUT" | "PATCH",
    body: Record<string, unknown>,
    allowNoContent = false,
  ): Promise<unknown | null> {
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
        signal: AbortSignal.timeout(OA_AUTOMATION_REQUEST_TIMEOUT_MS),
      },
    );
    if (allowNoContent && response.status === 204) {
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
      const ErrorType = response.status === 409 &&
          (errorCode === "invalid_lease_token" || errorCode === "lease_expired")
        ? AutomationLeaseLostError
        : AutomationOaRequestError;
      throw new ErrorType(
        `OA 自动化请求失败:HTTP ${response.status}${errorCode ? `:${errorCode}` : ""}`,
        response.status,
        errorCode,
      );
    }
    return payload;
  }
}

function decodeClaim(value: unknown): AutomationJobClaim {
  if (!isRecord(value)) {
    throw new AutomationOaContractError("OA claim data 不是对象。");
  }
  const retryPolicy = value.retry_policy;
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
