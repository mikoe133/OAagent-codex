import { setTimeout as delay } from "node:timers/promises";
import type { ProjectProgressCommit } from "../../domain/projectProgress.js";
import type { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
} from "../observability/operationMetrics.js";
import type { GitHubRepositoryIdentity } from "./githubUrl.js";
import type {
  GitHubRepositorySnapshot,
  ProjectProgressGitHubReader,
} from "./githubTypes.js";

const DEFAULT_LOOKBACK_HOURS = 24 * 30;
const PAGE_SIZE = 100;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BRANCHES = 500;
const DEFAULT_MAX_COMMIT_PAGES_PER_BRANCH = 100;
const DEFAULT_MAX_REQUESTS_PER_REPOSITORY = 2_000;

type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
}

export type GitHubRequestPolicy = {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxBranches?: number;
  maxCommitPagesPerBranch?: number;
  maxRequestsPerRepository?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

type ResolvedGitHubRequestPolicy = Required<Omit<GitHubRequestPolicy, "sleep">> & {
  sleep: NonNullable<GitHubRequestPolicy["sleep"]>;
};

type RepositoryRequestBudget = {
  requests: number;
};

export class GitHubRestProjectReader implements ProjectProgressGitHubReader {
  private readonly cache = new Map<string, Promise<GitHubRepositorySnapshot>>();
  private readonly policy: ResolvedGitHubRequestPolicy;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: GitHubFetch = fetch,
    private readonly apiBaseUrl = "https://api.github.com",
    private readonly lookbackHours = DEFAULT_LOOKBACK_HOURS,
    private readonly requestLimiter?: AsyncSemaphore,
    private readonly operationMetrics?: OperationMetricsRecorder,
    policy: GitHubRequestPolicy = {},
  ) {
    this.policy = resolveRequestPolicy(policy);
  }

  readRepository(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
    signal?: AbortSignal,
  ): Promise<GitHubRepositorySnapshot> {
    const key = repository.fullName.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const request = this.readRepositoryUncached(repository, observedAt, signal);
    this.cache.set(key, request);
    return request;
  }

  private async readRepositoryUncached(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
    signal?: AbortSignal,
  ): Promise<GitHubRepositorySnapshot> {
    const budget: RepositoryRequestBudget = { requests: 0 };
    const metadata = decodeRepository(
      await this.request(
        PROJECT_PROGRESS_ENDPOINTS.githubRepositoryGet,
        `/repos/${encode(repository.owner)}/${encode(repository.repository)}`,
        {},
        [],
        signal,
        budget,
      ),
    );

    try {
      const branches = await this.listBranches(repository, signal, budget);
      const since = new Date(
        observedAt.getTime() - this.lookbackHours * 60 * 60 * 1_000,
      ).toISOString();
      const commitsByKey = new Map<string, ProjectProgressCommit>();

      for (const branch of branches) {
        for (let page = 1; ; page += 1) {
          const payload = await this.request(
            PROJECT_PROGRESS_ENDPOINTS.githubCommitsList,
            `/repos/${encode(repository.owner)}/${encode(repository.repository)}/commits`,
            { sha: branch, since, per_page: PAGE_SIZE, page },
            [409],
            signal,
            budget,
          );
          if (payload === null) {
            break;
          }
          const commits = decodeCommits(payload, metadata.id, metadata.fullName);
          for (const commit of commits) {
            commitsByKey.set(`${metadata.id}:${commit.sha}`, commit);
          }
          if (commits.length < PAGE_SIZE) {
            break;
          }
          if (page >= this.policy.maxCommitPagesPerBranch) {
            throw new GitHubRequestBudgetExceededError(
              `仓库 ${metadata.fullName} 的分支 ${branch} Commit 页数超过上限。`,
            );
          }
        }
      }

      const commits = [...commitsByKey.values()].sort((left, right) =>
        left.committedAt.localeCompare(right.committedAt) || left.sha.localeCompare(right.sha)
      );
      const latestCommitAt = commits.reduce<string | null>(
        (latest, commit) => !latest || commit.committedAt > latest ? commit.committedAt : latest,
        null,
      );
      return {
        repositoryId: metadata.id,
        fullName: metadata.fullName,
        canonicalUrl: `https://github.com/${metadata.fullName}`,
        complete: true,
        lastActivityAt: latestCommitAt ?? (branches.length === 0 ? metadata.createdAt : null),
        commits,
      };
    } catch (error) {
      if (!(error instanceof GitHubRequestBudgetExceededError)) {
        throw error;
      }
      return {
        repositoryId: metadata.id,
        fullName: metadata.fullName,
        canonicalUrl: `https://github.com/${metadata.fullName}`,
        complete: false,
        lastActivityAt: null,
        commits: [],
      };
    }
  }

  private async listBranches(
    repository: GitHubRepositoryIdentity,
    signal?: AbortSignal,
    budget?: RepositoryRequestBudget,
  ): Promise<string[]> {
    const branches: string[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(
        PROJECT_PROGRESS_ENDPOINTS.githubBranchesList,
        `/repos/${encode(repository.owner)}/${encode(repository.repository)}/branches`,
        { per_page: PAGE_SIZE, page },
        [],
        signal,
        budget,
      );
      const pageBranches = decodeBranches(payload);
      branches.push(...pageBranches);
      if (branches.length > this.policy.maxBranches) {
        throw new GitHubRequestBudgetExceededError(
          `仓库 ${repository.fullName} 的分支数超过上限。`,
        );
      }
      if (pageBranches.length < PAGE_SIZE) {
        return branches;
      }
    }
  }

  private async request(
    endpoint: string,
    path: string,
    query: Record<string, string | number> = {},
    nullableStatuses: number[] = [],
    signal?: AbortSignal,
    budget?: RepositoryRequestBudget,
  ): Promise<unknown | null> {
    const url = new URL(path, ensureTrailingSlash(this.apiBaseUrl));
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, String(value));
    }
    const request = () => this.requestWithRetry(url, nullableStatuses, signal, budget);
    return this.operationMetrics
      ? this.operationMetrics.measure(endpoint, request)
      : request();
  }

  private async requestWithRetry(
    url: URL,
    nullableStatuses: number[],
    signal?: AbortSignal,
    budget?: RepositoryRequestBudget,
  ): Promise<unknown | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      this.consumeRequestBudget(budget);
      try {
        const execute = () => this.fetchImpl(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "oa-project-progress-worker",
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        });
        const response = this.requestLimiter
          ? await this.requestLimiter.run(execute, signal)
          : await execute();
        if (nullableStatuses.includes(response.status)) {
          return null;
        }
        if (!response.ok) {
          const error = githubResponseError(response);
          if (!isRetryableResponse(response) || attempt >= this.policy.maxAttempts) {
            throw error;
          }
          lastError = error;
          await this.waitBeforeRetry(response, attempt, signal);
          continue;
        }
        try {
          return await response.json();
        } catch {
          throw new GitHubRequestError("GitHub 响应不是合法 JSON。", response.status, null);
        }
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason;
        }
        if (
          error instanceof GitHubRequestError ||
          error instanceof GitHubRequestBudgetExceededError ||
          !isRetryableTransportError(error) ||
          attempt >= this.policy.maxAttempts
        ) {
          throw error;
        }
        lastError = error;
        await this.sleepWithSignal(this.jitteredBackoff(attempt), signal);
      }
    }
    throw lastError ?? new Error("GitHub 请求重试状态无效。");
  }

  private consumeRequestBudget(budget?: RepositoryRequestBudget): void {
    if (!budget) {
      return;
    }
    if (budget.requests >= this.policy.maxRequestsPerRepository) {
      throw new GitHubRequestBudgetExceededError("仓库 GitHub 请求数超过上限。");
    }
    budget.requests += 1;
  }

  private async waitBeforeRetry(
    response: Response,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sleepWithSignal(
      retryDelayMilliseconds(response) ?? this.jitteredBackoff(attempt),
      signal,
    );
  }

  private jitteredBackoff(attempt: number): number {
    const ceiling = Math.min(
      this.policy.maxBackoffMs,
      this.policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.floor(this.policy.random() * ceiling);
  }

  private sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return this.policy.sleep(Math.max(0, milliseconds), signal);
  }
}

