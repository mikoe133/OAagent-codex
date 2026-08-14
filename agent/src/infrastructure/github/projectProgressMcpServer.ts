import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import type { AsyncSemaphore } from "../concurrency/asyncSemaphore.js";
import { GitHubRequestExecutor } from "./githubRequestExecutor.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
} from "../observability/operationMetrics.js";

const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const MAX_GITHUB_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_GITHUB_FILES_PAGE_SIZE = 100;
const MCP_PATH = "/mcp";

export const PROJECT_PROGRESS_COMMIT_DETAIL_TOOL_POLICY_VERSION =
  "project-progress-commit-detail-v2";

type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProjectProgressAgentLimits = {
  maxDetailCalls: number;
  maxFilesPerCommit: number;
  maxFilenameChars: number;
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
};

export type ProjectProgressCommitCandidate = {
  repositoryFullName: string;
  sha: string;
};

export type ProjectProgressCommitDetailMetrics = {
  detailCalls: number;
  githubRequests: number;
  filesReturned: number;
  patchCharsReturned: number;
  rejectedCalls: number;
};

export type ProjectProgressCommitDetailResult = {
  status: "success" | "warning" | "error";
  summary: string;
  next_actions: string[];
  artifacts: [];
  data: {
    stats?: {
      additions: number;
      deletions: number;
      changes: number;
    };
    files: Array<{
      filename: string;
      filename_truncated: boolean;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch_excerpt: string | null;
      patch_truncated: boolean;
    }>;
  };
  budget: {
    detail_calls_used: number;
    detail_calls_remaining: number;
    files_returned: number;
    files_omitted: number;
    patch_chars_returned: number;
    patch_chars_remaining: number;
  };
};

export class GitHubCommitDetailTool {
  private readonly allowedCommits: Map<string, Set<string>>;
  private readonly requestExecutor: GitHubRequestExecutor;
  private readonly seenCommits = new Set<string>();
  private readonly metrics: ProjectProgressCommitDetailMetrics = {
    detailCalls: 0,
    githubRequests: 0,
    filesReturned: 0,
    patchCharsReturned: 0,
    rejectedCalls: 0,
  };

  constructor(
    private readonly config: {
      githubToken: string;
      githubApiBaseUrl: string;
      candidates: ProjectProgressCommitCandidate[];
      limits: ProjectProgressAgentLimits;
      requestLimiter?: AsyncSemaphore;
      requestExecutor?: GitHubRequestExecutor;
      operationMetrics?: OperationMetricsRecorder;
      signal?: AbortSignal;
    },
    private readonly fetchImpl: GitHubFetch = fetch,
  ) {
    this.allowedCommits = buildAllowedCommits(config.candidates);
    this.requestExecutor = config.requestExecutor ?? new GitHubRequestExecutor({
      ...(config.requestLimiter ? { requestLimiter: config.requestLimiter } : {}),
    });
  }

  getMetrics(): ProjectProgressCommitDetailMetrics {
    return { ...this.metrics };
  }

