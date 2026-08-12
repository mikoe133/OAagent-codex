import { setTimeout as delay } from "node:timers/promises";
import { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_MAX_REQUESTS_PER_RUN = 20_000;
const DEFAULT_MAX_REQUESTS_PER_REPOSITORY = 2_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_REPOSITORY = 1;
const SECONDARY_RATE_LIMIT_BACKOFF_MS = 30_000;

export class GitHubRequestError extends Error {
  override name = "GitHubRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly retryAt: string | null,
  ) {
    super(message);
  }
}

export class GitHubRequestBudgetExceededError extends Error {
  override name = "GitHubRequestBudgetExceededError";

  constructor(
    readonly scope: "run" | "repository" | "rate_limit",
    readonly retryAt: string | null = null,
  ) {
    super(scope === "run"
      ? "本次运行的 GitHub HTTP 请求预算已耗尽。"
      : scope === "repository"
        ? "该仓库的 GitHub HTTP 请求预算已耗尽。"
        : "GitHub primary rate-limit 保留额度已触达。");
  }
}

export type GitHubRequestExecutorMetrics = {
  attempts: number;
  retries: number;
  rateLimited: number;
  serverErrors: number;
  rejectedByBudget: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  rateLimitReserve: number | null;
  pacingWaitMs: number;
  sharedPauseWaitMs: number;
};

