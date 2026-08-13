import assert from "node:assert/strict";
import test from "node:test";

import {
  automationClaimSchema,
  automationJobCreateSchema,
  automationJobPatchSchema,
  automationRunPatchSchema,
  automationRunProjectUpsertSchema,
  automationTraceEventUpsertSchema,
} from "../src/automation/contracts.js";

test("accepts only supported project-progress summary scopes", () => {
  const baseJob = {
    job_key: "summary-scope-test",
    job_type: "github_project_progress_sync" as const,
    name: "Summary scope test",
    description: "",
    enabled: true,
    timezone: "Asia/Shanghai",
    schedule_type: "cron" as const,
    cron_expression: "0 20 * * 1-5",
    catch_up_policy: "latest" as const,
    overlap_policy: "forbid" as const,
    model_provider: "nexttoken",
    model_id: "gpt-5.6-terra",
    model_parameters: {
      summary_scope: "latest_commit_of_updating_projects",
      reasoning_effort: "high" as const,
      max_output_tokens: 2048,
    },
    retry_max_attempts: 3,
    retry_interval_seconds: 300,
    timeout_seconds: 2700,
    retention_days: 90,
    tag_ids: [],
  };

  assert.deepEqual(
    automationJobCreateSchema.parse(baseJob).model_parameters,
    {
      summary_scope: "latest_commit_of_updating_projects",
      reasoning_effort: "high",
      max_output_tokens: 2048,
    },
  );
  assert.deepEqual(
    automationJobCreateSchema.parse({
      ...baseJob,
      model_parameters: {},
    }).model_parameters,
    { summary_scope: "today" },
  );
  assert.equal(
    automationJobPatchSchema.safeParse({
      version: 1,
      model_parameters: { summary_scope: "all_history" },
    }).success,
    false,
  );
});

test("accepts the existing project-progress worker claim contract", () => {
  const result = automationClaimSchema.parse({
    worker_instance: "worker-01",
    supported_job_types: ["github_project_progress_sync"],
    lease_seconds: 300,
    claim_request_id: "019fd15d-32c6-7fb2-9afb-68be0996b80f",
  });

  assert.deepEqual(result.supported_job_types, [
    "github_project_progress_sync",
  ]);
  assert.equal(
    result.claim_request_id,
    "019fd15d-32c6-7fb2-9afb-68be0996b80f",
  );
  assert.equal(
    automationClaimSchema.safeParse({
      worker_instance: "worker-01",
      supported_job_types: ["github_project_progress_sync"],
      lease_seconds: 300,
      claim_request_id: "not-a-uuid",
    }).success,
    false,
  );
});

test("keeps no_commits compatible with the existing worker", () => {
  const result = automationRunProjectUpsertSchema.parse({
    worker_instance: "worker-01",
    lease_token: "a".repeat(64),
    project_name_snapshot: "Project A",
    outcome: "no_commits",
    repository_count: 2,
    commit_count: 0,
    warnings: [],
  });

  assert.equal(result.outcome, "no_commits");
});

test("rejects unsupported worker status and invalid trace progress", () => {
  assert.equal(
    automationRunPatchSchema.safeParse({
      worker_instance: "worker-01",
      lease_token: "a".repeat(64),
      status: "timed_out",
    }).success,
    false,
  );

  assert.equal(
    automationTraceEventUpsertSchema.safeParse({
      worker_instance: "worker-01",
      lease_token: "a".repeat(64),
      event_key: "project:1",
      sequence: 1,
      phase: "project",
      status: "running",
      title: "Project",
      progress_current: 2,
      progress_total: 1,
      metadata_sanitized: {},
      occurred_at: "2026-08-11T00:00:00Z",
    }).success,
    false,
  );

  assert.equal(
    automationTraceEventUpsertSchema.safeParse({
      worker_instance: "worker-01",
      lease_token: "a".repeat(64),
      event_key: "project:1",
      sequence: 1,
      phase: "project",
      status: "running",
      title: "Project",
      metadata_sanitized: { request_headers: { Authorization: "secret" } },
      occurred_at: "2026-08-11T00:00:00Z",
    }).success,
    false,
  );
});
