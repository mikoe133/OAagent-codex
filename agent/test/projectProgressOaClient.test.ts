import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OaContractError,
  OaRequestError,
  ProjectProgressLeaseLostError,
  ProjectProgressOaClient,
} from "../src/infrastructure/oa/projectProgressOaClient.js";
import type {
  OaRequestExecutor,
  OaRequestLane,
} from "../src/infrastructure/oa/oaRequestScheduler.js";
import { OaRequestScheduler } from "../src/infrastructure/oa/oaRequestScheduler.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";

describe("ProjectProgressOaClient", () => {
  it("decodes every page from the OA project envelope", async () => {
    const requestedPages: string[] = [];
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "production",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async (input) => {
        const url = new URL(String(input));
        requestedPages.push(url.searchParams.get("page") ?? "");
        const page = Number(url.searchParams.get("page"));
        return Response.json({
          code: 200,
          success: true,
          data: {
            total: 2,
            items: [
              {
                id: page,
                project_name: `project-${page}`,
                status: page === 1 ? "updating" : "maintenance",
                github_urls: [],
              },
            ],
          },
        });
      },
    );

    const projects = await client.listProjects();

    assert.deepEqual(requestedPages, ["1", "2"]);
    assert.deepEqual(projects.map((project) => project.id), [1, 2]);
  });

  it("records OA reads and request failures under stable endpoint names", async () => {
    const metrics = new OperationMetricsRecorder();
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "production",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/projects/2")) {
          return new Response("not-json", { status: 502 });
        }
        return Response.json({
          data: {
            id: 1,
            project_name: "measured",
            status: "updating",
            github_urls: [],
          },
        });
      },
      metrics,
      { getRetry: { random: () => 0 } },
    );

    await client.getProject(1);
    await assert.rejects(
      client.getProject(2),
      (error: unknown) => error instanceof OaRequestError && error.status === 502,
    );

    assert.deepEqual(metrics.snapshot().map((item) => ({
      endpoint: item.endpoint,
      requests: item.requests,
      successes: item.successes,
      failures: item.failures,
    })), [{
      endpoint: "oa.project.get",
      requests: 2,
      successes: 1,
      failures: 1,
    }]);
  });

  it("rejects malformed or unknown project status values", async () => {
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Cookie",
        tokenPrefix: "sessionid=",
      },
      async () => Response.json({ data: { total: 1, items: [{ id: 1, status: "paused" }] } }),
    );

    await assert.rejects(client.listProjects(), OaContractError);
  });

  it("routes reads to P2, mutations to P1, and propagates AbortSignal", async () => {
    const calls: Array<{ lane: OaRequestLane; signal?: AbortSignal }> = [];
    const scheduler: OaRequestExecutor = {
      run: async (lane, operation, options = {}) => {
        calls.push({ lane, ...(options.signal ? { signal: options.signal } : {}) });
        return await operation();
      },
    };
    const controller = new AbortController();
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async (_input, init) => {
        assert.ok(init?.signal);
        if (init?.method === "PATCH") {
          return Response.json({ data: { id: 7 } });
        }
        return Response.json({ data: { total: 0, items: [] } });
      },
      undefined,
      { scheduler },
    );

    await client.listProjects(controller.signal);
    await client.updateProjectStatus(7, "maintenance", undefined, controller.signal);

    assert.deepEqual(calls.map((call) => call.lane), ["p2", "p1"]);
    assert.equal(calls[0]?.signal, controller.signal);
    assert.equal(calls[1]?.signal, controller.signal);
  });

  it("reads and writes weekly report content through the weekly report endpoint", async () => {
    const requested: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    let weeklyReads = 0;
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async (input, init) => {
        const url = new URL(String(input));
        requested.push({
          method: init?.method ?? "GET",
          url: url.toString(),
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
            : {}),
        });
        if (init?.method === "POST") {
          return Response.json({
            code: 200,
            success: true,
            data: {
              weekly_num: 202635,
              content: "existing\n\nnew block",
            },
          });
        }
        weeklyReads += 1;
        return Response.json({
          code: 200,
          success: true,
          data: weeklyReads === 1
            ? {
                id: "weekly-report-1",
                weekly_num: 202635,
                owner_id: 42,
                content: "existing",
                version: 3,
                updated_at: "2026-08-27T09:30:00Z",
                deleted: false,
              }
            : {
                id: "weekly-report-1",
                weekly_num: 202635,
                owner_id: 42,
                content: "existing\n\nnew block",
                version: 4,
                updated_at: "2026-08-27T09:35:00Z",
                deleted: false,
              },
        });
      },
      undefined,
      { getRetry: { random: () => 0 } },
    );

    const before = await client.getWeeklyReportByWeek(202635);
    const after = await client.upsertWeeklyReportContent({
      weeklyNum: 202635,
      content: "existing\n\nnew block",
    });

    assert.equal(before.content, "existing");
    assert.equal(after.content, "existing\n\nnew block");
    assert.deepEqual(requested[0], {
      method: "GET",
      url: "https://oa.example.test/weekly-report/report?weekly_num=202635&alias=default",
    });
    assert.deepEqual(requested[1], {
      method: "POST",
      url: "https://oa.example.test/weekly-report/report?alias=default",
      body: {
        weekly_num: 202635,
        content: "existing\n\nnew block",
      },
    });
    assert.equal(weeklyReads, 2);
  });

  it("aborts an in-flight OA read with the caller signal", async () => {
    const controller = new AbortController();
    let started = false;
    const client = createClient(async (_input, init) => {
      started = true;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    const pending = client.listProjects(controller.signal);
    await waitUntil(() => started);

    controller.abort(new Error("work cancelled"));

    await assert.rejects(pending, /work cancelled/);
  });

  it("retries classified GET failures outside the scheduler permit", async () => {
    const scheduler = new OaRequestScheduler({ totalConcurrency: 1 });
    let attempts = 0;
    let backoffs = 0;
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return Response.json({ data: { error_code: "unavailable" } }, { status: 503 });
        }
        if (attempts === 2) {
          throw new TypeError("socket reset");
        }
        return Response.json({ data: { total: 0, items: [] } });
      },
      undefined,
      {
        scheduler,
        getRetry: {
          random: () => 0,
          sleep: async (_delayMs, signal) => {
            backoffs += 1;
            assert.equal(scheduler.metrics.activeTotal, 0);
            signal?.throwIfAborted();
          },
        },
      },
    );

    assert.deepEqual(await client.listProjects(), []);
    assert.equal(attempts, 3);
    assert.equal(backoffs, 2);
  });

  it("does not retry non-transient GET failures or mutations", async () => {
    let getAttempts = 0;
    const getClient = createClient(async () => {
      getAttempts += 1;
      return Response.json({ data: { error_code: "not_found" } }, { status: 404 });
    });
    await assert.rejects(getClient.listProjects(), (error: unknown) =>
      error instanceof OaRequestError && error.status === 404
    );

    let mutationAttempts = 0;
    const mutationClient = createClient(async () => {
      mutationAttempts += 1;
      return Response.json({ data: { error_code: "unavailable" } }, { status: 503 });
    });
    await assert.rejects(
      mutationClient.updateProjectStatus(7, "maintenance"),
      (error: unknown) => error instanceof OaRequestError && error.status === 503,
    );

    assert.equal(getAttempts, 1);
    assert.equal(mutationAttempts, 1);
  });

  it("retries a non-JSON 5xx response but not a non-JSON success", async () => {
    let transientAttempts = 0;
    const transientClient = createClient(async () => {
      transientAttempts += 1;
      return transientAttempts < 3
        ? new Response("gateway unavailable", { status: 503 })
        : Response.json({ data: { total: 0, items: [] } });
    });

    assert.deepEqual(await transientClient.listProjects(), []);
    assert.equal(transientAttempts, 3);

    let successAttempts = 0;
    const malformedSuccessClient = createClient(async () => {
      successAttempts += 1;
      return new Response("not-json");
    });
    await assert.rejects(malformedSuccessClient.listProjects(), OaContractError);
    assert.equal(successAttempts, 1);
  });

  it("cancels OA GET retry backoff immediately", async () => {
    const controller = new AbortController();
    const backoffStarted = deferred<void>();
    let attempts = 0;
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async () => {
        attempts += 1;
        return Response.json({ data: { error_code: "too_many_requests" } }, {
          status: 429,
        });
      },
      undefined,
      {
        getRetry: {
          sleep: async (_delayMs, signal) => {
            backoffStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        },
      },
    );
    const pending = client.listProjects(controller.signal);
    const observed = pending.catch((error: unknown) => error);
    await Promise.race([
      backoffStarted.promise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("retry backoff did not start")), 100);
        timer.unref();
      }),
    ]);

    controller.abort(new Error("run cancelled"));

    assert.match(String(await observed), /run cancelled/);
    assert.equal(attempts, 1);
  });

  it("sends only a status field when updating a test project", async () => {
    let request: Request | null = null;
    const client = createClient(async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: { id: 7 } });
    });

    await client.updateProjectStatus(7, "maintenance");

    assert.equal(request?.method, "PATCH");
    assert.equal(
      new URL(request?.url ?? "").pathname,
      "/internal/project-sync/projects/7/status",
    );
    assert.deepEqual(await request?.json(), { status: "maintenance" });
  });

  it("fences project and summary mutations with stable idempotency and versions", async () => {
    const requests: Request[] = [];
    const client = createFencedClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/status")) {
        return Response.json({ data: { id: 7, version: 4 } });
      }
      return Response.json({ data: {
        id: 101,
        project_id: 7,
        summary_date: "2026-07-24",
        summary: "更新后的总结。",
        ai_confidence: 91,
        ai_note: "已更新。",
        version: 3,
      } });
    });

    await client.updateProjectStatus(7, "maintenance", 3);
    await client.updateProjectStatus(7, "maintenance", 3);
    await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
    });
    await client.updateCommitSummary(101, {
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
      expectedVersion: 2,
    });

    const statusBody = await requests[0]!.json() as Record<string, unknown>;
    const repeatedStatusBody = await requests[1]!.json() as Record<string, unknown>;
    const createBody = await requests[2]!.json() as Record<string, unknown>;
    const summaryBody = await requests[3]!.json() as Record<string, unknown>;
    assert.deepEqual(statusBody, {
      status: "maintenance",
      expected_version: 3,
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: statusBody.idempotency_key,
    });
    assert.deepEqual(summaryBody, {
      summary: "更新后的总结。",
      ai_confidence: 91,
      ai_note: "已更新。",
      expected_version: 2,
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: summaryBody.idempotency_key,
    });
    assert.deepEqual(createBody, {
      project_id: 7,
      summary_date: "2026-07-24",
      summary: "更新后的总结。",
      ai_confidence: 91,
      ai_note: "已更新。",
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: createBody.idempotency_key,
    });
    assert.match(String(statusBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(summaryBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(createBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.equal(statusBody.idempotency_key, repeatedStatusBody.idempotency_key);
    assert.notEqual(statusBody.idempotency_key, summaryBody.idempotency_key);
  });

  it("queries and creates a project-level daily summary", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json({ data: { total: 0, items: [] } });
      }
      return Response.json({
        data: {
          id: 101,
          project_id: 7,
          summary_date: "2026-07-24",
          summary: "完成登录修复。",
          ai_confidence: 90,
          ai_note: "基于 1 条提交。",
          created_at: 1,
          updated_at: 1,
        },
      });
    });

    assert.deepEqual(await client.listCommitSummaries(7, "2026-07-24"), []);
    const created = await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "完成登录修复。",
      aiConfidence: 90,
      aiNote: "基于 1 条提交。",
    });

    assert.equal(created.id, 101);
    assert.equal(requests[1]?.method, "POST");
    assert.equal(
      new URL(requests[1]?.url ?? "").pathname,
      "/internal/project-sync/github-commit-summaries",
    );
    assert.deepEqual(await requests[1]?.json(), {
      project_id: 7,
      summary_date: "2026-07-24",
      summary: "完成登录修复。",
      ai_confidence: 90,
      ai_note: "基于 1 条提交。",
    });
  });

  it("reads the summary back when a mutation response only contains its id", async () => {
    let calls = 0;
    const client = createClient(async (_input, init) => {
      calls += 1;
      if (init?.method === "POST") {
        return Response.json({ data: { id: 202 } });
      }
      return Response.json({
        data: {
          id: 202,
          project_id: 7,
          summary_date: "2026-07-24",
          summary: "完成回读。",
          ai_confidence: 88,
          ai_note: "",
        },
      });
    });

    const created = await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "完成回读。",
      aiConfidence: 88,
      aiNote: "",
    });

    assert.equal(created.id, 202);
    assert.equal(calls, 2);
  });

  it("reads project details and updates a managed summary", async () => {
    const methods: string[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      if (new URL(request.url).pathname === "/internal/project-sync/projects/7") {
        return Response.json({ data: {
          id: 7,
          project_name: "project-7",
          status: "updating",
          github_urls: [],
          version: 3,
        } });
      }
      return Response.json({ data: {
        id: 101,
        project_id: 7,
        summary_date: "2026-07-24",
        summary: "更新后的总结。",
        ai_confidence: 91,
        ai_note: "已更新。",
        version: 2,
      } });
    });

    assert.equal((await client.getProject(7)).version, 3);
    assert.equal((await client.getCommitSummary(101)).version, 2);
    assert.equal((await client.updateCommitSummary(101, {
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
    })).id, 101);
    assert.deepEqual(methods, ["GET", "GET", "PATCH"]);
  });

  it("classifies HTTP and malformed JSON failures", async () => {
    await assert.rejects(
      createClient(async () => Response.json({
        code: 503,
        message: "unavailable",
        data: { error_code: "service_unavailable" },
        success: false,
      }, { status: 503 })).listProjects(),
      (error: unknown) =>
        error instanceof OaRequestError &&
        error.status === 503 &&
        error.errorCode === "service_unavailable",
    );
    await assert.rejects(
      createClient(async () => new Response("not-json")).listProjects(),
      OaContractError,
    );
  });

  it("classifies a definitive fencing rejection as lease loss", async () => {
    const client = createFencedClient(async () => Response.json({
      code: 409,
      message: "stale worker",
      data: { error_code: "stale_fencing_token" },
      success: false,
    }, { status: 409 }));

    await assert.rejects(
      client.updateProjectStatus(7, "maintenance", 3),
      (error: unknown) =>
        error instanceof ProjectProgressLeaseLostError &&
        error.status === 409 &&
        error.errorCode === "stale_fencing_token",
    );
  });

  it("rejects unsuccessful envelopes and accepts an empty final page", async () => {
    await assert.rejects(
      createClient(async () => Response.json({ success: false, data: null })).listProjects(),
      /success=false/,
    );
    assert.deepEqual(
      await createClient(async () => Response.json({
        success: true,
        data: { total: 0, items: [] },
      })).listProjects(),
      [],
    );
  });
});

function createClient(fetchImpl: typeof fetch): ProjectProgressOaClient {
  return new ProjectProgressOaClient(
    {
      baseUrl: "https://oa.example.test",
      alias: "default",
      token: "secret",
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer",
    },
    fetchImpl,
    undefined,
    { getRetry: { random: () => 0 } },
  );
}

function createFencedClient(fetchImpl: typeof fetch): ProjectProgressOaClient {
  return new ProjectProgressOaClient(
    {
      baseUrl: "https://oa.example.test",
      alias: "default",
      token: "secret",
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer",
      mutationContext: {
        runId: "run-01",
        runMutationToken: "run-mutation-secret",
        fencingToken: 7,
      },
    },
    fetchImpl,
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
