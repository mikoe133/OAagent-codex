import type { ProjectStatus } from "../../domain/projectProgress.js";
import {
  buildFencedMutationBody,
  isDefinitiveLeaseLossErrorCode,
  type FencedMutationContext,
} from "./fencedMutation.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
} from "../observability/operationMetrics.js";
import {
  OaRequestScheduler,
  type OaRequestExecutor,
} from "./oaRequestScheduler.js";
import type { WeeklyReportSnapshot } from "../../application/weeklyReportProjectSummarySync.js";

const PROJECT_PAGE_SIZE = 100;
const SUMMARY_PAGE_SIZE = 100;
const OA_REQUEST_TIMEOUT_MS = 15_000;
const OA_GET_MAX_ATTEMPTS = 3;
const OA_GET_RETRY_BASE_DELAY_MS = 200;
const OA_GET_RETRY_MAX_DELAY_MS = 2_000;

export type OaProject = {
  id: number;
  projectName: string;
  status: ProjectStatus;
  githubUrls: string[];
  aliases?: string[];
  version?: number;
};

export interface ProjectProgressOaReader {
  listProjects(signal?: AbortSignal): Promise<OaProject[]>;
  getProject(projectId: number, signal?: AbortSignal): Promise<OaProject>;
}

export interface WeeklyReportOaReader {
  getWeeklyReport(reportId: string, signal?: AbortSignal): Promise<WeeklyReportSnapshot>;
}

export type OaCommitSummary = {
  id: number;
  projectId: number;
  summaryDate: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
  version?: number;
};

export type CommitSummaryCreateInput = {
  projectId: number;
  summaryDate: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
};

export type CommitSummaryUpdateInput = Omit<
  CommitSummaryCreateInput,
  "projectId" | "summaryDate"
> & {
  expectedVersion?: number;
};

export interface ProjectProgressOaWriter extends ProjectProgressOaReader {
  updateProjectStatus(
    projectId: number,
    status: Exclude<ProjectStatus, "archived">,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  listCommitSummaries(
    projectId: number,
    summaryDate: string,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary[]>;
  getCommitSummary(summaryId: number, signal?: AbortSignal): Promise<OaCommitSummary>;
  createCommitSummary(
    input: CommitSummaryCreateInput,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary>;
  updateCommitSummary(
    summaryId: number,
    input: CommitSummaryUpdateInput,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary>;
}

export type ProjectProgressOaClientConfig = {
  baseUrl: string;
  alias: string;
  token: string;
  tokenHeader: string;
  tokenPrefix: string;
  mutationContext?: FencedMutationContext;
};

export type ProjectProgressOaClientExecution = {
  scheduler?: OaRequestExecutor;
  getRetry?: {
    random?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  };
};

type OaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OaContractError extends Error {
  override name = "OaContractError";
}

export class OaRequestError extends Error {
  override name = "OaRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null = null,
  ) {
    super(message);
  }
}

export class ProjectProgressLeaseLostError extends OaRequestError {
  override name = "ProjectProgressLeaseLostError";
}

export class ProjectProgressOaClient implements ProjectProgressOaWriter, WeeklyReportOaReader {
  private readonly scheduler: OaRequestExecutor;
  private readonly retryRandom: () => number;
  private readonly retrySleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly config: ProjectProgressOaClientConfig,
    private readonly fetchImpl: OaFetch = fetch,
    private readonly operationMetrics?: OperationMetricsRecorder,
    execution: ProjectProgressOaClientExecution = {},
  ) {
    this.scheduler = execution.scheduler ?? new OaRequestScheduler();
    this.retryRandom = execution.getRetry?.random ?? Math.random;
    this.retrySleep = execution.getRetry?.sleep ?? abortableDelay;
  }

  async listProjects(signal?: AbortSignal): Promise<OaProject[]> {
    const projects: OaProject[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(PROJECT_PROGRESS_ENDPOINTS.oaProjectList, "/internal/project-sync/projects", {
        page,
        size: PROJECT_PAGE_SIZE,
      }, { signal });
      const pagination = decodePagination(payload, decodeProject);
      projects.push(...pagination.items);
      if (pagination.items.length === 0 || projects.length >= pagination.total) {
        return projects;
      }
    }
  }

  async getProject(projectId: number, signal?: AbortSignal): Promise<OaProject> {
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaProjectGet,
      `/internal/project-sync/projects/${encodeURIComponent(String(projectId))}`,
      {},
      { signal },
    );
    return decodeProject(decodeEnvelope(payload).data);
  }

  async getWeeklyReport(reportId: string, signal?: AbortSignal): Promise<WeeklyReportSnapshot> {
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaWeeklyReportGet,
      `/internal/weekly-reports/${encodeURIComponent(reportId)}`,
      {},
      { signal },
    );
    const data = decodeEnvelope(payload).data;
    if (!isRecord(data) || typeof data.id !== "string" ||
      !Number.isInteger(data.weekly_num) || typeof data.content !== "string" ||
      !Number.isInteger(data.version) || typeof data.updated_at !== "string") {
      throw new OaContractError("OA 周报响应字段无效。");
    }
    const weeklyNum = data.weekly_num as number;
    const version = data.version as number;
    return {
      id: data.id,
      weeklyNum,
      ownerId: typeof data.owner_id === "number" ? data.owner_id : null,
      content: data.content,
      version,
      updatedAt: data.updated_at,
      deleted: data.deleted === true,
    };
  }

