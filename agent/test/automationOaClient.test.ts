import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AutomationLeaseLostError,
  AutomationOaClient,
  AutomationOaContractError,
  type AutomationJobClaim,
} from "../src/infrastructure/oa/automationOaClient.js";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";
import type {
  OaRequestExecutor,
  OaRequestLane,
} from "../src/infrastructure/oa/oaRequestScheduler.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";

describe("AutomationOaClient", () => {
  it("records automation control calls under stable endpoint names", async () => {
    const metrics = new OperationMetricsRecorder();
    const client = new AutomationOaClient(
      { baseUrl: "https://oa.example.test", token: "secret" },
      async () => new Response(null, { status: 204 }),
      metrics,
    );

    const result = await client.claim({
      workerInstance: "worker-01",
      leaseSeconds: 300,
      claimRequestId: "123e4567-e89b-42d3-a456-426614174000",
    });

    assert.equal(result, null);
    assert.equal(metrics.snapshot()[0]?.endpoint, "oa.automation.claim");
    assert.equal(metrics.snapshot()[0]?.successes, 1);
  });

  it("rejects a non-UUID claim request id before sending", async () => {
    let requested = false;
    const client = new AutomationOaClient(
      { baseUrl: "https://oa.example.test", token: "secret" },
      async () => {
        requested = true;
        throw new Error("must not request");
      },
    );

    await assert.rejects(
      client.claim({
        workerInstance: "worker-01",
        leaseSeconds: 300,
        claimRequestId: "claim-request-01",
      }),
      /claimRequestId.*UUID/,
    );
    assert.equal(requested, false);
  });

  it("treats an empty claim response as an idle poll", async () => {
    const client = createClient(async () => new Response(null, { status: 204 }));

    assert.equal(await client.claim("worker-01", 300), null);
  });

  it("claims a run with the dedicated Bearer token", async () => {
    let request: Request | null = null;
    const client = createClient(async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: claimPayload() });
    });

    const claim = await client.claim({
      workerInstance: "worker-01",
      leaseSeconds: 300,
      claimRequestId: "019fd15d-32c6-7fb2-9afb-68be0996b80f",
    });

    assert.equal(claim?.runId, "run-01");
    assert.equal(claim?.modelProvider, "nexttoken");
    assert.deepEqual(claim?.executionParameters, {
      projectId: 51,
      summaryScope: "today",
    });
    assert.equal(claim?.runMutationToken, "run-mutation-secret");
    assert.equal(claim?.fencingToken, 7);
    assert.equal(claim?.concurrencyKey, "tenant-1:github_project_progress_sync:all_projects");
    assert.deepEqual(
      (claim as AutomationJobClaim & { promptProfile?: unknown } | null)?.promptProfile,
      {
        promptVersion: "sha256:oa-profile-v1",
        systemPrompt: "只总结已经完成的工程进展。",
        requiredCapabilities: ["github_project_tracking", "rwkvos_system_calls"],
      },
    );
    assert.equal(request?.headers.get("authorization"), "Bearer automation-secret");
    assert.deepEqual(await request?.json(), {
      worker_instance: "worker-01",
      supported_job_types: ["github_project_progress_sync"],
      lease_seconds: 300,
      claim_request_id: "019fd15d-32c6-7fb2-9afb-68be0996b80f",
    });
  });

  it("keeps decoding a legacy claim without fencing fields", async () => {
    const payload = claimPayload();
    delete payload.run_mutation_token;
    delete payload.fencing_token;
    delete payload.concurrency_key;
    const client = createClient(async () => Response.json({ data: payload }));

    const claim = await client.claim("worker-legacy", 300);

    assert.equal(claim?.runId, "run-01");
    assert.equal(claim?.runMutationToken, undefined);
    assert.equal(claim?.fencingToken, undefined);
    assert.equal(claim?.concurrencyKey, undefined);
  });

  it("keeps decoding a legacy claim without execution parameters", async () => {
    const payload = claimPayload();
    delete payload.execution_parameters;
    const client = createClient(async () => Response.json({ data: payload }));

    const claim = await client.claim("worker-legacy", 300);

    assert.deepEqual(claim?.executionParameters, {});
  });

  it("rejects a partially upgraded claim contract", async () => {
    const payload = claimPayload();
    delete payload.concurrency_key;
    const client = createClient(async () => Response.json({ data: payload }));

    await assert.rejects(
      client.claim("worker-01", 300),
      AutomationOaContractError,
    );
  });

  it("routes control, business, and trace calls while heartbeat bypasses the OA scheduler", async () => {
    const lanes: OaRequestLane[] = [];
    const scheduler: OaRequestExecutor = {
      run: async (_lane, operation) => {
        lanes.push(_lane);
        return await operation();
      },
    };
    const client = new AutomationOaClient(
      { baseUrl: "https://oa.example.test", token: "secret" },
      async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/claim") || pathname.endsWith("/trace-events")) {
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/heartbeat")) {
          return Response.json({ data: {
            status: "running",
            heartbeat_at: "2026-07-30T12:01:00Z",
            lease_expires_at: "2026-07-30T12:06:00Z",
            cancel_requested: false,
          } });
        }
        if (pathname.endsWith("/projects/51")) {
          return Response.json({ data: { run_project_id: 123 } });
        }
        return Response.json({ data: { run: { id: "run-01" } } });
      },
      undefined,
      { scheduler, heartbeatLimiter: new AsyncSemaphore(1) },
    );
    const claim = decodeClaimForTest();

    await client.claim("worker-01", 300);
    await client.upsertProjectResult({
      claim,
      workerInstance: "worker-01",
      projectId: 51,
      result: runProjectResultForTest(),
    });
    await client.upsertTraceEvent({
      claim,
      workerInstance: "worker-01",
      event: traceEventForTest(),
    });
    await client.updateRun({
      claim,
      workerInstance: "worker-01",
      status: "succeeded",
    });
    await client.heartbeat({
      claim,
      workerInstance: "worker-01",
      leaseSeconds: 300,
    });

    assert.deepEqual(lanes, ["p0", "p1", "p3", "p0"]);
  });

  it("keeps heartbeat at one in-flight request and propagates cancellation", async () => {
    const firstGate = deferred<void>();
    let heartbeatCalls = 0;
    let active = 0;
    let peak = 0;
    const client = new AutomationOaClient(
      { baseUrl: "https://oa.example.test", token: "secret" },
      async (_input, init) => {
        heartbeatCalls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (heartbeatCalls === 1) {
          await firstGate.promise;
        }
        init?.signal?.throwIfAborted();
        active -= 1;
        return Response.json({ data: {
          status: "running",
          heartbeat_at: "2026-07-30T12:01:00Z",
          lease_expires_at: "2026-07-30T12:06:00Z",
          cancel_requested: false,
        } });
      },
    );
    const claim = decodeClaimForTest();
    const first = client.heartbeat({
      claim,
      workerInstance: "worker-01",
      leaseSeconds: 300,
    });
    const controller = new AbortController();
    const second = client.heartbeat({
      claim,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      signal: controller.signal,
    });
    await waitUntil(() => heartbeatCalls === 1);

    controller.abort(new Error("lease lost"));
    await assert.rejects(second, /lease lost/);
    firstGate.resolve();
    await first;
    assert.equal(heartbeatCalls, 1);
    assert.equal(peak, 1);
  });

  it("sends heartbeats, project results, AI audits, and terminal status", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/heartbeat")) {
        return Response.json({ data: {
          status: "running",
          heartbeat_at: "2026-07-30T12:01:00Z",
          lease_expires_at: "2026-07-30T12:06:00Z",
          cancel_requested: false,
        } });
      }
      if (pathname.endsWith("/projects/51")) {
        return Response.json({ data: { run_project_id: 123 } });
      }
      if (pathname.endsWith("/ai-interactions")) {
        return Response.json({ data: { interaction_id: 456 } }, { status: 201 });
      }
      if (pathname.endsWith("/weekly-report-pending-items")) {
        return Response.json({ data: { pending_item_ids: [789] } });
      }
      if (pathname.endsWith("/trace-events")) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: { run: { id: "run-01" } } });
    });
    const claim = decodeClaimForTest();

    const heartbeat = await client.heartbeat({
      claim,
      workerInstance: "worker-01",
      leaseSeconds: 300,
    });
    const runProjectId = await client.upsertProjectResult({
      claim,
      workerInstance: "worker-01",
      projectId: 51,
      result: {
        projectNameSnapshot: "OA 服务端",
        statusBefore: "updating",
        statusAfter: "maintenance",
        outcome: "evaluated",
        repositoryCount: 1,
        commitCount: 2,
        summaryDate: "2026-07-30",
        sourceDigest: "sha256:digest",
        generatedSummary: "完成联调。",
        aiConfidence: 90,
        aiNote: "提交完整。",
        warnings: [],
        mutationsApplied: true,
        startedAt: "2026-07-30T12:00:00Z",
        finishedAt: "2026-07-30T12:01:00Z",
        durationMs: 60_000,
      },
    });
    const interactionId = await client.upsertAiInteraction({
      claim,
      workerInstance: "worker-01",
      interaction: {
        runProjectId,
        interactionKey: "project-51-2026-07-30-digest",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
        modelCatalogVersion: "catalog-v1",
        promptVersion: "prompt-v1",
        systemPromptSnapshot: "system prompt",
        requestPayloadSanitized: { commit_count: 2 },
        responsePayloadSanitized: { output_count: 1 },
        finalSummary: "完成联调。",
        limitations: [],
        fallbackUsed: false,
        upstreamRequestId: "request-01",
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: 500,
        status: "succeeded",
        errorCode: null,
        errorSummary: null,
      },
    });
    const pendingItemIds = await client.upsertWeeklyReportPendingItems({
      claim,
      workerInstance: "worker-01",
      items: [{
        segmentKey: "a".repeat(64),
        segmentOrder: 2,
        contentDigest: "b".repeat(64),
        originalContent: "项目 72：修复登录问题",
        aiSummary: "修复登录问题",
        aiReason: "项目目录中不存在 ID 72",
        reasonCode: "project_not_found",
        classificationSource: "agent",
        referencedProjectId: 72,
        candidateProjectIds: [],
        aiConfidence: 99,
      }],
    });
    await client.upsertTraceEvent({
      claim,
      workerInstance: "worker-01",
      event: {
        eventKey: "read_github",
        sequence: 300,
        phase: "read_github",
        status: "running",
        title: "读取 GitHub 分支与 Commit",
        message: "已读取 2/6 个仓库",
        progressCurrent: 2,
        progressTotal: 6,
        projectId: null,
        repositoryFullName: null,
        metadataSanitized: { github_concurrency: 6 },
        occurredAt: "2026-07-30T12:00:30.000Z",
      },
    });
    await client.updateRun({
      claim,
      workerInstance: "worker-01",
      status: "succeeded",
      mutationsApplied: true,
    });

    assert.equal(heartbeat.cancelRequested, false);
    assert.equal(runProjectId, 123);
    assert.equal(interactionId, 456);
    assert.deepEqual(pendingItemIds, [789]);
    assert.deepEqual(requests.map((request) => request.method), [
      "POST",
      "PUT",
      "POST",
      "PUT",
      "POST",
      "PATCH",
    ]);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      "/internal/automation-job-runs/run-01/heartbeat",
      "/internal/automation-job-runs/run-01/projects/51",
      "/internal/automation-job-runs/run-01/ai-interactions",
      "/internal/automation-job-runs/run-01/weekly-report-pending-items",
      "/internal/automation-job-runs/run-01/trace-events",
      "/internal/automation-job-runs/run-01",
    ]);
    const mutationBodies = await Promise.all(
      requests.slice(1).map(async (request) =>
        await request.json() as Record<string, unknown>
      ),
    );
    const auditBody = mutationBodies[1]!;
    assert.deepEqual(auditBody.request_payload_sanitized, { commit_count: 2 });
    assert.doesNotMatch(JSON.stringify(auditBody), /commit subject/);
    const pendingBody = mutationBodies[2]!;
    assert.equal((pendingBody.items as Array<Record<string, unknown>>)[0]?.reason_code, "project_not_found");
    const traceBody = mutationBodies[3]!;
    assert.deepEqual(traceBody, {
      worker_instance: "worker-01",
      lease_token: "lease-secret",
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: traceBody.idempotency_key,
      event_key: "read_github",
      sequence: 300,
      phase: "read_github",
      status: "running",
      title: "读取 GitHub 分支与 Commit",
      message: "已读取 2/6 个仓库",
      progress_current: 2,
      progress_total: 6,
      project_id: null,
      repository_full_name: null,
      metadata_sanitized: { github_concurrency: 6 },
      occurred_at: "2026-07-30T12:00:30.000Z",
    });
    assert.match(String(traceBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    for (const body of mutationBodies) {
      assert.equal(body.run_id, "run-01");
      assert.equal(body.run_mutation_token, "run-mutation-secret");
      assert.equal(body.fencing_token, 7);
      assert.match(String(body.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    }
  });

  it("looks up and saves weekly report summary bindings with the active lease", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return Response.json({
          data: {
            commit_summary_id: 901,
            source_version: 1,
          },
        });
      }
      return Response.json({
        data: {
          commit_summary_id: 901,
          source_version: 2,
        },
      });
    });
    const claim = decodeClaimForTest();

    const existing = await client.getWeeklyReportSummaryBinding({
      claim,
      workerInstance: "worker-01",
      projectId: 51,
      summaryDate: "2026-08-30",
    });
    const saved = await client.saveWeeklyReportSummaryBinding({
      claim,
      workerInstance: "worker-01",
      projectId: 51,
      summaryDate: "2026-08-30",
      commitSummaryId: 901,
    });

    assert.deepEqual(existing, { commitSummaryId: 901, sourceVersion: 1 });
    assert.deepEqual(saved, { commitSummaryId: 901, sourceVersion: 2 });
    assert.deepEqual(requests.map((request) => request.method), ["POST", "PUT"]);
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      [
        "/internal/automation-job-runs/run-01/weekly-report-summary-bindings/51",
        "/internal/automation-job-runs/run-01/weekly-report-summary-bindings/51",
      ],
    );
    assert.deepEqual(await requests[0]?.json(), {
      worker_instance: "worker-01",
      lease_token: "lease-secret",
      summary_date: "2026-08-30",
    });
    assert.deepEqual(await requests[1]?.json(), {
      worker_instance: "worker-01",
      lease_token: "lease-secret",
      summary_date: "2026-08-30",
      commit_summary_id: 901,
    });
  });

  it("classifies an expired lease as a terminal lease loss", async () => {
    const client = createClient(async () => Response.json({
      code: 409,
      message: "expired",
      data: { error_code: "lease_expired" },
      success: false,
    }, { status: 409 }));

    await assert.rejects(
      client.heartbeat({
        claim: decodeClaimForTest(),
        workerInstance: "worker-01",
        leaseSeconds: 300,
      }),
      (error: unknown) =>
        error instanceof AutomationLeaseLostError &&
        error.errorCode === "lease_expired",
    );
  });
});

