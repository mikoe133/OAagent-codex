import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";
import { GitHubRequestExecutor } from "./githubRequestExecutor.js";
import type { GitHubRepositoryIdentity } from "./githubUrl.js";
import type { OperationMetricsRecorder } from "../observability/operationMetrics.js";
import { PROJECT_PROGRESS_ENDPOINTS } from "../observability/operationMetrics.js";

const GITHUB_API_VERSION = "2022-11-28";
const RESPONSE_LIMIT_BYTES = 10 * 1024 * 1024;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;
const GITHUB_APP_REQUEST_TIMEOUT_MS = 20_000;

type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitHubRequestAuth = {
  getAuthorizationHeader(repository: string, signal?: AbortSignal): Promise<string>;
  describeAccess(signal?: AbortSignal): Promise<GitHubAppAccessSummary[]>;
};

export type GitHubAppAccessSummary = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  permissions: Record<string, string>;
  tokenExpiresAt: string;
  repositories: Array<{
    fullName: string;
    owner: string;
    repository: string;
    permissions: Record<string, boolean>;
  }>;
};

export type GitHubAppAuthConfig = {
  appId: string | number;
  privateKey: string;
  apiBaseUrl?: string;
  requestLimiter?: AsyncSemaphore;
  requestExecutor?: GitHubRequestExecutor;
  operationMetrics?: OperationMetricsRecorder;
  fetchImpl?: GitHubFetch;
  signal?: AbortSignal;
};

export type GitHubStaticAuthConfig = {
  token: string;
};

type InstallationToken = {
  token: string;
  expiresAtMs: number;
  permissions: Record<string, string>;
};

type InstallationRecord = {
  id: number;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
};

type InstallationRepositoryRecord = GitHubRepositoryIdentity & {
  permissions: Record<string, boolean>;
};

type AppInstallationResponse = {
  id: number;
  account?: {
    login?: string;
    type?: string;
  } | null;
  repository_selection?: string | null;
};

type InstallationTokenResponse = {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
};

type InstallationRepositoriesResponse = {
  total_count: number;
  repositories: Array<{
    full_name: string;
    owner: { login: string };
    name: string;
    permissions?: Record<string, boolean>;
  }>;
};

export function createStaticGitHubAuth(input: GitHubStaticAuthConfig): GitHubRequestAuth {
  const token = input.token.trim();
  if (!token) {
    throw new Error("GitHub token 不能为空。");
  }
  return {
    async getAuthorizationHeader() {
      return `Bearer ${token}`;
    },
    async describeAccess() {
      return [];
    },
  };
}

export function createGitHubAppAuth(
  config: GitHubAppAuthConfig,
): GitHubRequestAuth {
  return new GitHubAppAuth(config);
}

export class GitHubAppAuth implements GitHubRequestAuth {
  private readonly appId: string;
  private readonly privateKey: KeyObject;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GitHubFetch;
  private readonly requestExecutor: GitHubRequestExecutor;
  private readonly operationMetrics?: OperationMetricsRecorder;
  private readonly signal?: AbortSignal;
  private readonly tokenCache = new Map<number, InstallationToken>();
  private readonly tokenPromises = new Map<number, Promise<InstallationToken>>();
  private accessSummaries: GitHubAppAccessSummary[] | null = null;
  private accessSummaryPromise: Promise<GitHubAppAccessSummary[]> | null = null;
  private repositoryIndex: Map<string, number> | null = null;
  private repositoryIndexPromise: Promise<Map<string, number>> | null = null;

  constructor(config: GitHubAppAuthConfig) {
    const appId = String(config.appId).trim();
    const privateKey = normalizePrivateKey(config.privateKey);
    if (!appId) {
      throw new Error("GitHub App appId 不能为空。");
    }
    if (!privateKey.trim()) {
      throw new Error("GitHub App privateKey 不能为空。");
    }
    this.appId = appId;
    this.privateKey = createPrivateKey(privateKey);
    this.apiBaseUrl = ensureTrailingSlash(config.apiBaseUrl?.trim() || "https://api.github.com");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestExecutor = config.requestExecutor ?? new GitHubRequestExecutor({
      ...(config.requestLimiter ? { requestLimiter: config.requestLimiter } : {}),
      maxConcurrentRequestsPerRepository: 1,
    });
    this.operationMetrics = config.operationMetrics;
    this.signal = config.signal;
  }

  async getAuthorizationHeader(repository: string, signal?: AbortSignal): Promise<string> {
    const installationId = await this.resolveInstallationId(repository, signal);
    const token = await this.getInstallationToken(installationId, signal);
    return `Bearer ${token.token}`;
  }

