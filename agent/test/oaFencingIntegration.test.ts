import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  AutomationLeaseLostError,
  AutomationOaClient,
  AutomationOaRequestError,
  type AutomationJobClaim,
} from "../src/infrastructure/oa/automationOaClient.js";
import { buildFencedMutationBody } from "../src/infrastructure/oa/fencedMutation.js";
import {
  OaRequestError,
  ProjectProgressOaClient,
} from "../src/infrastructure/oa/projectProgressOaClient.js";

type IntegrationConfig = {
  baseUrl: string;
  automationToken: string;
  projectToken: string;
  fixtureUrl: string;
  fixtureToken: string;
  backendCommitSha: string;
  backendCiEvidenceUrl: string;
};

const config = loadIntegrationConfig(process.env);

describe("OA fencing black-box contract", { skip: config === null }, () => {
  it("enforces claim replay, single-flight, fencing, CAS, and payload-bound idempotency", {
    timeout: 60_000,
  }, async () => {
    const integration = config!;
    assert.match(integration.backendCommitSha, /^[a-f0-9]{7,64}$/i);
    assert.doesNotThrow(() => new URL(integration.backendCiEvidenceUrl));

    const fixture = await controlFixture(integration, "reset");
    const automationClient = new AutomationOaClient({
      baseUrl: integration.baseUrl,
      token: integration.automationToken,
    });
    const firstClaimInput = {
      workerInstance: "oaagent-fencing-worker-a",
      leaseSeconds: 60,
      claimRequestId: randomUUID(),
    };
    const first = requireFencedClaim(await automationClient.claim(firstClaimInput));
    const replay = requireFencedClaim(await automationClient.claim(firstClaimInput));
    assert.deepEqual(claimIdentity(replay), claimIdentity(first));

    await assert.rejects(
      automationClient.claim({
        ...firstClaimInput,
        leaseSeconds: 61,
      }),
      (error: unknown) =>
        error instanceof AutomationOaRequestError &&
        error.status === 409 &&
        error.errorCode === "claim_request_conflict",
    );

    assert.equal(await automationClient.claim({
      workerInstance: "oaagent-fencing-worker-b",
      leaseSeconds: 60,
      claimRequestId: randomUUID(),
    }), null, "相同 concurrency_key 的第二个 job/worker 不得获得活跃 run");

    await controlFixture(integration, "expire_current_lease", {
      run_id: first.runId,
    });
    const second = requireFencedClaim(await automationClient.claim({
      workerInstance: "oaagent-fencing-worker-b",
      leaseSeconds: 60,
      claimRequestId: randomUUID(),
    }));
    assert.equal(second.concurrencyKey, first.concurrencyKey);
    assert.notEqual(second.jobKey, first.jobKey);
    assert.ok(second.fencingToken! > first.fencingToken!);

    const oldProjectClient = createProjectClient(integration, first);
    const currentProjectClient = createProjectClient(integration, second);
    const project = await currentProjectClient.getProject(fixture.projectId);
    assert.equal(project.status, "updating", "fixture 必须把测试项目重置为 updating");
    assert.ok(project.version);

    await assert.rejects(
      oldProjectClient.updateProjectStatus(
        fixture.projectId,
        "maintenance",
        project.version,
      ),
      isFenceLoss,
    );
    await currentProjectClient.updateProjectStatus(
      fixture.projectId,
      "maintenance",
      project.version,
    );
    await currentProjectClient.updateProjectStatus(
      fixture.projectId,
      "maintenance",
      project.version,
    );

    const statusBody = buildFencedMutationBody(
      mutationContext(second),
      `project.status.update:${fixture.projectId}`,
      { status: "maintenance", expected_version: project.version },
    );
    await assert.rejects(
      rawProjectMutation(
        integration,
        `/internal/project-sync/projects/${fixture.projectId}/status`,
        { ...statusBody, status: "updating" },
      ),
      isIdempotencyConflict,
    );
    await assert.rejects(
      currentProjectClient.updateProjectStatus(
        fixture.projectId,
        "updating",
        project.version,
      ),
      isVersionConflict,
    );

    const summary = await currentProjectClient.getCommitSummary(fixture.summaryId);
    assert.ok(summary.version);
    const summaryUpdate = {
      summary: `${summary.summary} [fencing verified]`,
      aiConfidence: summary.aiConfidence,
      aiNote: summary.aiNote,
      expectedVersion: summary.version,
    };
    await assert.rejects(
      oldProjectClient.updateCommitSummary(fixture.summaryId, summaryUpdate),
      isFenceLoss,
    );
    await currentProjectClient.updateCommitSummary(fixture.summaryId, summaryUpdate);
    await currentProjectClient.updateCommitSummary(fixture.summaryId, summaryUpdate);

    const summaryBody = buildFencedMutationBody(
      mutationContext(second),
      `commit-summary.update:${fixture.summaryId}`,
      {
        summary: summaryUpdate.summary,
        ai_confidence: summaryUpdate.aiConfidence,
        ai_note: summaryUpdate.aiNote,
        expected_version: summary.version,
      },
    );
    await assert.rejects(
      rawProjectMutation(
        integration,
        `/internal/project-sync/github-commit-summaries/${fixture.summaryId}`,
        { ...summaryBody, summary: "different payload" },
      ),
      isIdempotencyConflict,
    );
    await assert.rejects(
      currentProjectClient.updateCommitSummary(fixture.summaryId, {
        ...summaryUpdate,
        summary: "new key with stale version",
      }),
      isVersionConflict,
    );
  });
});