function resolveRequestPolicy(policy: GitHubRequestPolicy): ResolvedGitHubRequestPolicy {
  return {
    maxAttempts: positiveInteger(policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts"),
    baseBackoffMs: nonNegativeNumber(
      policy.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      "baseBackoffMs",
    ),
    maxBackoffMs: nonNegativeNumber(
      policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      "maxBackoffMs",
    ),
    maxBranches: positiveInteger(policy.maxBranches ?? DEFAULT_MAX_BRANCHES, "maxBranches"),
    maxCommitPagesPerBranch: positiveInteger(
      policy.maxCommitPagesPerBranch ?? DEFAULT_MAX_COMMIT_PAGES_PER_BRANCH,
      "maxCommitPagesPerBranch",
    ),
    maxRequestsPerRepository: positiveInteger(
      policy.maxRequestsPerRepository ?? DEFAULT_MAX_REQUESTS_PER_REPOSITORY,
      "maxRequestsPerRepository",
    ),
    random: policy.random ?? Math.random,
    sleep: policy.sleep ?? (async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { ...(signal ? { signal } : {}), ref: false });
    }),
  };
}

function githubResponseError(response: Response): GitHubRequestError {
  return new GitHubRequestError(
    `GitHub 请求失败:HTTP ${response.status}`,
    response.status,
    retryAtIso(response),
  );
}

