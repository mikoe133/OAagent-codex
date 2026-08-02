import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProjectProgressAutomation } from "../src/application/runProjectProgressAutomation.js";
import type { ProjectProgressSyncReport } from "../src/application/syncProjectProgress.js";
import {
  AutomationLeaseLostError,
  type AutomationJobClaim,
  type AutomationOaClient,
  type AutomationRunStatus,
} from "../src/infrastructure/oa/automationOaClient.js";

describe("runProjectProgressAutomation", () => {
  it("returns idle when OA has no runnable job", async () => {
    const client = fakeClient({ claim: async () => null });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async () => report(),
    });

    assert.deepEqual(result, {
      claimed: false,
      runId: null,
      status: "idle",
      report: null,
    });
  });

  it("uploads project and AI audit records before reporting success", async () => {
    const statuses: AutomationRunStatus[] = [];
    let heartbeatCalls = 0;
    let projectCalls = 0;
    let interactionCalls = 0;
    const client = fakeClient({
      updateRun: async ({ status }) => {
        statuses.push(status);
      },
      heartbeat: async () => {
        heartbeatCalls += 1;
        return heartbeatResult(false);
      },
      upsertProjectResult: async ({ result }) => {
        projectCalls += 1;
        assert.deepEqual(result.warnings, [{ code: "summary_adopted" }]);
        return 123;
      },
      upsertAiInteraction: async ({ interaction }) => {
        interactionCalls += 1;
        assert.equal(interaction.runProjectId, 123);
        assert.deepEqual(interaction.limitations, [{ message: "仅依据 commit" }]);
        await delay(30);
        return 456;
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 0.005,
      resolveExecution: async () => async () => report({ withProject: true }),
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(statuses, ["running", "succeeded"]);
    assert.equal(projectCalls, 1);
    assert.equal(interactionCalls, 1);
    assert.ok(heartbeatCalls > 0, "AI 审计期间应继续 heartbeat");
  });

  it("stops at a safe checkpoint when heartbeat requests cancellation", async () => {
    const statuses: AutomationRunStatus[] = [];
    const client = fakeClient({
      updateRun: async ({ status }) => {
        statuses.push(status);
      },
      heartbeat: async () => heartbeatResult(true),
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 0.005,
      resolveExecution: async () => async (shouldCancel) => {
        await waitUntil(shouldCancel);
        return report({ cancelled: true });
      },
    });

    assert.equal(result.status, "cancelled");
    assert.deepEqual(statuses, ["running", "cancelled"]);
  });

  it("never reports a terminal status after losing the lease", async () => {
    const statuses: AutomationRunStatus[] = [];
    const client = fakeClient({
      updateRun: async ({ status }) => {
        statuses.push(status);
      },
      heartbeat: async () => {
        throw new AutomationLeaseLostError("expired", 409, "lease_expired");
      },
    });

    await assert.rejects(
      runProjectProgressAutomation({
        automationClient: client,
        workerInstance: "worker-01",
        leaseSeconds: 300,
        heartbeatSeconds: 0.005,
        resolveExecution: async () => async (shouldCancel) => {
          await waitUntil(shouldCancel);
          return report();
        },
      }),
      AutomationLeaseLostError,
    );
    assert.deepEqual(statuses, ["running"]);
  });
});

type AutomationClientMethods = Pick<
  AutomationOaClient,
  | "claim"
  | "updateRun"
  | "heartbeat"
  | "upsertProjectResult"
  | "upsertAiInteraction"
>;

function fakeClient(
  overrides: Partial<AutomationClientMethods> = {},
): AutomationOaClient {
  return {
    claim: async () => claim(),
    updateRun: async () => undefined,
    heartbeat: async () => heartbeatResult(false),
    upsertProjectResult: async () => 123,
    upsertAiInteraction: async () => 456,
    ...overrides,
  } as unknown as AutomationOaClient;
}

function claim(): AutomationJobClaim {
  return {
    runId: "run-01",
    leaseToken: "lease-secret",
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
    retryPolicy: { attempt: 1, maxAttempts: 3, intervalSeconds: 300 },
    timeoutSeconds: 2_700,
    deadlineAt: "2099-07-30T12:45:00.000Z",
    leaseExpiresAt: "2099-07-30T12:05:00.000Z",
    cancelRequested: false,
  };
}

function report(options: {
  withProject?: boolean;
  cancelled?: boolean;
} = {}): ProjectProgressSyncReport {
  return {
    mode: "production-write",
    observedAt: "2026-07-30T12:00:00.000Z",
    mutationsApplied: options.withProject ? 1 : 0,
    retryRecommended: false,
    cancelled: options.cancelled ?? false,
    projects: options.withProject ? [{
      projectId: 51,
      projectName: "OA 服务端",
      currentStatus: "updating",
      targetStatus: "updating",
      outcome: "evaluated",
      warnings: ["summary_adopted"],
      repositoryCount: 1,
      commitCount: 2,
      mutationsApplied: 1,
      summaries: [{
        summaryDate: "2026-07-30",
        commitCount: 2,
        sourceDigest: "digest",
        summary: "完成联调。",
        aiConfidence: 90,
        aiNote: "提交完整。",
        interaction: {
          provider: "nexttoken",
          model: "gpt-5.6-terra",
          promptVersion: "prompt-v1",
          systemPromptSnapshot: "system prompt",
          requestPayloadSanitized: { commit_count: 2 },
          responsePayloadSanitized: { output_count: 1 },
          finalSummary: "完成联调。",
          limitations: ["仅依据 commit"],
          fallbackUsed: false,
          upstreamRequestId: "request-01",
          inputTokens: 100,
          outputTokens: 20,
          latencyMs: 500,
          status: "succeeded",
          errorCode: null,
          errorSummary: null,
        },
      }],
    }] : [],
  };
}

function heartbeatResult(cancelRequested: boolean) {
  return {
    status: "running",
    heartbeatAt: "2026-07-30T12:01:00.000Z",
    leaseExpiresAt: "2099-07-30T12:06:00.000Z",
    cancelRequested,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for heartbeat");
    }
    await delay(2);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