function loadIntegrationConfig(
  environment: NodeJS.ProcessEnv,
): IntegrationConfig | null {
  const values = {
    baseUrl: environment.OA_FENCING_TEST_BASE_URL,
    automationToken: environment.OA_FENCING_TEST_AUTOMATION_TOKEN,
    projectToken: environment.OA_FENCING_TEST_PROJECT_TOKEN,
    fixtureUrl: environment.OA_FENCING_TEST_FIXTURE_URL,
    fixtureToken: environment.OA_FENCING_TEST_FIXTURE_TOKEN,
    backendCommitSha: environment.OA_BACKEND_COMMIT_SHA,
    backendCiEvidenceUrl: environment.OA_BACKEND_CI_EVIDENCE_URL,
  };
  return Object.values(values).every((value) => value?.trim())
    ? values as IntegrationConfig
    : null;
}

async function controlFixture(
  config: IntegrationConfig,
  scenario: "reset" | "expire_current_lease",
  input: Record<string, unknown> = {},
): Promise<{ projectId: number; summaryId: number }> {
  const response = await fetch(config.fixtureUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.fixtureToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scenario, ...input }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(`OA fencing fixture 失败:HTTP ${response.status}`);
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (
    !data ||
    !Number.isInteger(data.project_id) ||
    !Number.isInteger(data.summary_id)
  ) {
    throw new Error("OA fencing fixture 响应缺少 project_id/summary_id。");
  }
  return {
    projectId: data.project_id as number,
    summaryId: data.summary_id as number,
  };
}

function createProjectClient(
  config: IntegrationConfig,
  claim: AutomationJobClaim,
): ProjectProgressOaClient {
  return new ProjectProgressOaClient({
    baseUrl: config.baseUrl,
    alias: "fencing-test",
    token: config.projectToken,
    tokenHeader: "Authorization",
    tokenPrefix: "Bearer",
    mutationContext: mutationContext(claim),
  });
}

function mutationContext(claim: AutomationJobClaim) {
  return {
    runId: claim.runId,
    runMutationToken: claim.runMutationToken!,
    fencingToken: claim.fencingToken!,
  };
}

function requireFencedClaim(
  claim: AutomationJobClaim | null,
): AutomationJobClaim {
  assert.ok(claim, "fixture 必须创建可 claim 的任务");
  assert.ok(claim.runMutationToken);
  assert.ok(claim.fencingToken);
  assert.ok(claim.concurrencyKey);
  return claim;
}

function claimIdentity(claim: AutomationJobClaim) {
  return {
    runId: claim.runId,
    leaseToken: claim.leaseToken,
    runMutationToken: claim.runMutationToken,
    fencingToken: claim.fencingToken,
    concurrencyKey: claim.concurrencyKey,
  };
}

async function rawProjectMutation(
  config: IntegrationConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(new URL(path, ensureTrailingSlash(config.baseUrl)), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${config.projectToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) {
    const errorCode = isRecord(payload) && isRecord(payload.data) &&
        typeof payload.data.error_code === "string"
      ? payload.data.error_code
      : null;
    throw new OaRequestError("raw fenced mutation failed", response.status, errorCode);
  }
}

function isFenceLoss(error: unknown): boolean {
  return (error instanceof AutomationLeaseLostError || error instanceof OaRequestError) &&
    error.status === 409 &&
    [
      "invalid_run_mutation_token",
      "stale_fencing_token",
      "lease_fenced",
      "lease_expired",
      "run_not_active",
    ].includes(error.errorCode ?? "");
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof OaRequestError &&
    error.status === 409 &&
    error.errorCode === "idempotency_conflict";
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof OaRequestError &&
    (error.status === 409 || error.status === 412) &&
    error.errorCode === "version_conflict";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