  async describeAccess(signal?: AbortSignal): Promise<GitHubAppAccessSummary[]> {
    return this.loadAccessSummaries(signal);
  }

  private async resolveInstallationId(
    repository: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const normalized = normalizeRepositoryName(repository);
    const cached = this.repositoryIndex?.get(normalized.toLowerCase());
    if (cached !== undefined) {
      return cached;
    }
    const repositoryIndex = await this.loadRepositoryIndex(signal);
    const installationId = repositoryIndex.get(normalized.toLowerCase());
    if (installationId !== undefined) {
      return installationId;
    }
    const summaries = this.accessSummaries ?? [];
    const accessible = summaries.flatMap((summary) =>
      summary.repositories.map((repo) => repo.fullName)
    );
    throw new Error(
      `GitHub App 当前不能读取仓库:${normalized}。可访问仓库:${accessible.join(", ") || "无"}`,
    );
  }

  private async loadRepositoryIndex(signal?: AbortSignal): Promise<Map<string, number>> {
    if (this.repositoryIndex) {
      return this.repositoryIndex;
    }
    if (this.repositoryIndexPromise) {
      return this.repositoryIndexPromise;
    }
    const promise = this.refreshAccessSummaries(signal).then(() => {
      if (!this.repositoryIndex) {
        this.repositoryIndex = new Map<string, number>();
      }
      return this.repositoryIndex;
    });
    this.repositoryIndexPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.repositoryIndexPromise === promise) {
        this.repositoryIndexPromise = null;
      }
    }
  }

  private async loadAccessSummaries(signal?: AbortSignal): Promise<GitHubAppAccessSummary[]> {
    if (this.accessSummaries) {
      return this.accessSummaries;
    }
    if (this.accessSummaryPromise) {
      return this.accessSummaryPromise;
    }
    const promise = this.refreshAccessSummaries(signal);
    this.accessSummaryPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.accessSummaryPromise === promise) {
        this.accessSummaryPromise = null;
      }
    }
  }

  private async refreshAccessSummaries(
    signal?: AbortSignal,
  ): Promise<GitHubAppAccessSummary[]> {
    const installations = await this.listInstallations(signal);
    const repositoryIndex = new Map<string, number>();
    const summaries: GitHubAppAccessSummary[] = [];
    for (const installation of installations) {
      const token = await this.getInstallationToken(installation.id, signal);
      const repositories = await this.listInstallationRepositories(
        installation.id,
        token.token,
        signal,
      );
      for (const repository of repositories) {
        repositoryIndex.set(repository.fullName.toLowerCase(), installation.id);
      }
      summaries.push({
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        permissions: token.permissions,
        tokenExpiresAt: new Date(token.expiresAtMs).toISOString(),
        repositories: repositories.map((repository) => ({
          fullName: repository.fullName,
          owner: repository.owner,
          repository: repository.repository,
          permissions: repository.permissions,
        })),
      });
    }
    this.repositoryIndex = repositoryIndex;
    this.accessSummaries = summaries;
    return summaries;
  }

  private async getInstallationToken(
    installationId: number,
    signal?: AbortSignal,
  ): Promise<InstallationToken> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached;
    }
    const pending = this.tokenPromises.get(installationId);
    if (pending) {
      return pending;
    }
    const promise = this.refreshInstallationToken(installationId, signal);
    this.tokenPromises.set(installationId, promise);
    try {
      const token = await promise;
      this.tokenCache.set(installationId, token);
      return token;
    } finally {
      if (this.tokenPromises.get(installationId) === promise) {
        this.tokenPromises.delete(installationId);
      }
    }
  }

  private async refreshInstallationToken(
    installationId: number,
    signal?: AbortSignal,
  ): Promise<InstallationToken> {
    const payload = await this.requestJson<InstallationTokenResponse>({
      endpoint: PROJECT_PROGRESS_ENDPOINTS.githubAppInstallationTokenCreate,
      repositoryKey: `github-app-installation:${installationId}`,
      path: `/app/installations/${installationId}/access_tokens`,
      method: "POST",
      authHeader: await this.buildAppAuthorizationHeader(),
      acceptedStatuses: [201],
      signal,
    });
    if (typeof payload.token !== "string" || typeof payload.expires_at !== "string") {
      throw new Error("GitHub App installation token 响应无效。");
    }
    const expiresAtMs = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("GitHub App installation token 过期时间无效。");
    }
    return {
      token: payload.token,
      expiresAtMs,
      permissions: isRecord(payload.permissions)
        ? Object.fromEntries(
            Object.entries(payload.permissions).map(([key, value]) => [key, String(value)]),
          )
        : {},
    };
  }

  private async listInstallations(
    signal?: AbortSignal,
  ): Promise<InstallationRecord[]> {
    const payload = await this.requestJson<AppInstallationResponse[]>({
      endpoint: PROJECT_PROGRESS_ENDPOINTS.githubAppInstallationsList,
      repositoryKey: "github-app-installations",
      path: "/app/installations",
      authHeader: await this.buildAppAuthorizationHeader(),
      signal,
    });
    if (!Array.isArray(payload)) {
      throw new Error("GitHub App installations 响应不是数组。");
    }
    return payload.map((item) => ({
      id: item.id,
      accountLogin: typeof item.account?.login === "string" ? item.account.login : null,
      accountType: typeof item.account?.type === "string" ? item.account.type : null,
      repositorySelection: typeof item.repository_selection === "string"
        ? item.repository_selection
        : null,
    }));
  }

  private async listInstallationRepositories(
    installationId: number,
    installationToken: string,
    signal?: AbortSignal,
  ): Promise<InstallationRepositoryRecord[]> {
    const repositories: InstallationRepositoryRecord[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.requestJson<InstallationRepositoriesResponse>({
        endpoint: PROJECT_PROGRESS_ENDPOINTS.githubAppInstallationRepositoriesList,
        repositoryKey: `github-app-installation:${installationId}`,
        path: "/installation/repositories",
        query: { per_page: 100, page },
        authHeader: `Bearer ${installationToken}`,
        signal,
      });
      if (!isRecord(payload) || !Array.isArray(payload.repositories)) {
        throw new Error("GitHub App installation repositories 响应无效。");
      }
      const pageRepositories = payload.repositories.map((item) => {
        if (
          typeof item.full_name !== "string" ||
          typeof item.owner?.login !== "string" ||
          typeof item.name !== "string"
        ) {
          throw new Error("GitHub App installation repository 响应无效。");
        }
        return {
          ...normalizeRepositoryIdentity(item.full_name, item.owner.login, item.name),
          permissions: isRecord(item.permissions)
            ? Object.fromEntries(
                Object.entries(item.permissions).map(([key, value]) => [key, Boolean(value)]),
              )
            : {},
        };
      });
      repositories.push(...pageRepositories);
      if (
        typeof payload.total_count === "number" &&
        repositories.length >= payload.total_count
      ) {
        return repositories;
      }
      if (pageRepositories.length < 100) {
        return repositories;
      }
    }
  }

  private async requestJson<T>(input: {
    endpoint: string;
    repositoryKey: string;
    path: string;
    method?: string;
    query?: Record<string, string | number>;
    authHeader: string;
    acceptedStatuses?: readonly number[];
    signal?: AbortSignal;
  }): Promise<T> {
    const url = new URL(input.path, this.apiBaseUrl);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const requestSignal = input.signal
      ? AbortSignal.any([
          input.signal,
          AbortSignal.timeout(GITHUB_APP_REQUEST_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(GITHUB_APP_REQUEST_TIMEOUT_MS);
    const request = async () => {
      const response = await this.requestExecutor.execute(
        () => this.fetchImpl(url, {
          method: input.method ?? "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: input.authHeader,
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "oa-project-progress-worker",
          },
          signal: requestSignal,
        }),
        {
          repository: input.repositoryKey,
          signal: requestSignal,
          ...(input.acceptedStatuses ? { acceptedStatuses: input.acceptedStatuses } : {}),
        },
      );
      return readLimitedJson(response, RESPONSE_LIMIT_BYTES) as Promise<T>;
    };
    return this.operationMetrics
      ? this.operationMetrics.measure(input.endpoint, request)
      : request();
  }

  private async buildAppAuthorizationHeader(): Promise<string> {
    return `Bearer ${this.createAppJwt()}`;
  }

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1_000);
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64UrlEncode(JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.appId,
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const signature = signer.sign(this.privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function normalizeRepositoryName(value: string): string {
  const normalized = value.trim();
  if (!normalized || !normalized.includes("/")) {
    throw new Error(`GitHub repository 格式无效:${value}`);
  }
  return normalized;
}

function normalizeRepositoryIdentity(
  fullName: string,
  owner: string,
  repository: string,
): GitHubRepositoryIdentity {
  const normalized = normalizeRepositoryName(fullName);
  const [resolvedOwner, resolvedRepository] = normalized.split("/", 2);
  return {
    owner: resolvedOwner ?? owner,
    repository: resolvedRepository ?? repository,
    fullName: normalized,
    canonicalUrl: `https://github.com/${normalized}`,
  };
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new Error("GitHub 响应为空。");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error("GitHub 响应超出大小限制。");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return text.trim() ? JSON.parse(text) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