  async readCommitDetails(input: {
    repository: string;
    sha: string;
  }): Promise<ProjectProgressCommitDetailResult> {
    this.metrics.detailCalls += 1;
    const budget = this.buildBudget(0, 0);
    if (this.metrics.detailCalls > this.config.limits.maxDetailCalls) {
      this.metrics.rejectedCalls += 1;
      return errorResult("Commit 详情调用次数已达到本次任务上限。", budget);
    }

    const repository = normalizeRepositoryName(input.repository);
    const sha = input.sha.trim();
    const allowedShas = repository ? this.allowedCommits.get(repository.toLowerCase()) : undefined;
    if (!repository || !sha || !allowedShas?.has(sha)) {
      this.metrics.rejectedCalls += 1;
      return errorResult("该仓库或 Commit 不属于本次任务允许读取的候选集合。", budget);
    }

    const commitKey = `${repository.toLowerCase()}:${sha}`;
    if (this.seenCommits.has(commitKey)) {
      this.metrics.rejectedCalls += 1;
      return warningResult("该 Commit 详情已经读取过，本次不重复返回 Patch。", budget);
    }
    this.seenCommits.add(commitKey);

    let payload: unknown;
    try {
      payload = await this.requestCommit(repository, sha);
    } catch (error) {
      return errorResult(sanitizeToolError(error), this.buildBudget(0, 0));
    }

    let decoded: ReturnType<typeof decodeCommitDetails>;
    try {
      decoded = decodeCommitDetails(payload);
    } catch (error) {
      return errorResult(sanitizeToolError(error), this.buildBudget(0, 0));
    }
    const selectedFiles = decoded.files
      .sort((left, right) => right.changes - left.changes || left.filename.localeCompare(right.filename))
      .slice(0, this.config.limits.maxFilesPerCommit);
    let patchCharsRemaining = Math.max(
      0,
      this.config.limits.maxTotalPatchChars - this.metrics.patchCharsReturned,
    );
    let patchCharsReturned = 0;
    const files = selectedFiles.map((file) => {
      const filename = truncateText(file.filename, this.config.limits.maxFilenameChars);
      const rawPatch = file.patch ?? "";
      const patchLimit = Math.min(
        this.config.limits.maxPatchCharsPerFile,
        patchCharsRemaining,
      );
      const patchExcerpt = rawPatch ? rawPatch.slice(0, patchLimit) : null;
      const returnedChars = patchExcerpt?.length ?? 0;
      patchCharsRemaining -= returnedChars;
      patchCharsReturned += returnedChars;
      return {
        filename: filename.value,
        filename_truncated: filename.truncated,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch_excerpt: patchExcerpt,
        patch_truncated: rawPatch.length > returnedChars,
      };
    });

    this.metrics.filesReturned += files.length;
    this.metrics.patchCharsReturned += patchCharsReturned;
    const filesOmitted = Math.max(0, decoded.files.length - files.length);
    const hasTruncation = filesOmitted > 0 || files.some(
      (file) => file.filename_truncated || file.patch_truncated,
    );
    return {
      status: hasTruncation ? "warning" : "success",
      summary: hasTruncation
        ? "Commit 详情已按文件和 Patch 预算裁剪。"
        : "Commit 详情读取完成。",
      next_actions: [],
      artifacts: [],
      data: {
        stats: decoded.stats,
        files,
      },
      budget: this.buildBudget(files.length, filesOmitted, patchCharsReturned),
    };
  }

  private buildBudget(
    filesReturned: number,
    filesOmitted: number,
    patchCharsReturned = 0,
  ): ProjectProgressCommitDetailResult["budget"] {
    return {
      detail_calls_used: this.metrics.detailCalls,
      detail_calls_remaining: Math.max(
        0,
        this.config.limits.maxDetailCalls - this.metrics.detailCalls,
      ),
      files_returned: filesReturned,
      files_omitted: filesOmitted,
      patch_chars_returned: patchCharsReturned,
      patch_chars_remaining: Math.max(
        0,
        this.config.limits.maxTotalPatchChars - this.metrics.patchCharsReturned,
      ),
    };
  }

  private async requestCommit(repository: string, sha: string): Promise<unknown> {
    const [owner, name] = repository.split("/") as [string, string];
    const url = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}`,
      ensureTrailingSlash(this.config.githubApiBaseUrl),
    );
    url.searchParams.set("per_page", String(MAX_GITHUB_FILES_PAGE_SIZE));
    this.metrics.githubRequests += 1;
    const request = async () => {
      const execute = () => this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.config.githubToken}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "oa-project-progress-agent",
        },
        signal: this.config.signal
          ? AbortSignal.any([
            this.config.signal,
            AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
          ])
          : AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      const response = await this.requestExecutor.execute(execute, {
        repository,
        ...(this.config.signal ? { signal: this.config.signal } : {}),
      });
      return readLimitedJson(response, MAX_GITHUB_RESPONSE_BYTES);
    };
    return this.config.operationMetrics
      ? this.config.operationMetrics.measure(
        PROJECT_PROGRESS_ENDPOINTS.githubCommitGet,
        request,
      )
      : request();
  }
}

export type ProjectProgressGitHubMcpServer = {
  url: string;
  bearerToken: string;
  tool: GitHubCommitDetailTool;
  close(): Promise<void>;
};

export async function startProjectProgressGitHubMcpServer(input: {
  githubToken: string;
  githubApiBaseUrl: string;
  candidates: ProjectProgressCommitCandidate[];
  limits: ProjectProgressAgentLimits;
  fetchImpl?: GitHubFetch;
  requestLimiter?: AsyncSemaphore;
  requestExecutor?: GitHubRequestExecutor;
  operationMetrics?: OperationMetricsRecorder;
  signal?: AbortSignal;
}): Promise<ProjectProgressGitHubMcpServer> {
  const bearerToken = randomBytes(32).toString("base64url");
  const tool = new GitHubCommitDetailTool(input, input.fetchImpl);
  const activeServers = new Set<McpServer>();
  const httpServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== MCP_PATH) {
        response.writeHead(404).end();
        return;
      }
      if (!hasValidBearerToken(request.headers.authorization, bearerToken)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const requestMcpServer = createCommitDetailMcpServer(tool);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      activeServers.add(requestMcpServer);
      const cleanup = () => {
        activeServers.delete(requestMcpServer);
        void Promise.allSettled([
          transport.close(),
          requestMcpServer.close(),
        ]);
      };
      response.once("close", cleanup);
      try {
        await requestMcpServer.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        response.off("close", cleanup);
        cleanup();
        throw error;
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal_error" }));
      } else {
        response.end();
      }
    }
  });
  await listenOnLoopback(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("无法获取 Commit 详情 MCP 监听端口。");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}${MCP_PATH}`,
    bearerToken,
    tool,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await closeHttpServer(httpServer).catch(() => undefined);
      await Promise.allSettled(
        [...activeServers].map((server) => server.close()),
      );
      activeServers.clear();
    },
  };
}

