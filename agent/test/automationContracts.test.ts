import assert from "node:assert/strict";
import test from "node:test";

import {
  automationClaimSchema,
  automationEventCreateSchema,
  automationJobCreateSchema,
  automationJobPatchSchema,
  automationManualRunCreateSchema,
  automationRunPatchSchema,
  automationRunProjectUpsertSchema,
  automationTraceEventUpsertSchema,
} from "../src/automation/contracts.js";

test("accepts a session-triggered run for one OA project", () => {
  assert.deepEqual(automationManualRunCreateSchema.parse({}), {});
  assert.deepEqual(
    automationManualRunCreateSchema.parse({ project_id: 51 }),
    { project_id: 51, summary_scope: "today" },
  );
  assert.deepEqual(
    automationManualRunCreateSchema.parse({
      project_id: 51,
      summary_scope: "latest_commit_of_updating_projects",
    }),
    {
      project_id: 51,
      summary_scope: "latest_commit_of_updating_projects",
    },
  );
  assert.equal(
    automationManualRunCreateSchema.safeParse({ project_id: 0 }).success,
    false,
  );
  assert.equal(
    automationManualRunCreateSchema.safeParse({ project_id: 51, github_token: "secret" })
      .success,
    false,
  );
});

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

test("accepts event-driven weekly report jobs without cron", () => {
  const result = automationJobCreateSchema.parse({
    job_key: "weekly-report-project-summary-sync",
    job_type: "weekly_report_project_summary_sync",
    name: "周报项目总结同步",
    description: "",
    enabled: true,
    timezone: "Asia/Shanghai",
    schedule_type: "event",
    trigger_type: "event",
    trigger_config: {
      resource: "weekly_report",
      events: ["created", "updated"],
      scope: "job_owner",
    },
    catch_up_policy: "latest",
    overlap_policy: "forbid",
    model_provider: "nexttoken",
    model_id: "gpt-5.6-terra",
    model_parameters: {},
    retry_max_attempts: 3,
    retry_interval_seconds: 300,
    timeout_seconds: 2700,
    retention_days: 90,
    tag_ids: [],
  });

  assert.equal(result.job_type, "weekly_report_project_summary_sync");
  assert.equal(result.schedule_type, "event");
  assert.equal(result.cron_expression, null);
  assert.equal(
    automationJobCreateSchema.safeParse({
      ...result,
      schedule_type: "cron",
      trigger_type: "event",
      cron_expression: undefined,
    }).success,
    false,
  );
});

test("validates a weekly report automation event", () => {
  const event = automationEventCreateSchema.parse({
    event_id: "019fd15d-32c6-7fb2-9afb-68be0996b80f",
    event_type: "weekly_report.updated",
    aggregate_type: "weekly_report",
    aggregate_id: "report-123",
    aggregate_version: 7,
    occurred_at: "2026-08-27T09:30:00Z",
    actor_id: 42,
    scope: { user_id: 42 },
    data: {
      weekly_num: 202635,
      content: "项目 51：完成联调",
      content_hash: "sha256:4cdddb43ba06b61663ac8084628258162a412dd50d0f054161d2165f3126558b",
      updated_at: "2026-08-27T09:29:58Z",
    },
  });

  assert.equal(event.aggregate_version, 7);
  assert.equal(
    automationEventCreateSchema.safeParse({ ...event, data: { ...event.data, content: "" } })
      .success,
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