  async updateProjectStatus(
    projectId: number,
    status: Exclude<ProjectStatus, "archived">,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildMutationBody(
      `project.status.update:${projectId}`,
      { status },
      expectedVersion,
    );
    await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaProjectStatusUpdate,
      `/internal/project-sync/projects/${encodeURIComponent(String(projectId))}/status`,
      {},
      { method: "PATCH", body, signal },
    );
  }

  async listCommitSummaries(
    projectId: number,
    summaryDate: string,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary[]> {
    const summaries: OaCommitSummary[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(
        PROJECT_PROGRESS_ENDPOINTS.oaSummaryList,
        "/internal/project-sync/github-commit-summaries",
        {
          project_id: projectId,
          summary_date: summaryDate,
          page,
          size: SUMMARY_PAGE_SIZE,
        },
        { signal },
      );
      const pagination = decodePagination(payload, decodeCommitSummary);
      summaries.push(...pagination.items);
      if (pagination.items.length === 0 || summaries.length >= pagination.total) {
        return summaries;
      }
    }
  }

  async getCommitSummary(summaryId: number, signal?: AbortSignal): Promise<OaCommitSummary> {
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaSummaryGet,
      `/internal/project-sync/github-commit-summaries/${encodeURIComponent(String(summaryId))}`,
      {},
      { signal },
    );
    return decodeCommitSummary(decodeEnvelope(payload).data);
  }

  async createCommitSummary(
    input: CommitSummaryCreateInput,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary> {
    const body = this.buildMutationBody(
      `commit-summary.create:${input.projectId}:${input.summaryDate}`,
      {
        project_id: input.projectId,
        summary_date: input.summaryDate,
        summary: input.summary,
        ai_confidence: input.aiConfidence,
        ai_note: input.aiNote,
      },
    );
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaSummaryCreate,
      "/internal/project-sync/github-commit-summaries",
      {},
      {
        method: "POST",
        body,
        signal,
      },
    );
    return this.decodeOrReadCommitSummary(payload, signal);
  }

  async updateCommitSummary(
    summaryId: number,
    input: CommitSummaryUpdateInput,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary> {
    const body = this.buildMutationBody(
      `commit-summary.update:${summaryId}`,
      {
        summary: input.summary,
        ai_confidence: input.aiConfidence,
        ai_note: input.aiNote,
      },
      input.expectedVersion,
    );
    const payload = await this.request(
      PROJECT_PROGRESS_ENDPOINTS.oaSummaryUpdate,
      `/internal/project-sync/github-commit-summaries/${encodeURIComponent(String(summaryId))}`,
      {},
      {
        method: "PATCH",
        body,
        signal,
      },
    );
    return this.decodeOrReadCommitSummary(payload, signal);
  }

  private async decodeOrReadCommitSummary(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<OaCommitSummary> {
    const data = decodeEnvelope(payload).data;
    try {
      return decodeCommitSummary(data);
    } catch (error) {
      if (
        error instanceof OaContractError &&
        isRecord(data) &&
        Number.isInteger(data.id) &&
        (data.id as number) > 0
      ) {
        return this.getCommitSummary(data.id as number, signal);
      }
      throw error;
    }
  }

  private buildMutationBody(
    operation: string,
    body: Record<string, unknown>,
    expectedVersion?: number,
  ): Record<string, unknown> {
    const context = this.config.mutationContext;
    if (!context) {
      return body;
    }
    const requiresExpectedVersion = operation.startsWith("project.status.update:") ||
      operation.startsWith("commit-summary.update:");
    if (
      requiresExpectedVersion &&
      (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
    ) {
      throw new OaContractError(
        `Fenced mutation ${operation} 缺少有效 expectedVersion。`,
      );
    }
    return buildFencedMutationBody(
      context,
      operation,
      {
        ...body,
        ...(requiresExpectedVersion
          ? { expected_version: expectedVersion as number }
          : {}),
      },
    );
  }

  private async request(
    endpoint: string,
    path: string,
    query: Record<string, string | number>,
    options: {
      method?: "GET" | "POST" | "PATCH";
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const executeHttp = async () => {
      const url = new URL(path, ensureTrailingSlash(this.config.baseUrl));
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, String(value));
      }
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
          [this.config.tokenHeader]: formatToken(this.config.tokenPrefix, this.config.token),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: combineWithTimeout(options.signal, OA_REQUEST_TIMEOUT_MS),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (!response.ok) {
          throw requestError(response.status, null);
        }
        throw new OaContractError("OA 响应不是合法 JSON。");
      }
      if (!response.ok) {
        throw requestError(response.status, decodeErrorCode(payload));
      }
      return payload;
    };
    const executeAttempt = async () => {
      const finishQueueWait = this.operationMetrics?.startQueueWait(endpoint);
      try {
        return await this.scheduler.run(
          options.method && options.method !== "GET" ? "p1" : "p2",
          async () => {
            finishQueueWait?.();
            return await executeHttp();
          },
          options.signal ? { signal: options.signal } : {},
        );
      } finally {
        finishQueueWait?.();
      }
    };
    const execute = options.method && options.method !== "GET"
      ? executeAttempt
      : () => this.executeGetWithRetry(executeAttempt, options.signal);
    return this.operationMetrics
      ? this.operationMetrics.measure(endpoint, execute)
      : execute();
  }

  private async executeGetWithRetry<T>(
    executeAttempt: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await executeAttempt();
      } catch (error) {
        if (
          attempt >= OA_GET_MAX_ATTEMPTS ||
          !isRetryableGetError(error, signal)
        ) {
          throw error;
        }
        await this.retrySleep(this.retryDelayMs(attempt), signal);
      }
    }
  }

  private retryDelayMs(failedAttempt: number): number {
    const ceiling = Math.min(
      OA_GET_RETRY_MAX_DELAY_MS,
      OA_GET_RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1),
    );
    const random = Math.min(1, Math.max(0, this.retryRandom()));
    return Math.floor(random * ceiling);
  }
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function isRetryableGetError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || error instanceof ProjectProgressLeaseLostError) {
    return false;
  }
  if (error instanceof OaRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof OaContractError) {
    return false;
  }
  return error instanceof TypeError || error instanceof DOMException;
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

