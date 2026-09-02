import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";
import {
  GitHubRequestBudgetExceededError,
  GitHubRequestError,
  GitHubRequestExecutor,
} from "../src/infrastructure/github/githubRequestExecutor.js";

describe("GitHubRequestExecutor", () => {
  it("retries only rate limits and transient failures after releasing the global permit", async () => {
    const statuses = [429, 503, 200];
    const sleeps: number[] = [];
    const limiter = new AsyncSemaphore(1);
    let active = 0;
    let peak = 0;
    const executor = new GitHubRequestExecutor({
      requestLimiter: limiter,
      baseBackoffMs: 10,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        assert.equal(limiter.metrics.active, 0);
      },
    });

    const response = await executor.execute(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(1);
      active -= 1;
      const status = statuses.shift() ?? 200;
      return status === 200
        ? Response.json({ ok: true })
        : new Response("busy", {
            status,
            headers: status === 429 ? { "retry-after": "0" } : {},
          });
    }, { repository: "example/api" });

    assert.equal(response.status, 200);
    assert.equal(peak, 1);
    assert.equal(sleeps.length, 2);
    assert.deepEqual(executor.metrics, {
      attempts: 3,
      retries: 2,
      rateLimited: 1,
      serverErrors: 1,
      rejectedByBudget: 0,
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      rateLimitReserve: null,
      pacingWaitMs: 0,
      sharedPauseWaitMs: 0,
    });
  });

  it("does not retry permanent client failures", async () => {
    for (const status of [401, 403, 404, 422]) {
      let calls = 0;
      const executor = new GitHubRequestExecutor({
        sleep: async () => assert.fail("permanent failure must not back off"),
      });

      await assert.rejects(
        executor.execute(async () => {
          calls += 1;
          return new Response("rejected", { status });
        }, { repository: `example/status-${status}` }),
        (error) => error instanceof GitHubRequestError && error.status === status,
      );
      assert.equal(calls, 1);
    }
  });

  it("includes safe GitHub error details and request id", async () => {
    const executor = new GitHubRequestExecutor();

    await assert.rejects(
      executor.execute(
        async () => Response.json(
          { message: "Bad credentials\nBearer secret-token" },
          {
            status: 401,
            headers: { "x-github-request-id": "request-123" },
          },
        ),
        { repository: "example/api" },
      ),
      (error) =>
        error instanceof GitHubRequestError &&
        error.message ===
          "GitHub 请求失败:HTTP 401:Bad credentials Bearer [REDACTED]:request_id=request-123",
    );
  });

  it("retries a primary rate-limit 403", async () => {
    let calls = 0;
    const executor = new GitHubRequestExecutor({ sleep: async () => undefined });

    const response = await executor.execute(async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", {
            status: 403,
            headers: {
              "retry-after": "0",
              "x-ratelimit-remaining": "0",
            },
          })
        : Response.json({ ok: true });
    }, { repository: "example/api" });

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(executor.metrics.rateLimited, 1);
  });

  it("enforces global and per-repository HTTP concurrency", async () => {
    const executor = new GitHubRequestExecutor({
      requestLimiter: new AsyncSemaphore(2),
    });
    let active = 0;
    let peak = 0;
    const activeByRepository = new Map<string, number>();
    const peakByRepository = new Map<string, number>();
    const operation = (repository: string) => executor.execute(async () => {
      active += 1;
      peak = Math.max(peak, active);
      const repositoryActive = (activeByRepository.get(repository) ?? 0) + 1;
      activeByRepository.set(repository, repositoryActive);
      peakByRepository.set(
        repository,
        Math.max(peakByRepository.get(repository) ?? 0, repositoryActive),
      );
      await delay(5);
      active -= 1;
      activeByRepository.set(repository, repositoryActive - 1);
      return Response.json({ ok: true });
    }, { repository });

    await Promise.all([
      operation("example/api"),
      operation("example/api"),
      operation("example/web"),
    ]);

    assert.equal(peak, 2);
    assert.equal(peakByRepository.get("example/api"), 1);
  });

  it("enforces run and repository request budgets", async () => {
    const runExecutor = new GitHubRequestExecutor({ maxRequestsPerRun: 1 });
    await runExecutor.execute(
      async () => Response.json({ ok: true }),
      { repository: "example/api" },
    );
    await assert.rejects(
      runExecutor.execute(
        async () => Response.json({ ok: true }),
        { repository: "example/web" },
      ),
      (error) => error instanceof GitHubRequestBudgetExceededError && error.scope === "run",
    );

    const repositoryExecutor = new GitHubRequestExecutor({
      maxRequestsPerRun: 10,
      maxRequestsPerRepository: 1,
    });
    await repositoryExecutor.execute(
      async () => Response.json({ ok: true }),
      { repository: "example/api" },
    );
    await assert.rejects(
      repositoryExecutor.execute(
        async () => Response.json({ ok: true }),
        { repository: "EXAMPLE/API" },
      ),
      (error) =>
        error instanceof GitHubRequestBudgetExceededError && error.scope === "repository",
    );
  });

  it("cancels a shared rate-limit pause before another request is issued", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let pauseStarted!: () => void;
    const pause = new Promise<void>((resolve) => {
      pauseStarted = resolve;
    });
    const executor = new GitHubRequestExecutor({
      sleep: async (_milliseconds, signal) => {
        pauseStarted();
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal?.aborted) reject(signal.reason);
          else void pause.then(resolve);
        });
      },
    });
    const request = executor.execute(async () => {
      attempts += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }, { repository: "example/api", signal: controller.signal });
    await pause;
    controller.abort(new Error("cancelled"));

    await assert.rejects(request, /cancelled/);
    assert.equal(attempts, 1);
  });

  it("paces new requests from the allocatable primary rate-limit window", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const executor = new GitHubRequestExecutor({
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    await executor.execute(
      async () => Response.json({ ok: true }, {
        headers: {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-remaining": "500",
          "x-ratelimit-reset": String((now + 100_000) / 1_000),
        },
      }),
      { repository: "example/api" },
    );

    let issuedAt = 0;
    await executor.execute(async () => {
      issuedAt = now;
      return Response.json({ ok: true });
    }, { repository: "example/web" });

    assert.equal(issuedAt, 1_000_250);
    assert.deepEqual(sleeps, [250]);
    assert.equal(executor.metrics.rateLimitReserve, 100);
    assert.equal(executor.metrics.pacingWaitMs, 250);
  });

  it("preserves the primary rate-limit reserve until reset", async () => {
    let now = 2_000_000;
    const executor = new GitHubRequestExecutor({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    await executor.execute(
      async () => Response.json({ ok: true }, {
        headers: {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-remaining": "100",
          "x-ratelimit-reset": String((now + 60_000) / 1_000),
        },
      }),
      { repository: "example/api" },
    );
    let calls = 0;

    await assert.rejects(
      executor.execute(async () => {
        calls += 1;
        return Response.json({ ok: true });
      }, { repository: "example/web" }),
      (error) =>
        error instanceof GitHubRequestBudgetExceededError &&
        error.scope === "rate_limit" &&
        error.retryAt === new Date(2_060_000).toISOString(),
    );
    assert.equal(calls, 0);
  });

  it("uses a 30 second shared pause for a secondary limit without Retry-After", async () => {
    let now = 3_000_000;
    const sleeps: number[] = [];
    let calls = 0;
    const executor = new GitHubRequestExecutor({
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    const response = await executor.execute(async () => {
      calls += 1;
      return calls === 1
        ? new Response("You have exceeded a secondary rate limit.", { status: 403 })
        : Response.json({ ok: true });
    }, { repository: "example/api" });

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [30_000]);
    assert.equal(executor.metrics.sharedPauseWaitMs, 30_000);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