function isRetryableResponse(response: Response): boolean {
  if (response.status === 429 || response.status >= 500) {
    return true;
  }
  return response.status === 403 && (
    response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function isRetryableTransportError(error: unknown): boolean {
  return error instanceof TypeError ||
    error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name) ||
    error instanceof Error && /ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/iu.test(error.message);
}

function retryDelayMilliseconds(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
      return Math.max(0, Math.ceil(Number(retryAfter) * 1_000));
    }
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed - Date.now());
    }
  }
  const reset = response.headers.get("x-ratelimit-reset");
  return reset && /^\d+$/.test(reset)
    ? Math.max(0, Number(reset) * 1_000 - Date.now())
    : null;
}

function retryAtIso(response: Response): string | null {
  const retryDelay = retryDelayMilliseconds(response);
  return retryDelay === null ? null : new Date(Date.now() + retryDelay).toISOString();
}

function decodeRepository(value: unknown): { id: number; fullName: string; createdAt: string } {
  if (!isRecord(value) || !Number.isInteger(value.id) || typeof value.full_name !== "string") {
    throw new Error("GitHub repository 响应字段无效。");
  }
  const createdAt = parseIsoDate(value.created_at, "repository.created_at");
  return { id: value.id as number, fullName: value.full_name, createdAt };
}

function decodeBranches(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub branches 响应不是数组。");
  }
  return value.map((branch) => {
    if (!isRecord(branch) || typeof branch.name !== "string") {
      throw new Error("GitHub branch.name 无效。");
    }
    return branch.name;
  });
}

function decodeCommits(
  value: unknown,
  repositoryId: number,
  repositoryFullName: string,
): ProjectProgressCommit[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub commits 响应不是数组。");
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.sha !== "string" || !isRecord(item.commit)) {
      throw new Error("GitHub commit 响应字段无效。");
    }
    const details = item.commit;
    const committer = isRecord(details.committer) ? details.committer : null;
    const author = isRecord(details.author) ? details.author : null;
    const committedAt = parseIsoDate(committer?.date ?? author?.date, "commit date");
    const message = typeof details.message === "string" ? details.message : "";
    return {
      repositoryId,
      repositoryFullName,
      sha: item.sha,
      committedAt,
      subject: sanitizeSubject(message),
    };
  });
}

function sanitizeSubject(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);
}

function parseIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`GitHub ${field} 无效。`);
  }
  return new Date(value).toISOString();
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

function encode(value: string): string {
  return encodeURIComponent(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