function requestError(status: number, errorCode: string | null): OaRequestError {
  const ErrorType = status === 409 && isDefinitiveLeaseLossErrorCode(errorCode)
    ? ProjectProgressLeaseLostError
    : OaRequestError;
  return new ErrorType(
    `OA 请求失败:HTTP ${status}${errorCode ? `:${errorCode}` : ""}`,
    status,
    errorCode,
  );
}

function decodeErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }
  return typeof payload.data.error_code === "string"
    ? payload.data.error_code
    : null;
}

function decodePagination<T>(
  payload: unknown,
  decodeItem: (value: unknown) => T,
): { total: number; items: T[] } {
  const envelope = decodeEnvelope(payload);
  if (!isRecord(envelope.data)) {
    throw new OaContractError("OA 分页响应缺少 data 对象。");
  }
  const { total, items } = envelope.data;
  if (!Number.isInteger(total) || (total as number) < 0 || !Array.isArray(items)) {
    throw new OaContractError("OA 分页响应的 total/items 类型无效。");
  }
  return { total: total as number, items: items.map(decodeItem) };
}

function decodeEnvelope(payload: unknown): { data: unknown } {
  if (!isRecord(payload) || !("data" in payload)) {
    throw new OaContractError("OA 响应缺少 data envelope。");
  }
  if (payload.success === false) {
    throw new OaContractError("OA 响应 success=false。");
  }
  return { data: payload.data };
}

