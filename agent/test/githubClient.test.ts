import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubRequestError,
  GitHubRestProjectReader,
} from "../src/infrastructure/github/githubClient.js";
import { normalizeGitHubRepositoryUrl } from "../src/infrastructure/github/githubUrl.js";

describe("GitHubRestProjectReader", () => {
  it("deduplicates commits across branches and caches a shared repository", async () => {
    const requestCounts = new Map<string, number>();
    const reader = new GitHubRestProjectReader("token", async (input) => {
      const url = new URL(String(input));
      requestCounts.set(url.pathname, (requestCounts.get(url.pathname) ?? 0) + 1);
      if (url.pathname === "/repos/example/shared") {
        return Response.json({
          id: 99,
          full_name: "example/shared",
          created_at: "2025-01-01T00:00:00Z",
        });
      }
      if (url.pathname === "/repos/example/shared/branches") {
        return Response.json([{ name: "main" }, { name: "develop" }]);
      }
      if (url.pathname === "/repos/example/shared/commits") {
        const branch = url.searchParams.get("sha");
        return Response.json([
          githubCommit("same", "2026-07-24T01:00:00Z"),
          ...(branch === "main" ? [githubCommit("main-only", "2026-07-24T02:00:00Z")] : []),
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const repository = normalizeGitHubRepositoryUrl("https://github.com/example/shared");

    const first = await reader.readRepository(repository, new Date("2026-07-24T12:00:00Z"));
    const second = await reader.readRepository(repository, new Date("2026-07-24T12:00:00Z"));

    assert.equal(first, second);
    assert.deepEqual(first.commits.map((commit) => commit.sha), ["same", "main-only"]);
    assert.equal(requestCounts.get("/repos/example/shared"), 1);
    assert.equal(requestCounts.get("/repos/example/shared/branches"), 1);
    assert.equal(requestCounts.get("/repos/example/shared/commits"), 2);
  });

  it("uses repository creation time for an empty repository", async () => {
    const reader = new GitHubRestProjectReader("token", async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.pathname.endsWith("/branches")
          ? []
          : {
              id: 100,
              full_name: "example/empty",
              created_at: "2026-07-20T00:00:00Z",
            },
      );
    });

    const snapshot = await reader.readRepository(
      normalizeGitHubRepositoryUrl("https://github.com/example/empty"),
      new Date("2026-07-24T12:00:00Z"),
    );

    assert.equal(snapshot.lastActivityAt, "2026-07-20T00:00:00.000Z");
    assert.deepEqual(snapshot.commits, []);
  });

  it("classifies GitHub rate-limit failures with a retry time", async () => {
    const reader = new GitHubRestProjectReader(
      "token",
      async () => new Response("forbidden", {
        status: 403,
        headers: { "x-ratelimit-reset": "1784894400" },
      }),
    );

    await assert.rejects(
      reader.readRepository(
        normalizeGitHubRepositoryUrl("https://github.com/example/private"),
        new Date("2026-07-24T12:00:00Z"),
      ),
      (error) => error instanceof GitHubRequestError && error.retryAt !== null,
    );
  });

  it("rejects invalid JSON and malformed branch payloads", async () => {
    const repository = normalizeGitHubRepositoryUrl("https://github.com/example/broken");
    await assert.rejects(
      new GitHubRestProjectReader(
        "token",
        async () => new Response("not-json"),
      ).readRepository(repository, new Date("2026-07-24T12:00:00Z")),
      GitHubRequestError,
    );

    let calls = 0;
    await assert.rejects(
      new GitHubRestProjectReader("token", async () => {
        calls += 1;
        return calls === 1
          ? Response.json({
              id: 101,
              full_name: "example/broken",
              created_at: "2026-07-20T00:00:00Z",
            })
          : Response.json({ branches: [] });
      }).readRepository(repository, new Date("2026-07-24T12:00:00Z")),
      /branches 响应不是数组/,
    );
  });
});

function githubCommit(sha: string, date: string) {
  return {
    sha,
    commit: {
      message: `commit ${sha}\nbody is not collected`,
      committer: { date },
    },
  };
}