function createCommitDetailMcpServer(tool: GitHubCommitDetailTool): McpServer {
  const server = new McpServer({
    name: "oa-project-progress-github",
    version: "1.0.0",
  });
  server.registerTool(
    "read_commit_details",
    {
      title: "Read allowed GitHub commit details",
      description: "Read bounded file statistics and patch excerpts for one allowed commit.",
      inputSchema: {
        repository: z.string().min(3).max(255),
        sha: z.string().min(7).max(64),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repository, sha }) => {
      const result = await tool.readCommitDetails({ repository, sha });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.status === "error",
      };
    },
  );
  return server;
}

function buildAllowedCommits(
  candidates: ProjectProgressCommitCandidate[],
): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const repository = normalizeRepositoryName(candidate.repositoryFullName);
    const sha = candidate.sha.trim();
    if (!repository || !sha) {
      continue;
    }
    const key = repository.toLowerCase();
    const shas = allowed.get(key) ?? new Set<string>();
    shas.add(sha);
    allowed.set(key, shas);
  }
  return allowed;
}

function normalizeRepositoryName(value: string): string | null {
  const normalized = value.trim();
  const parts = normalized.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    return null;
  }
  return normalized;
}

async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new Error("GitHub Commit 详情响应为空。");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("GitHub Commit 详情响应超过允许大小。");
      }
      chunks.push(value);
    }
    const payload = Buffer.concat(chunks, totalBytes).toString("utf8");
    return JSON.parse(payload) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("GitHub Commit 详情响应不是合法 JSON。");
    }
    throw error;
  }
}

function decodeCommitDetails(value: unknown): {
  stats: { additions: number; deletions: number; changes: number };
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string | null;
  }>;
} {
  if (!isRecord(value) || !isRecord(value.stats) || !Array.isArray(value.files)) {
    throw new Error("GitHub Commit 详情响应字段无效。");
  }
  const stats = {
    additions: nonNegativeInteger(value.stats.additions, "stats.additions"),
    deletions: nonNegativeInteger(value.stats.deletions, "stats.deletions"),
    changes: nonNegativeInteger(value.stats.total, "stats.total"),
  };
  const files = value.files.map((file) => {
    if (!isRecord(file) || typeof file.filename !== "string") {
      throw new Error("GitHub Commit 文件字段无效。");
    }
    return {
      filename: sanitizeDataText(file.filename),
      status: typeof file.status === "string" ? sanitizeDataText(file.status).slice(0, 40) : "unknown",
      additions: nonNegativeInteger(file.additions, "file.additions"),
      deletions: nonNegativeInteger(file.deletions, "file.deletions"),
      changes: nonNegativeInteger(file.changes, "file.changes"),
      patch: typeof file.patch === "string" ? sanitizePatch(file.patch) : null,
    };
  });
  return { stats, files };
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`GitHub Commit ${field} 无效。`);
  }
  return value as number;
}

function sanitizeDataText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function sanitizePatch(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

function truncateText(value: string, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}

function errorResult(
  summary: string,
  budget: ProjectProgressCommitDetailResult["budget"],
): ProjectProgressCommitDetailResult {
  return {
    status: "error",
    summary,
    next_actions: [],
    artifacts: [],
    data: { files: [] },
    budget,
  };
}

function warningResult(
  summary: string,
  budget: ProjectProgressCommitDetailResult["budget"],
): ProjectProgressCommitDetailResult {
  return {
    status: "warning",
    summary,
    next_actions: [],
    artifacts: [],
    data: { files: [] },
    budget,
  };
}

function sanitizeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : "GitHub Commit 详情读取失败。";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}

function hasValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function listenOnLoopback(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