export type GitHubRequestExecutorConfig = {
  requestLimiter?: AsyncSemaphore;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRequestsPerRun?: number;
  maxRequestsPerRepository?: number;
  maxConcurrentRequestsPerRepository?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type GitHubRequestExecutionOptions = {
  repository: string;
  signal?: AbortSignal;
  acceptedStatuses?: readonly number[];
};

type ResolvedConfig = {
  requestLimiter?: AsyncSemaphore;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerRepository: number;
  maxConcurrentRequestsPerRepository: number;
  random: () => number;
  now: () => number;
  sleep: NonNullable<GitHubRequestExecutorConfig["sleep"]>;
};

export class GitHubRequestExecutor {
  private readonly config: ResolvedConfig;
  private readonly repositoryLimiters = new Map<string, AsyncSemaphore>();
  private readonly admissionLimiter = new AsyncSemaphore(1);
  private readonly repositoryRequests = new Map<string, number>();
  private attempts = 0;
  private retries = 0;
  private rateLimited = 0;
  private serverErrors = 0;
  private rejectedByBudget = 0;
  private rateLimitLimit: number | null = null;
  private rateLimitRemaining: number | null = null;
  private rateLimitResetAt: string | null = null;
  private rateLimitResetAtMs: number | null = null;
  private rateLimitReserve: number | null = null;
  private pacingIntervalMs = 0;
  private nextPacedRequestAt = 0;
  private pacingWaitMs = 0;
  private sharedPauseWaitMs = 0;
  private pauseUntil = 0;

  constructor(config: GitHubRequestExecutorConfig = {}) {
    this.config = resolveConfig(config);
  }

  get metrics(): GitHubRequestExecutorMetrics {
    return {
      attempts: this.attempts,
      retries: this.retries,
      rateLimited: this.rateLimited,
      serverErrors: this.serverErrors,
      rejectedByBudget: this.rejectedByBudget,
      rateLimitLimit: this.rateLimitLimit,
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitResetAt: this.rateLimitResetAt,
      rateLimitReserve: this.rateLimitReserve,
      pacingWaitMs: this.pacingWaitMs,
      sharedPauseWaitMs: this.sharedPauseWaitMs,
    };
  }

  async execute(
    operation: () => Promise<Response>,
    options: GitHubRequestExecutionOptions,
  ): Promise<Response> {
    const repository = normalizeRepository(options.repository);
    const repositoryLimiter = this.repositoryLimiter(repository);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      await this.admit(options.signal);
      this.consumeBudget(repository);
      this.attempts += 1;

      try {
        const response = await repositoryLimiter.run(
          () => this.config.requestLimiter
            ? this.config.requestLimiter.run(operation, options.signal)
            : operation(),
          options.signal,
        );
        this.observeRateLimit(response);
        if (response.ok || options.acceptedStatuses?.includes(response.status)) {
          return response;
        }

        const requestError = responseError(response);
        const retryable = await isRetryableResponse(response);
        if (!retryable || attempt >= this.config.maxAttempts) {
          throw requestError;
        }

        lastError = requestError;
        this.retries += 1;
        if (isRateLimitedResponse(response)) {
          this.rateLimited += 1;
          const waitMs = retryDelayMilliseconds(response, this.config.now()) ??
            (response.status === 403
              ? SECONDARY_RATE_LIMIT_BACKOFF_MS
              : this.jitteredBackoff(attempt));
          this.pauseUntil = Math.max(this.pauseUntil, this.config.now() + waitMs);
          this.sharedPauseWaitMs += waitMs;
          await this.sleep(waitMs, options.signal);
        } else {
          this.serverErrors += 1;
          await this.sleep(this.jitteredBackoff(attempt), options.signal);
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        if (
          error instanceof GitHubRequestError ||
          error instanceof GitHubRequestBudgetExceededError ||
          !isRetryableTransportError(error) ||
          attempt >= this.config.maxAttempts
        ) {
          throw error;
        }
        lastError = error;
        this.retries += 1;
        await this.sleep(this.jitteredBackoff(attempt), options.signal);
      }
    }

    throw lastError ?? new Error("GitHub 请求重试状态无效。");
  }

  private repositoryLimiter(repository: string): AsyncSemaphore {
    const existing = this.repositoryLimiters.get(repository);
    if (existing) {
      return existing;
    }
    const limiter = new AsyncSemaphore(
      this.config.maxConcurrentRequestsPerRepository,
    );
    this.repositoryLimiters.set(repository, limiter);
    return limiter;
  }

  private consumeBudget(repository: string): void {
    if (this.attempts >= this.config.maxRequestsPerRun) {
      this.rejectedByBudget += 1;
      throw new GitHubRequestBudgetExceededError("run");
    }
    const repositoryAttempts = this.repositoryRequests.get(repository) ?? 0;
    if (repositoryAttempts >= this.config.maxRequestsPerRepository) {
      this.rejectedByBudget += 1;
      throw new GitHubRequestBudgetExceededError("repository");
    }
    this.repositoryRequests.set(repository, repositoryAttempts + 1);
  }

  private observeRateLimit(response: Response): void {
    const limit = response.headers.get("x-ratelimit-limit");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (limit && /^\d+$/.test(limit)) {
      this.rateLimitLimit = Number(limit);
      this.rateLimitReserve = Math.max(100, Math.ceil(this.rateLimitLimit * 0.1));
    }
    if (remaining && /^\d+$/.test(remaining)) {
      this.rateLimitRemaining = Number(remaining);
    }
    if (reset && /^\d+$/.test(reset)) {
      this.rateLimitResetAtMs = Number(reset) * 1_000;
      this.rateLimitResetAt = new Date(this.rateLimitResetAtMs).toISOString();
    }
    if (
      this.rateLimitRemaining !== null &&
      this.rateLimitReserve !== null &&
      this.rateLimitResetAtMs !== null
    ) {
      const allocatable = this.rateLimitRemaining - this.rateLimitReserve;
      const windowMs = Math.max(0, this.rateLimitResetAtMs - this.config.now());
      this.pacingIntervalMs = allocatable > 0
        ? Math.ceil(windowMs / allocatable)
        : 0;
      this.nextPacedRequestAt = this.pacingIntervalMs > 0
        ? Math.max(
            this.nextPacedRequestAt,
            this.config.now() + this.pacingIntervalMs,
          )
        : 0;
    }
  }

  private admit(signal?: AbortSignal): Promise<void> {
    return this.admissionLimiter.run(async () => {
      this.clearExpiredRateLimitWindow();
      const sharedWaitMs = Math.max(0, this.pauseUntil - this.config.now());
      if (sharedWaitMs > 0) {
        this.sharedPauseWaitMs += sharedWaitMs;
        await this.sleep(sharedWaitMs, signal);
        this.clearExpiredRateLimitWindow();
      }
      if (
        this.rateLimitRemaining !== null &&
        this.rateLimitReserve !== null &&
        this.rateLimitRemaining <= this.rateLimitReserve &&
        this.rateLimitResetAtMs !== null &&
        this.config.now() < this.rateLimitResetAtMs
      ) {
        this.rejectedByBudget += 1;
        throw new GitHubRequestBudgetExceededError(
          "rate_limit",
          new Date(this.rateLimitResetAtMs).toISOString(),
        );
      }
      const pacingWaitMs = Math.max(0, this.nextPacedRequestAt - this.config.now());
      if (pacingWaitMs > 0) {
        this.pacingWaitMs += pacingWaitMs;
        await this.sleep(pacingWaitMs, signal);
      }
      if (this.pacingIntervalMs > 0) {
        this.nextPacedRequestAt = this.config.now() + this.pacingIntervalMs;
      }
    }, signal);
  }

  private clearExpiredRateLimitWindow(): void {
    if (
      this.rateLimitResetAtMs === null ||
      this.config.now() < this.rateLimitResetAtMs
    ) {
      return;
    }
    this.rateLimitLimit = null;
    this.rateLimitRemaining = null;
    this.rateLimitResetAt = null;
    this.rateLimitResetAtMs = null;
    this.rateLimitReserve = null;
    this.pacingIntervalMs = 0;
    this.nextPacedRequestAt = 0;
  }

  private jitteredBackoff(attempt: number): number {
    const ceiling = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.floor(this.config.random() * ceiling);
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return this.config.sleep(Math.max(0, milliseconds), signal);
  }
}

function resolveConfig(config: GitHubRequestExecutorConfig): ResolvedConfig {
  return {
    ...(config.requestLimiter ? { requestLimiter: config.requestLimiter } : {}),
    maxAttempts: positiveInteger(config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts"),
    baseBackoffMs: nonNegativeNumber(
      config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      "baseBackoffMs",
    ),
    maxBackoffMs: nonNegativeNumber(
      config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      "maxBackoffMs",
    ),
    maxRequestsPerRun: positiveInteger(
      config.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
      "maxRequestsPerRun",
    ),
    maxRequestsPerRepository: positiveInteger(
      config.maxRequestsPerRepository ?? DEFAULT_MAX_REQUESTS_PER_REPOSITORY,
      "maxRequestsPerRepository",
    ),
    maxConcurrentRequestsPerRepository: positiveInteger(
      config.maxConcurrentRequestsPerRepository ??
        DEFAULT_MAX_CONCURRENT_REQUESTS_PER_REPOSITORY,
      "maxConcurrentRequestsPerRepository",
    ),
    random: config.random ?? Math.random,
    now: config.now ?? Date.now,
    sleep: config.sleep ?? (async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { ...(signal ? { signal } : {}) });
    }),
  };
}

