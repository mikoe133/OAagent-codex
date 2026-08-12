import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProjectProgressAutomation } from "../src/application/runProjectProgressAutomation.js";
import type { ProjectProgressSyncReport } from "../src/application/syncProjectProgress.js";
import {
  AutomationLeaseLostError,
  AutomationOaRequestError,
  type AutomationJobClaim,
  type AutomationOaClient,
  type AutomationRunStatus,
} from "../src/infrastructure/oa/automationOaClient.js";
import { ProjectProgressLeaseLostError } from "../src/infrastructure/oa/projectProgressOaClient.js";

describe("runProjectProgressAutomation", () => {
  it("clears a persisted claim identity after an idle response", async () => {
    const cleared: string[] = [];
    const client = fakeClient({
      claim: async (input) => {
        assert.deepEqual(input, {
          workerInstance: "worker-01",
          leaseSeconds: 300,
          claimRequestId: "claim-request-01",
        });
        return null;
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      claimIdentityStore: {
        getOrCreateAutomationClaimIdentity: () => ({
          claimRequestId: "claim-request-01",
          requestDigest: "a".repeat(64),
        }),
        clearAutomationClaimIdentity: (claimRequestId) => {
          cleared.push(claimRequestId);
        },
      },
      resolveExecution: async () => async () => report(),
    });

    assert.equal(result.status, "idle");
    assert.deepEqual(cleared, ["claim-request-01"]);
  });

  it("preserves a persisted claim identity when the claim response is unknown", async () => {
    const cleared: string[] = [];
    const client = fakeClient({
      claim: async () => {
        throw new Error("connection reset after request");
      },
    });

    await assert.rejects(
      runProjectProgressAutomation({
        automationClient: client,
        workerInstance: "worker-01",
        leaseSeconds: 300,
        heartbeatSeconds: 60,
        claimIdentityStore: {
          getOrCreateAutomationClaimIdentity: () => ({
            claimRequestId: "claim-request-01",
            requestDigest: "a".repeat(64),
          }),
          clearAutomationClaimIdentity: (claimRequestId) => {
            cleared.push(claimRequestId);
          },
        },
        resolveExecution: async () => async () => report(),
      }),
      /connection reset/,
    );

    assert.deepEqual(cleared, []);
  });

  it("clears a persisted claim identity only after terminal status is confirmed", async () => {
    const cleared: string[] = [];

    const result = await runProjectProgressAutomation({
      automationClient: fakeClient(),
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      claimIdentityStore: {
        getOrCreateAutomationClaimIdentity: () => ({
          claimRequestId: "claim-request-01",
          requestDigest: "a".repeat(64),
        }),
        clearAutomationClaimIdentity: (claimRequestId) => {
          cleared.push(claimRequestId);
        },
      },
      resolveExecution: async () => async () => report(),
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(cleared, ["claim-request-01"]);
  });

  it("preserves claim identity and never changes terminal payload after an unknown response", async () => {
    const statuses: AutomationRunStatus[] = [];
    const cleared: string[] = [];
    const client = fakeClient({
      updateRun: async ({ status }) => {
        statuses.push(status);
        if (status === "succeeded") {
          throw new Error("connection reset after terminal request");
        }
      },
    });

    await assert.rejects(
      runProjectProgressAutomation({
        automationClient: client,
        workerInstance: "worker-01",
        leaseSeconds: 300,
        heartbeatSeconds: 60,
        claimIdentityStore: {
          getOrCreateAutomationClaimIdentity: () => ({
            claimRequestId: "claim-request-01",
            requestDigest: "a".repeat(64),
          }),
          clearAutomationClaimIdentity: (claimRequestId) => {
            cleared.push(claimRequestId);
          },
        },
        resolveExecution: async () => async () => report(),
      }),
      /connection reset/,
    );

    assert.deepEqual(statuses, ["running", "succeeded"]);
    assert.deepEqual(cleared, []);
  });

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
      claim: async () => promptAwareClaim(),
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
        assert.equal(interaction.promptVersion, "sha256:oa-profile-v1");
        assert.equal(
          interaction.systemPromptSnapshot,
          "只总结已经完成的工程进展。",
        );
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

  it("uploads one AI audit record for every repository Thread", async () => {
    const interactionKeys: string[] = [];
    let activeUploads = 0;
    let peakUploads = 0;
    const client = fakeClient({
      claim: async () => promptAwareClaim(),
      upsertAiInteraction: async ({ interaction }) => {
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        interactionKeys.push(interaction.interactionKey);
        assert.match(
          String(interaction.requestPayloadSanitized.repository_full_name),
          /^example\/(api|web)$/,
        );
        assert.equal(
          interaction.requestPayloadSanitized.summary_date,
          "2026-07-30",
        );
        assert.match(interaction.upstreamRequestId ?? "", /^thread-(api|web)$/);
        await delay(5);
        activeUploads -= 1;
        return interactionKeys.length;
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async () => report({
        withProject: true,
        withRepositoryInteractions: true,
      }),
    });

    assert.equal(result.status, "succeeded");
    assert.equal(interactionKeys.length, 2);
    assert.equal(new Set(interactionKeys).size, 2);
    assert.equal(peakUploads, 1);
  });

  it("requests a retry when summary generation used a fallback", async () => {
    const terminalUpdates: Array<{
      status: AutomationRunStatus;
      retryRecommended?: boolean;
      errorCode?: string | null;
    }> = [];
    const projectOutcomes: string[] = [];
    const client = fakeClient({
      updateRun: async ({ status, retryRecommended, errorCode }) => {
        if (status !== "running") {
          terminalUpdates.push({ status, retryRecommended, errorCode });
        }
      },
      upsertProjectResult: async ({ result }) => {
        projectOutcomes.push(result.outcome);
        return 123;
      },
    });
    const fallbackReport = report({ withProject: true });
    fallbackReport.retryRecommended = true;
    fallbackReport.metrics.repositoryTasksSucceeded = 0;
    fallbackReport.metrics.repositoryTasksFallback = 1;
    fallbackReport.projects[0]!.warnings.push(
      "repository_summary_fallback:example/api:2026-07-30",
    );

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async () => fallbackReport,
    });

    assert.equal(result.status, "partial_failed");
    assert.deepEqual(projectOutcomes, ["failed"]);
    assert.deepEqual(terminalUpdates, [{
      status: "partial_failed",
      retryRecommended: true,
      errorCode: "project_summary_failed",
    }]);
  });

  it("reports live trace stages while the run is active", async () => {
    const traceEvents: Array<{ eventKey: string; status: string }> = [];
    const client = fakeClient({
      upsertTraceEvent: async ({ event }) => {
        traceEvents.push({ eventKey: event.eventKey, status: event.status });
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async (_shouldCancel, trace) => {
        await trace?.({
          eventKey: "read_github",
          sequence: 300,
          phase: "read_github",
          status: "running",
          title: "读取 GitHub 分支与 Commit",
        });
        return report();
      },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(
      [...new Set(traceEvents.map((event) => event.eventKey))],
      [
        "worker_claimed",
        "validate_configuration",
        "read_github",
        "upload_run_audit",
        "finalize_run",
      ],
    );
    assert.deepEqual(
      traceEvents.filter((event) => event.eventKey === "upload_run_audit")
        .map((event) => event.status),
      ["running", "succeeded"],
    );
    assert.equal(traceEvents.at(-1)?.status, "succeeded");
  });

  it("does not block business execution on an in-flight trace request", async () => {
    let releaseBurst!: () => void;
    const burstGate = new Promise<void>((resolve) => {
      releaseBurst = resolve;
    });
    let publishReturnedImmediately = false;
    const client = fakeClient({
      upsertTraceEvent: async ({ event }) => {
        if (event.eventKey === "burst") {
          await burstGate;
        }
      },
    });

    const resultPromise = runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async (_shouldCancel, trace) => {
        const publication = trace?.({
          eventKey: "burst",
          sequence: 300,
          phase: "read_github",
          status: "running",
          title: "读取 GitHub",
        }) ?? Promise.resolve();
        publishReturnedImmediately = await Promise.race([
          publication.then(() => true),
          delay(10).then(() => false),
        ]);
        releaseBurst();
        return report();
      },
    });

    const result = await resultPromise;
    assert.equal(result.status, "succeeded");
    assert.equal(publishReturnedImmediately, true);
  });

  it("keeps the business run working when OA has not enabled trace events", async () => {
    let traceCalls = 0;
    const client = fakeClient({
      upsertTraceEvent: async () => {
        traceCalls += 1;
        throw new AutomationOaRequestError(
          "trace endpoint missing",
          404,
          "automation_trace_not_found",
        );
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async () => report(),
    });

    assert.equal(result.status, "succeeded");
    assert.equal(traceCalls, 1);
  });

  it("checks for cancellation before starting the business execution", async () => {
    let heartbeatCalls = 0;
    const client = fakeClient({
      heartbeat: async () => {
        heartbeatCalls += 1;
        return heartbeatResult(true);
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async (shouldCancel) => {
        assert.equal(shouldCancel(), true);
        return report({ cancelled: true });
      },
    });

    assert.equal(heartbeatCalls, 1);
    assert.equal(result.status, "cancelled");
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

  it("does not retry a Worker infrastructure failure", async () => {
    const updates: Array<{
      status: AutomationRunStatus;
      retryRecommended?: boolean;
    }> = [];
    const client = fakeClient({
      updateRun: async ({ status, retryRecommended }) => {
        updates.push({ status, retryRecommended });
      },
    });

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => async () => {
        throw new TypeError("fetch failed");
      },
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(updates, [
      { status: "running", retryRecommended: undefined },
      { status: "failed", retryRecommended: false },
    ]);
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

  it("never reports a terminal status after a project mutation loses fencing", async () => {
    const statuses: AutomationRunStatus[] = [];
    const client = fakeClient({
      updateRun: async ({ status }) => {
        statuses.push(status);
      },
    });

    await assert.rejects(
      runProjectProgressAutomation({
        automationClient: client,
        workerInstance: "worker-01",
        leaseSeconds: 300,
        heartbeatSeconds: 60,
        resolveExecution: async () => async () => {
          throw new ProjectProgressLeaseLostError(
            "stale worker",
            409,
            "stale_fencing_token",
          );
        },
      }),
      ProjectProgressLeaseLostError,
    );

    assert.deepEqual(statuses, ["running"]);
  });

  it("rejects a prompt profile that requires an unsupported capability", async () => {
    const statuses: AutomationRunStatus[] = [];
    const client = fakeClient({
      claim: async () => ({
        ...promptAwareClaim(),
        promptProfile: {
          ...promptAwareClaim().promptProfile!,
          requiredCapabilities: ["github_project_tracking", "shell_access"],
        },
      }),
      updateRun: async ({ status }) => {
        statuses.push(status);
      },
    });
    let executionResolved = false;

    const result = await runProjectProgressAutomation({
      automationClient: client,
      workerInstance: "worker-01",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
      resolveExecution: async () => {
        executionResolved = true;
        return async () => report();
      },
    });

    assert.equal(result.status, "configuration_error");
    assert.equal(executionResolved, false);
    assert.deepEqual(statuses, ["configuration_error"]);
  });
});

type AutomationClientMethods = Pick<
  AutomationOaClient,
  | "claim"
  | "updateRun"
  | "heartbeat"
  | "upsertProjectResult"
  | "upsertAiInteraction"
  | "upsertTraceEvent"
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
    upsertTraceEvent: async () => undefined,
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
    promptProfile: null,
    retryPolicy: { attempt: 1, maxAttempts: 3, intervalSeconds: 300 },
    timeoutSeconds: 2_700,
    deadlineAt: "2099-07-30T12:45:00.000Z",
    leaseExpiresAt: "2099-07-30T12:05:00.000Z",
    cancelRequested: false,
  };
}

function promptAwareClaim(): AutomationJobClaim {
  return {
    ...claim(),
    promptProfile: {
      promptVersion: "sha256:oa-profile-v1",
      systemPrompt: "只总结已经完成的工程进展。",
      requiredCapabilities: [
        "github_project_tracking",
        "rwkvos_system_calls",
      ],
    },
  } as AutomationJobClaim & { promptProfile: Record<string, unknown> };
}

function report(options: {
  withProject?: boolean;
  withRepositoryInteractions?: boolean;
  cancelled?: boolean;
} = {}): ProjectProgressSyncReport {
  return {
    mode: "production-write",
    observedAt: "2026-07-30T12:00:00.000Z",
    mutationsApplied: options.withProject ? 1 : 0,
    retryRecommended: false,
    cancelled: options.cancelled ?? false,
    metrics: {
      repositoriesDiscovered: options.withProject ? 1 : 0,
      repositoriesWithCommits: options.withProject ? 1 : 0,
      repositoryTasksTotal: options.withProject ? 1 : 0,
      repositoryTasksSucceeded: options.withProject ? 1 : 0,
      repositoryTasksFallback: 0,
      repositoryTasksFailed: 0,
      githubPeakConcurrency: options.withProject ? 1 : 0,
      agentPeakConcurrency: options.withProject ? 1 : 0,
      oaWritePeakConcurrency: options.withProject ? 1 : 0,
    },
    operationMetrics: [],
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
        interaction: interaction("request-01"),
        ...(options.withRepositoryInteractions ? {
          repositoryInteractions: [
            {
              repositoryKey: "example/api",
              interaction: interaction("thread-api"),
            },
            {
              repositoryKey: "example/web",
              interaction: interaction("thread-web"),
            },
          ],
        } : {}),
      }],
    }] : [],
  };
}

function interaction(upstreamRequestId: string) {
  return {
    provider: "nexttoken",
    model: "gpt-5.6-terra",
    promptVersion: "prompt-v1",
    systemPromptSnapshot: "system prompt",
    requestPayloadSanitized: { commit_count: 2 },
    responsePayloadSanitized: { output_count: 1 },
    finalSummary: "完成联调。",
    limitations: ["仅依据 commit"],
    fallbackUsed: false,
    upstreamRequestId,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 500,
    status: "succeeded" as const,
    errorCode: null,
    errorSummary: null,
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
