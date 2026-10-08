import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GitHubAppAuth } from "../src/infrastructure/github/githubAppAuth.js";
import { GitHubRestProjectReader } from "../src/infrastructure/github/githubClient.js";
import { GitHubRequestExecutor } from "../src/infrastructure/github/githubRequestExecutor.js";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";
import { normalizeGitHubRepositoryUrl } from "../src/infrastructure/github/githubUrl.js";

describe("GitHubAppAuth", () => {
  it("checks installations concurrently with a limit of three and preserves the full inventory", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      requestExecutor: new GitHubRequestExecutor({ sleep: async () => undefined }),
      fetchImpl: async (input, init) => {
        calls += 1;
        const path = new URL(String(input)).pathname;
        if (path === "/app/installations") return Response.json([1, 2, 3, 4, 5, 6].map(id => ({ id })));
        active += 1;
        peak = Math.max(peak, active);
        try {
          await delay(5);
          if (path.endsWith("/access_tokens")) {
            const id = path.split("/")[3]!;
            return Response.json({ token: `token-${id}`, expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" } }, { status: 201 });
          }
          const id = new Headers(init?.headers).get("authorization")!.split("-")[1]!;
          return Response.json({ total_count: 1, repositories: [{ full_name: `acme/repo-${id}`, owner: { login: "acme" }, name: `repo-${id}` }] });
        } finally {
          active -= 1;
        }
      },
    });

    const access = await auth.describeAccess();

    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(calls, 13);
    assert.deepEqual(access.map(item => item.repositories[0]!.fullName), [1, 2, 3, 4, 5, 6].map(id => `acme/repo-${id}`));
    assert.equal(await auth.getAuthorizationHeader("acme/repo-6"), "Bearer token-6");
    assert.equal(calls, 13, "the complete inventory should be cached");
  });

  it("cancels other installation checks after rejection and never caches a partial inventory", async (context) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    context.mock.method(console, "error", () => undefined);
    let rejectAccess = true;
    let active = 0;
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      requestExecutor: new GitHubRequestExecutor({ sleep: async () => assert.fail("permission failures must not retry") }),
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/app/installations") return Response.json([1, 2, 3, 4].map(id => ({ id })));
        if (path.endsWith("/access_tokens")) {
          const id = path.split("/")[3]!;
          if (rejectAccess) {
            active += 1;
            try {
              const signal = init!.signal!;
              await delay(id === "1" ? 5 : 500, undefined, { signal }).catch(() => { throw signal.reason; });
              return Response.json({ message: "Bad credentials" }, { status: 401 });
            } finally {
              active -= 1;
            }
          }
          return Response.json({ token: `token-${id}`, expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" } }, { status: 201 });
        }
        const id = new Headers(init?.headers).get("authorization")!.split("-")[1]!;
        return Response.json({ total_count: 1, repositories: [{ full_name: `acme/repo-${id}`, owner: { login: "acme" }, name: `repo-${id}` }] });
      },
    });

    await assert.rejects(auth.describeAccess(), /HTTP 401/);
    assert.equal(active, 0, "failed discovery must stop all in-flight requests");
    rejectAccess = false;
    const access = await auth.describeAccess();
    assert.equal(access.length, 4);
    assert.equal(await auth.getAuthorizationHeader("acme/repo-4"), "Bearer token-4");
  });

  for (const phase of ["connection", "body"] as const) {
    it(`retries a ${phase} timeout with a fresh request deadline`, async () => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const executor = new GitHubRequestExecutor({ sleep: async () => undefined });
      const installationSignals: AbortSignal[] = [];
      const auth = new GitHubAppAuth({
        appId: "12345",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        requestTimeoutMs: 20,
        requestExecutor: executor,
        fetchImpl: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/app/installations") {
            const signal = init!.signal!;
            installationSignals.push(signal);
            if (installationSignals.length === 1) {
              if (phase === "connection") {
                await delay(200, undefined, { signal }).catch(() => { throw signal.reason; });
                assert.fail("first request should time out");
              }
              return new Response(new ReadableStream({
                start(controller) {
                  void delay(200, undefined, { signal }).then(
                    () => controller.close(),
                    () => controller.error(signal.reason),
                  );
                },
              }));
            }
            signal.throwIfAborted();
            return Response.json([{ id: 11 }]);
          }
          if (path === "/app/installations/11/access_tokens") {
            return Response.json({ token: "test-token", expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" } }, { status: 201 });
          }
          return Response.json({ total_count: 1, repositories: [{ full_name: "acme/api", owner: { login: "acme" }, name: "api" }] });
        },
      });

      const access = await auth.describeAccess();

      assert.equal(access[0]?.repositories[0]?.fullName, "acme/api");
      assert.equal(installationSignals.length, 2);
      assert.notEqual(installationSignals[0], installationSignals[1]);
      assert.equal(installationSignals[0]!.aborted, true);
      assert.equal(installationSignals[1]!.aborted, false);
      assert.equal(executor.metrics.retries, 1);
    });
  }

  it("stops at the caller deadline without retrying and logs the failed endpoint safely", async (context) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const errors: string[] = [];
    context.mock.method(console, "error", (message: string) => errors.push(message));
    const executor = new GitHubRequestExecutor({ sleep: async () => assert.fail("cancelled calls must not retry") });
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://hidden-user:hidden-password@api.github.test",
      signal: AbortSignal.timeout(20),
      requestTimeoutMs: 200,
      requestExecutor: executor,
      fetchImpl: async (_input, init) => {
        const signal = init!.signal!;
        await delay(500, undefined, { signal }).catch(() => { throw signal.reason; });
        assert.fail("caller deadline should abort the request");
      },
    });

    await assert.rejects(auth.describeAccess(), (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");

    assert.equal(executor.metrics.attempts, 1);
    assert.equal(executor.metrics.retries, 0);
    const event = JSON.parse(errors[0]!);
    assert.equal(event.event, "github_app_request_failed");
    assert.equal(event.url, "https://api.github.test/app/installations");
    assert.equal(event.callerAborted, true);
    assert.equal(event.attempts, 1);
    assert.doesNotMatch(errors.join(""), /hidden-user|hidden-password|Bearer/);
  });

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

  it("does not deadlock when auth and repository reads share a request limiter", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const limiter = new AsyncSemaphore(2);
    const requestExecutor = new GitHubRequestExecutor({ requestLimiter: limiter });
    const fetchImpl = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/app/installations") {
        return Response.json([{ id: 11 }]);
      }
      if (path === "/app/installations/11/access_tokens") {
        return Response.json({
          token: "installation-token-11",
          expires_at: "2099-01-01T00:00:00Z",
        }, { status: 201 });
      }
      if (path === "/installation/repositories") {
        return Response.json({
          total_count: 2,
          repositories: ["one", "two"].map((name) => ({
            full_name: `example/${name}`,
            owner: { login: "example" },
            name,
          })),
        });
      }
      if (path.endsWith("/branches")) {
        return Response.json([]);
      }
      return Response.json({
        id: 1,
        full_name: path.slice("/repos/".length),
        created_at: "2026-01-01T00:00:00Z",
      });
    };
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://api.github.test",
      requestLimiter: limiter,
      requestExecutor,
      fetchImpl,
    });
    const reader = new GitHubRestProjectReader(
      auth,
      fetchImpl,
      "https://api.github.test",
      undefined,
      limiter,
      undefined,
      { requestExecutor },
    );
    const signal = AbortSignal.timeout(1_000);

    const snapshots = await Promise.all(["one", "two"].map((name) =>
      reader.readRepository(
        normalizeGitHubRepositoryUrl(`https://github.com/example/${name}`),
        new Date("2026-09-03T00:00:00Z"),
        signal,
      )
    ));

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots.every((snapshot) => snapshot.complete), true);
    assert.equal(limiter.metrics.active, 0);
  });
});
