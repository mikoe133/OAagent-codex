import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { GitHubAppAuth } from "../src/infrastructure/github/githubAppAuth.js";
import { GitHubRequestExecutor } from "../src/infrastructure/github/githubRequestExecutor.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";

describe("GitHubAppAuth", () => {
  it("maps repositories to installation tokens and reports accessible repositories", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const calls: Array<{ path: string; authorization: string | null; method: string }> = [];
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      apiBaseUrl: "https://api.github.test",
      requestExecutor: new GitHubRequestExecutor({ sleep: async () => undefined }),
      operationMetrics: new OperationMetricsRecorder(),
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        if (url.pathname === "/app/installations") {
          return Response.json([{
            id: 11,
            account: { login: "acme", type: "Organization" },
            repository_selection: "selected",
          }]);
        }
        if (url.pathname === "/app/installations/11/access_tokens") {
          return Response.json({
            token: "installation-token-11",
            expires_at: "2099-01-01T00:00:00Z",
            permissions: { contents: "read", metadata: "read" },
          }, { status: 201 });
        }
        if (url.pathname === "/installation/repositories") {
          return Response.json({
            total_count: 1,
            repositories: [{
              full_name: "acme/api",
              owner: { login: "acme" },
              name: "api",
              permissions: { contents: true, metadata: true },
            }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const summary = await auth.describeAccess();
    const header = await auth.getAuthorizationHeader("acme/api");

    assert.equal(header, "Bearer installation-token-11");
    assert.deepEqual(summary.map((item) => ({
      installationId: item.installationId,
      accountLogin: item.accountLogin,
      repositorySelection: item.repositorySelection,
      permissions: item.permissions,
      repositories: item.repositories.map((repository) => repository.fullName),
    })), [{
      installationId: 11,
      accountLogin: "acme",
      repositorySelection: "selected",
      permissions: { contents: "read", metadata: "read" },
      repositories: ["acme/api"],
    }]);
    assert.equal(calls[0]?.authorization?.startsWith("Bearer "), true);
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[2]?.authorization, "Bearer installation-token-11");
  });

  it("rejects repositories outside the GitHub App installation scope", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      apiBaseUrl: "https://api.github.test",
      requestExecutor: new GitHubRequestExecutor({ sleep: async () => undefined }),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/app/installations") {
          return Response.json([{ id: 11 }]);
        }
        if (url.pathname === "/app/installations/11/access_tokens") {
          return Response.json({
            token: "installation-token-11",
            expires_at: "2099-01-01T00:00:00Z",
          }, { status: 201 });
        }
        if (url.pathname === "/installation/repositories") {
          return Response.json({ total_count: 0, repositories: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await assert.rejects(
      auth.getAuthorizationHeader("acme/missing"),
      /当前不能读取仓库:acme\/missing/,
    );
  });
});