function createClient(fetchImpl: typeof fetch): AutomationOaClient {
  return new AutomationOaClient(
    {
      baseUrl: "https://oa.example.test",
      token: "automation-secret",
    },
    fetchImpl,
  );
}

function claimPayload(): Record<string, unknown> {
  return {
    run_id: "run-01",
    lease_token: "lease-secret",
    run_mutation_token: "run-mutation-secret",
    fencing_token: 7,
    concurrency_key: "tenant-1:github_project_progress_sync:all_projects",
    job_id: 1,
    job_key: "github-project-progress-sync",
    job_type: "github_project_progress_sync",
    name: "GitHub 项目进度每日总结",
    trigger_source: "manual",
    scheduled_at: "2026-07-30T12:00:00Z",
    timezone: "Asia/Shanghai",
    model_provider: "nexttoken",
    model_id: "gpt-5.6-terra",
    model_parameters: {},
    execution_parameters: {
      project_id: 51,
      summary_scope: "today",
    },
    model_catalog_version: "catalog-v1",
    prompt_profile: {
      prompt_version: "sha256:oa-profile-v1",
      system_prompt: "只总结已经完成的工程进展。",
      required_capabilities: [
        "github_project_tracking",
        "rwkvos_system_calls",
      ],
    },
    retry_policy: {
      attempt: 1,
      max_attempts: 3,
      interval_seconds: 300,
    },
    timeout_seconds: 2_700,
    deadline_at: "2099-07-30T12:45:00Z",
    lease_expires_at: "2099-07-30T12:05:00Z",
    cancel_requested: false,
  };
}

