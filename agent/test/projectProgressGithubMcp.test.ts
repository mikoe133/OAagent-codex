import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  GitHubCommitDetailTool,
  startProjectProgressGitHubMcpServer,
  type ProjectProgressAgentLimits,
} from "../src/infrastructure/github/projectProgressMcpServer.js";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";
import { GitHubRequestExecutor } from "../src/infrastructure/github/githubRequestExecutor.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";

const limits: ProjectProgressAgentLimits = {
  maxDetailCalls: 3,
  maxFilesPerCommit: 2,
  maxFilenameChars: 12,
  maxPatchCharsPerFile: 5,
  maxTotalPatchChars: 7,
};

const candidates = [{ repositoryFullName: "example/api", sha: "abcdef123456" }];

describe("GitHubCommitDetailTool", () => {
  it("rejects a repository or SHA outside the current candidate set", async () => {
    let fetchCalls = 0;
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
      },
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
    );

    const result = await tool.readCommitDetails({
      repository: "example/api",
      sha: "not-allowed",
    });

    assert.equal(result.status, "error");
    assert.equal(fetchCalls, 0);
    assert.equal(tool.getMetrics().rejectedCalls, 1);
  });

  it("sorts files and enforces filename, file-count, and patch budgets", async () => {
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
      },
      async (request, init) => {
        assert.match(String(request), /repos\/example\/api\/commits\/abcdef123456/);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
        return Response.json({
          stats: { additions: 20, deletions: 8, total: 28 },
          files: [
            {
              filename: "src/minor.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: "minor",
            },
            {
              filename: "src/very-long-important-file.ts",
              status: "modified",
              additions: 10,
              deletions: 4,
              changes: 14,
              patch: "abcdefghij",
            },
            {
              filename: "src/second.ts",
              status: "added",
              additions: 8,
              deletions: 0,
              changes: 8,
              patch: "uvwxyz",
            },
          ],
        });
      },
    );

    const result = await tool.readCommitDetails({
      repository: "example/api",
      sha: "abcdef123456",
    });

    assert.equal(result.status, "warning");
    assert.deepEqual(result.data.stats, { additions: 20, deletions: 8, changes: 28 });
    assert.deepEqual(result.data.files.map((file) => file.changes), [14, 8]);
    assert.equal(result.data.files[0]?.filename, "src/very-lon");
    assert.equal(result.data.files[0]?.filename_truncated, true);
    assert.equal(result.data.files[0]?.patch_excerpt, "abcde");
    assert.equal(result.data.files[1]?.patch_excerpt, "uv");
    assert.equal(result.budget.files_omitted, 1);
    assert.equal(result.budget.patch_chars_remaining, 0);
    assert.deepEqual(tool.getMetrics(), {
      detailCalls: 1,
      githubRequests: 1,
      filesReturned: 2,
      patchCharsReturned: 7,
      rejectedCalls: 0,
    });
  });

  it("does not fetch or return the same commit twice", async () => {
    let fetchCalls = 0;
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
      },
      async () => {
        fetchCalls += 1;
        return Response.json({
          stats: { additions: 1, deletions: 0, total: 1 },
          files: [],
        });
      },
    );

    await tool.readCommitDetails({ repository: "example/api", sha: "abcdef123456" });
    const duplicate = await tool.readCommitDetails({
      repository: "example/api",
      sha: "abcdef123456",
    });

    assert.equal(fetchCalls, 1);
    assert.equal(duplicate.status, "warning");
    assert.equal(tool.getMetrics().rejectedCalls, 1);
  });

  it("returns a safe error for GitHub failures", async () => {
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
      },
      async () => new Response("rate limited", { status: 429 }),
    );

    const result = await tool.readCommitDetails({
      repository: "example/api",
      sha: "abcdef123456",
    });

    assert.equal(result.status, "error");
    assert.match(result.summary, /HTTP 429/);
    assert.doesNotMatch(JSON.stringify(result), /github-secret|abcdef123456|example\/api/);
  });

  it("records bounded detail requests under github.commit.get", async () => {
    const operationMetrics = new OperationMetricsRecorder();
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
        operationMetrics,
      },
      async () => Response.json({
        stats: { additions: 1, deletions: 0, total: 1 },
        files: [],
      }),
    );

    await tool.readCommitDetails({
      repository: "example/api",
      sha: "abcdef123456",
    });

    assert.deepEqual(operationMetrics.snapshot().map((metric) => ({
      endpoint: metric.endpoint,
      requests: metric.requests,
      successes: metric.successes,
    })), [{
      endpoint: "github.commit.get",
      requests: 1,
      successes: 1,
    }]);
  });

  it("shares the GitHub HTTP limiter across independent repository tools", async () => {
    const limiter = new AsyncSemaphore(1);
    let activeRequests = 0;
    let peakRequests = 0;
    const createTool = (repositoryFullName: string, sha: string) => new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates: [{ repositoryFullName, sha }],
        limits,
        requestLimiter: limiter,
      },
      async () => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await delay(5);
        activeRequests -= 1;
        return Response.json({
          stats: { additions: 1, deletions: 0, total: 1 },
          files: [],
        });
      },
    );
    const first = createTool("example/api", "abcdef123456");
    const second = createTool("example/web", "fedcba654321");

    await Promise.all([
      first.readCommitDetails({ repository: "example/api", sha: "abcdef123456" }),
      second.readCommitDetails({ repository: "example/web", sha: "fedcba654321" }),
    ]);

    assert.equal(peakRequests, 1);
    assert.equal(limiter.metrics.peakActive, 1);
  });

  it("uses the shared GitHub executor for bounded transient retries", async () => {
    let calls = 0;
    const requestExecutor = new GitHubRequestExecutor({
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    const tool = new GitHubCommitDetailTool(
      {
        githubToken: "github-secret",
        githubApiBaseUrl: "https://api.github.test",
        candidates,
        limits,
        requestExecutor,
      },
      async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 503 })
          : Response.json({
              stats: { additions: 1, deletions: 0, total: 1 },
              files: [],
            });
      },
    );

    const result = await tool.readCommitDetails({
      repository: "example/api",
      sha: "abcdef123456",
    });

    assert.equal(result.status, "success");
    assert.equal(calls, 2);
    assert.equal(requestExecutor.metrics.retries, 1);
  });
});

describe("startProjectProgressGitHubMcpServer", () => {
  it("requires its one-time bearer token and serves the bounded tool", async () => {
    const server = await startProjectProgressGitHubMcpServer({
      githubToken: "github-secret",
      githubApiBaseUrl: "https://api.github.test",
      candidates,
      limits,
      fetchImpl: async () => Response.json({
        stats: { additions: 1, deletions: 0, total: 1 },
        files: [],
      }),
    });

    try {
      const unauthorized = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(unauthorized.status, 401);

      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: { authorization: `Bearer ${server.bearerToken}` },
        },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["read_commit_details"]);
      const result = await client.callTool({
        name: "read_commit_details",
        arguments: { repository: "example/api", sha: "abcdef123456" },
      });
      assert.equal(result.isError, false);
      await client.close();
    } finally {
      await server.close();
    }
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