function decodeProject(value: unknown): OaProject {
  if (!isRecord(value)) {
    throw new OaContractError("OA 项目不是对象。");
  }
  const status = value.status;
  if (!isProjectStatus(status)) {
    throw new OaContractError(`OA 项目 status 无效:${String(status)}`);
  }
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    throw new OaContractError("OA 项目 id 无效。");
  }
  if (typeof value.project_name !== "string") {
    throw new OaContractError("OA 项目 project_name 无效。");
  }
  if (!Array.isArray(value.github_urls) || !value.github_urls.every((url) => typeof url === "string")) {
    throw new OaContractError("OA 项目 github_urls 无效。");
  }
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === "string"))) {
    throw new OaContractError("OA 项目 aliases 无效。");
  }
  if (value.version !== undefined && !Number.isInteger(value.version)) {
    throw new OaContractError("OA 项目 version 无效。");
  }
  return {
    id: value.id as number,
    projectName: value.project_name,
    status,
    githubUrls: value.github_urls,
    ...(Array.isArray(value.aliases) ? { aliases: value.aliases } : {}),
    ...(typeof value.version === "number" ? { version: value.version } : {}),
  };
}

function decodeCommitSummary(value: unknown): OaCommitSummary {
  if (!isRecord(value)) {
    throw new OaContractError("OA commit summary 不是对象。");
  }
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    throw new OaContractError("OA commit summary id 无效。");
  }
  if (!Number.isInteger(value.project_id) || (value.project_id as number) < 1) {
    throw new OaContractError("OA commit summary project_id 无效。");
  }
  if (typeof value.summary_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.summary_date)) {
    throw new OaContractError("OA commit summary summary_date 无效。");
  }
  if (
    typeof value.summary !== "string" ||
    !Number.isInteger(value.ai_confidence) ||
    (value.ai_confidence as number) < 0 ||
    (value.ai_confidence as number) > 100 ||
    typeof value.ai_note !== "string"
  ) {
    throw new OaContractError("OA commit summary 内容字段无效。");
  }
  if (value.version !== undefined && !Number.isInteger(value.version)) {
    throw new OaContractError("OA commit summary version 无效。");
  }
  return {
    id: value.id as number,
    projectId: value.project_id as number,
    summaryDate: value.summary_date,
    summary: value.summary,
    aiConfidence: value.ai_confidence as number,
    aiNote: value.ai_note,
    ...(typeof value.version === "number" ? { version: value.version } : {}),
  };
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === "updating" || value === "maintenance" || value === "archived";
}

function formatToken(prefix: string, token: string): string {
  if (!prefix) {
    return token;
  }
  return /[=\s]$/.test(prefix) ? `${prefix}${token}` : `${prefix} ${token}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