async function isRetryableResponse(response: Response): Promise<boolean> {
  if (
    response.status === 408 ||
    response.status === 429 ||
    [500, 502, 503, 504].includes(response.status)
  ) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  if (
    response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    return true;
  }
  const message = await response.clone().text().catch(() => "");
  return /secondary rate limit|rate limit exceeded|abuse detection/iu.test(message);
}

function isRateLimitedResponse(response: Response): boolean {
  return response.status === 429 || response.status === 403;
}

function isRetryableTransportError(error: unknown): boolean {
  return error instanceof TypeError ||
    error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name) ||
    error instanceof Error && /ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/iu.test(error.message);
}

function responseError(response: Response): GitHubRequestError {
  const now = Date.now();
  const retryDelay = retryDelayMilliseconds(response, now);
  return new GitHubRequestError(
    `GitHub 请求失败:HTTP ${response.status}`,
    response.status,
    retryDelay === null ? null : new Date(now + retryDelay).toISOString(),
  );
}

function retryDelayMilliseconds(response: Response, now: number): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
      return Math.max(0, Math.ceil(Number(retryAfter) * 1_000));
    }
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed - now);
    }
  }
  const reset = response.headers.get("x-ratelimit-reset");
  return reset && /^\d+$/.test(reset)
    ? Math.max(0, Number(reset) * 1_000 - now)
    : null;
}

function normalizeRepository(value: string): string {
  const repository = value.trim().toLowerCase();
  if (!repository) {
    throw new Error("GitHub repository 不能为空。");
  }
  return repository;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负有限数。`);
  }
  return value;
}
