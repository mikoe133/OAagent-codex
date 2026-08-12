import assert from "node:assert/strict";
import test from "node:test";

import {
  automationClaimSchema,
  automationRunPatchSchema,
  automationRunProjectUpsertSchema,
  automationTraceEventUpsertSchema,
} from "../src/automation/contracts.js";

test("accepts the existing project-progress worker claim contract", () => {
  const result = automationClaimSchema.parse({
    worker_instance: "worker-01",
    supported_job_types: ["github_project_progress_sync"],
    lease_seconds: 300,
  });

  assert.deepEqual(result.supported_job_types, [
    "github_project_progress_sync",
  ]);
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