function decodeClaimForTest() {
  return {
    runId: "run-01",
    leaseToken: "lease-secret",
    runMutationToken: "run-mutation-secret",
    fencingToken: 7,
    concurrencyKey: "tenant-1:github_project_progress_sync:all_projects",
    jobId: 1,
    jobKey: "github-project-progress-sync",
    jobType: "github_project_progress_sync",
    name: "GitHub 项目进度每日总结",
    triggerSource: "manual",
    scheduledAt: "2026-07-30T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    modelProvider: "nexttoken",
    modelId: "gpt-5.6-terra",
    modelParameters: {},
    modelCatalogVersion: "catalog-v1",
    promptProfile: null,
    retryPolicy: { attempt: 1, maxAttempts: 3, intervalSeconds: 300 },
    timeoutSeconds: 2_700,
    deadlineAt: "2099-07-30T12:45:00.000Z",
    leaseExpiresAt: "2099-07-30T12:05:00.000Z",
    cancelRequested: false,
  };
}

function runProjectResultForTest() {
  return {
    projectNameSnapshot: "OA 服务端",
    statusBefore: "updating",
    statusAfter: "maintenance",
    outcome: "evaluated" as const,
    repositoryCount: 1,
    commitCount: 2,
    summaryDate: "2026-07-30",
    sourceDigest: "sha256:digest",
    generatedSummary: "完成联调。",
    aiConfidence: 90,
    aiNote: "提交完整。",
    warnings: [],
    mutationsApplied: true,
    startedAt: "2026-07-30T12:00:00Z",
    finishedAt: "2026-07-30T12:01:00Z",
    durationMs: 60_000,
  };
}

function traceEventForTest() {
  return {
    eventKey: "read_github",
    sequence: 300,
    phase: "read_github",
    status: "running" as const,
    title: "读取 GitHub 分支与 Commit",
    message: "已读取 2/6 个仓库",
    progressCurrent: 2,
    progressTotal: 6,
    projectId: null,
    repositoryFullName: null,
    metadataSanitized: { github_concurrency: 6 },
    occurredAt: "2026-07-30T12:00:30.000Z",
  };
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
