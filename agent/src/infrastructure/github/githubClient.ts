import type { ProjectProgressCommit } from "../../domain/projectProgress.js";
import type { GitHubRepositoryIdentity } from "./githubUrl.js";
import type {
  GitHubRepositoryReadProgress,
  GitHubRepositoryReadProgressSink,
  GitHubRepositorySnapshot,
  ProjectProgressGitHubReader,
} from "./githubTypes.js";
import type { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";

const DEFAULT_LOOKBACK_HOURS = 24 * 30;
const PAGE_SIZE = 100;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const BRANCH_READ_CONCURRENCY = 6;

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

export class GitHubRestProjectReader implements ProjectProgressGitHubReader {
  private readonly cache = new Map<string, Promise<GitHubRepositorySnapshot>>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: GitHubFetch = fetch,
    private readonly apiBaseUrl = "https://api.github.com",
    private readonly lookbackHours = DEFAULT_LOOKBACK_HOURS,
    private readonly requestLimiter?: AsyncSemaphore,
  ) {}

  readRepository(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
    signal?: AbortSignal,
    onProgress?: GitHubRepositoryReadProgressSink,
  ): Promise<GitHubRepositorySnapshot> {
    const key = repository.fullName.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const request = this.readRepositoryUncached(
      repository,
      observedAt,
      signal,
      onProgress,
    );
    this.cache.set(key, request);
    void request.catch(() => {
      if (this.cache.get(key) === request) {
        this.cache.delete(key);
      }
    });
    return request;
  }

  private async readRepositoryUncached(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
    signal?: AbortSignal,
    onProgress?: GitHubRepositoryReadProgressSink,
  ): Promise<GitHubRepositorySnapshot> {
    const metadata = decodeRepository(
      await this.request(
        `/repos/${encode(repository.owner)}/${encode(repository.repository)}`,
        {},
        [],
        signal,
      ),
    );
    const branches = await this.listBranches(repository, signal);
    const since = new Date(
      observedAt.getTime() - this.lookbackHours * 60 * 60 * 1_000,
    ).toISOString();
    const commitsByKey = new Map<string, ProjectProgressCommit>();
    let branchesCompleted = 0;
    let commitsRead = 0;
    let progressQueue = Promise.resolve();
    const reportProgress = (progress: GitHubRepositoryReadProgress) => {
      progressQueue = progressQueue.then(() => notifyProgress(onProgress, progress));
      return progressQueue;
    };

    await reportProgress({
      branchesCompleted,
      branchesTotal: branches.length,
      commitsRead,
    });
    await forEachConcurrent(branches, BRANCH_READ_CONCURRENCY, async (branch) => {
      for (let page = 1; ; page += 1) {
        const payload = await this.request(
          `/repos/${encode(repository.owner)}/${encode(repository.repository)}/commits`,
          { sha: branch, since, per_page: PAGE_SIZE, page },
          [409],
          signal,
        );
        if (payload === null) {
          break;
        }
        const commits = decodeCommits(payload, metadata.id, metadata.fullName);
        commitsRead += commits.length;
        for (const commit of commits) {
          commitsByKey.set(`${metadata.id}:${commit.sha}`, commit);
        }
        if (commits.length < PAGE_SIZE) {
          break;
        }
      }
      branchesCompleted += 1;
      await reportProgress({
        branchesCompleted,
        branchesTotal: branches.length,
        commitsRead,
      });
    });

    const commits = [...commitsByKey.values()].sort((left, right) =>
      left.committedAt.localeCompare(right.committedAt) || left.sha.localeCompare(right.sha),
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
  }

  private async listBranches(
    repository: GitHubRepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const branches: string[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(
        `/repos/${encode(repository.owner)}/${encode(repository.repository)}/branches`,
        { per_page: PAGE_SIZE, page },
        [],
        signal,
      );
      const pageBranches = decodeBranches(payload);
      branches.push(...pageBranches);
      if (pageBranches.length < PAGE_SIZE) {
        return branches;
      }
    }
  }

  private async request(
    path: string,
    query: Record<string, string | number> = {},
    nullableStatuses: number[] = [],
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    const url = new URL(path, ensureTrailingSlash(this.apiBaseUrl));
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, String(value));
    }
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
      const reset = response.headers.get("x-ratelimit-reset");
      const retryAt = reset && /^\d+$/.test(reset)
        ? new Date(Number(reset) * 1_000).toISOString()
        : null;
      throw new GitHubRequestError(
        `GitHub 请求失败:HTTP ${response.status}`,
        response.status,
        retryAt,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubRequestError("GitHub 响应不是合法 JSON。", response.status, null);
    }
  }
}

async function notifyProgress(
  sink: GitHubRepositoryReadProgressSink | undefined,
  progress: GitHubRepositoryReadProgress,
): Promise<void> {
  if (!sink) {
    return;
  }
  try {
    await sink(progress);
  } catch {
    return;
  }
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!failed) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        try {
          await operation(item);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) {
    throw failure;
  }
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
  return (message.split(/\r?\n/, 1)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

function parseIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`GitHub ${field} 无效。`);
  }
  return new Date(value).toISOString();
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
