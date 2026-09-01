import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AutomationService } from "../src/automation/application/automationService.js";
import { AutomationHttpError } from "../src/automation/http/automationHttpApplication.js";
import { createAutomationDatabase } from "../src/automation/persistence/database.js";
import { runAutomationMigrations } from "../src/automation/persistence/migrations.js";

const databaseUrl = process.env.AUTOMATION_NODE_TEST_DATABASE_URL;

test(
  "stores a complete automation run and atomically claims it once",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!);
    assert.match(url.pathname, /_automation_test$/);
    await runAutomationMigrations(url, new URL("../..", import.meta.url).pathname);
    const repeatedMigration = await runAutomationMigrations(
      url,
      new URL("../..", import.meta.url).pathname,
    );
    assert.equal(repeatedMigration.baselineApplied, false);
    assert.equal(repeatedMigration.executionParametersApplied, false);
    assert.equal(repeatedMigration.eventTriggersApplied, false);
    assert.equal(repeatedMigration.weeklyPendingItemsApplied, false);
    assert.equal(repeatedMigration.weeklySummaryBindingsApplied, false);
    const database = createAutomationDatabase(url);
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute();
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
        openrouter: {
          name: "OpenRouter",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "OPENROUTER_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 3,
      manualTriggerWindowSeconds: 300,
    });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

    try {
      const tag = (await service.createTag(
        { name: `integration-${suffix}`, enabled: true },
        42,
      )) as { id: number };
      const job = (await service.createJob(
        {
          job_key: `integration-${suffix}`,
          job_type: "github_project_progress_sync",
          name: "Integration job",
          description: "",
          enabled: true,
          timezone: "Asia/Shanghai",
          schedule_type: "cron",
          cron_expression: "0 20 * * 1-5",
          catch_up_policy: "latest",
          overlap_policy: "forbid",
          model_provider: "nexttoken",
          model_id: "gpt-5.6-terra",
          model_parameters: {},
          retry_max_attempts: 3,
          retry_interval_seconds: 0,
          timeout_seconds: 600,
          retention_days: 90,
          tag_ids: [tag.id],
        },
        42,
      )) as { id: number; version: number };
      const triggered = (await service.triggerJob(job.id, 42)) as {
        run_id: string;
      };

      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          service.claimRun({
            worker_instance: `worker-${index}`,
            supported_job_types: ["github_project_progress_sync"],
            lease_seconds: 300,
            claim_request_id: randomUUID(),
          }),
        ),
      );
      const claimed = claims.filter(Boolean) as Array<{
        run_id: string;
        lease_token: string;
        prompt_profile: { prompt_version: string; system_prompt: string };
      }>;
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.run_id, triggered.run_id);
      const claim = claimed[0]!;
      const worker = claims.findIndex(Boolean);

      const lease = {
        worker_instance: `worker-${worker}`,
        lease_token: claim.lease_token,
      };
      await service.heartbeatRun(triggered.run_id, {
        ...lease,
        lease_seconds: 300,
      });
      await service.updateRun(triggered.run_id, {
        ...lease,
        status: "running",
        retry_recommended: false,
      });
      const project = (await service.upsertRunProject(
        triggered.run_id,
        99,
        {
          ...lease,
          project_name_snapshot: "Project 99",
          status_before: "active",
          status_after: "active",
          outcome: "no_commits",
          repository_count: 1,
          commit_count: 0,
          warnings: [{ token: "must-redact" }],
          mutations_applied: false,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 12,
        },
      )) as { run_project_id: number };
      await service.createAiInteraction(triggered.run_id, {
        ...lease,
        run_project_id: project.run_project_id,
        interaction_key: "project-99-summary",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
        prompt_version: claim.prompt_profile.prompt_version,
        system_prompt_snapshot: claim.prompt_profile.system_prompt,
        request_payload_sanitized: { authorization: "secret" },
        response_payload_sanitized: {},
        limitations: [],
        fallback_used: false,
        latency_ms: 10,
        status: "succeeded",
      });
      await service.upsertTraceEvent(triggered.run_id, {
        ...lease,
        event_key: "project-99",
        sequence: 1,
        phase: "project",
        status: "succeeded",
        title: "Project 99",
        metadata_sanitized: {},
        occurred_at: new Date().toISOString(),
      });
      await service.updateRun(triggered.run_id, {
        ...lease,
        status: "succeeded",
        mutations_applied: false,
        retry_recommended: false,
      });

      const detail = (await service.getRun(
        triggered.run_id,
        new URLSearchParams("include=projects,ai_interactions,attempts"),
        42,
      )) as {
        status: string;
        projects_total: number;
        projects_succeeded: number;
        ai_interaction_count: number;
        projects: Array<{
          run_id: string;
          outcome: string;
          source_digest: string | null;
          warnings: unknown;
          created_at: string;
          updated_at: string;
        }>;
        ai_interactions: Array<{
          run_id: string;
          interaction_key: string;
          model_catalog_version: string | null;
          upstream_request_id: string | null;
          purged_at: string | null;
          created_at: string;
          request_payload_sanitized: unknown;
        }>;
      };
      assert.equal(detail.status, "succeeded");
      assert.equal(detail.projects_total, 1);
      assert.equal(detail.projects_succeeded, 1);
      assert.equal(detail.ai_interaction_count, 1);
      assert.equal(detail.projects[0]?.run_id, triggered.run_id);
      assert.equal(detail.projects[0]?.outcome, "no_commits");
      assert.equal(detail.projects[0]?.source_digest, null);
      assert.ok(detail.projects[0]?.created_at);
      assert.ok(detail.projects[0]?.updated_at);
      assert.deepEqual(detail.projects[0]?.warnings, [{ token: "***" }]);
      assert.equal(detail.ai_interactions[0]?.run_id, triggered.run_id);
      assert.equal(
        detail.ai_interactions[0]?.interaction_key,
        "project-99-summary",
      );
      assert.equal(detail.ai_interactions[0]?.model_catalog_version, null);
      assert.equal(detail.ai_interactions[0]?.upstream_request_id, null);
      assert.equal(detail.ai_interactions[0]?.purged_at, null);
      assert.ok(detail.ai_interactions[0]?.created_at);
      assert.deepEqual(detail.ai_interactions[0]?.request_payload_sanitized, {
        authorization: "***",
      });

      const detailWithoutIncludes = (await service.getRun(
        triggered.run_id,
        new URLSearchParams(),
        42,
      )) as { ai_interaction_count: number };
      assert.equal(detailWithoutIncludes.ai_interaction_count, 1);

      await service.patchJob(
        job.id,
        { version: job.version, tag_ids: [] },
        42,
      );
      const historicalTagRuns = (await service.listRuns(
        new URLSearchParams(`tag_id=${tag.id}&size=10`),
        42,
      )) as { total: number; items: Array<{ id: string }> };
      assert.equal(historicalTagRuns.total, 1);
      assert.equal(historicalTagRuns.items[0]?.id, triggered.run_id);

      await service.validateJob(job.id, 42);
      const validationLogs = await database.db
        .selectFrom("automation_job_change_logs")
        .select(["action", "changes_json"])
        .where("job_id", "=", job.id)
        .where("action", "=", "validated")
        .execute();
      assert.equal(validationLogs.length, 1);
      await database.db
        .updateTable("automation_jobs")
        .set({ next_run_at: new Date(Date.now() - 3 * 60 * 60 * 1000) })
        .where("id", "=", job.id)
        .execute();
      const maintenance = await service.runMaintenanceCycle();
      assert.equal(maintenance.scheduled, 1);
      const runs = (await service.listRuns(
        new URLSearchParams(`job_id=${job.id}&size=10`),
        42,
      )) as { total: number; items: Array<{ trigger_source: string }> };
      assert.equal(runs.total, 2);
      assert.equal(runs.items.some((run) => run.trigger_source === "catch_up"), true);

      const ascendingRuns = (await service.listRuns(
        new URLSearchParams(`job_id=${job.id}&size=10&sort=scheduled_at`),
        42,
      )) as { items: Array<{ scheduled_at: string }> };
      assert.ok(
        new Date(ascendingRuns.items[0]!.scheduled_at).getTime() <=
          new Date(ascendingRuns.items[1]!.scheduled_at).getTime(),
      );

      await database.db
        .updateTable("automation_jobs")
        .set({
          model_id: "removed-model",
          configuration_status: "valid",
          configuration_error: null,
          next_run_at: new Date(Date.now() + 60 * 60 * 1000),
        })
        .where("id", "=", job.id)
        .execute();
      await assert.rejects(
        () => service.triggerJob(job.id, 42),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          error.status === 409 &&
          "code" in error &&
          error.code === "job_configuration_invalid",
      );
      const invalidJob = await database.db
        .selectFrom("automation_jobs")
        .select(["configuration_status", "configuration_error", "next_run_at"])
        .where("id", "=", job.id)
        .executeTakeFirstOrThrow();
      assert.equal(invalidJob.configuration_status, "invalid");
      assert.equal(invalidJob.configuration_error, "model_configuration_invalid");
      assert.equal(invalidJob.next_run_at, null);
    } finally {
      await database.close();
    }
  },
);

test(
  "idempotently stores unmatched weekly report segments for later review",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!);
    assert.match(url.pathname, /_automation_test$/);
    await runAutomationMigrations(url, new URL("../..", import.meta.url).pathname);
    const database = createAutomationDatabase(url);
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute();
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 3,
      manualTriggerWindowSeconds: 300,
    });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

    try {
      await service.createJob({
        job_key: `weekly-pending-${suffix}`,
        job_type: "weekly_report_project_summary_sync",
        name: "Weekly pending integration job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "event",
        trigger_type: "event",
        trigger_config: {
          resource: "weekly_report",
          events: ["created", "updated"],
          scope: "all_users",
        },
        cron_expression: null,
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: { debounce_seconds: 0 },
        retry_max_attempts: 1,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [],
      }, 42);
      const eventId = randomUUID();
      const event = (await service.receiveAutomationEvent({
        event_id: eventId,
        event_type: "weekly_report.created",
        aggregate_type: "weekly_report",
        aggregate_id: `report-${suffix}`,
        aggregate_version: 1,
        occurred_at: new Date().toISOString(),
        actor_id: 42,
        scope: { user_id: 42 },
        data: {
          weekly_num: 202635,
          content: "项目 72：修复登录问题",
          updated_at: new Date().toISOString(),
        },
      })) as { run_id: string; status: string };
      assert.equal(event.status, "queued");
      const claim = (await service.claimRun({
        worker_instance: "weekly-pending-worker",
        supported_job_types: ["weekly_report_project_summary_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as { run_id: string; lease_token: string };
      assert.equal(claim.run_id, event.run_id);
      const lease = {
        worker_instance: "weekly-pending-worker",
        lease_token: claim.lease_token,
      };
      await service.updateRun(claim.run_id, {
        ...lease,
        status: "running",
        retry_recommended: false,
      });
      const pendingItem = {
        segment_key: "a".repeat(64),
        segment_order: 1,
        content_digest: "b".repeat(64),
        original_content: "项目 72：修复登录问题",
        ai_summary: "修复登录问题",
        ai_reason: "项目目录中不存在 ID 72",
        reason_code: "project_not_found",
        classification_source: "agent",
        referenced_project_id: 72,
        candidate_project_ids: [],
        ai_confidence: 99,
      };
      const first = (await service.upsertWeeklyReportPendingItems(claim.run_id, {
        ...lease,
        items: [pendingItem],
      })) as { pending_item_ids: number[] };
      const repeated = (await service.upsertWeeklyReportPendingItems(claim.run_id, {
        ...lease,
        items: [{ ...pendingItem, ai_reason: "仍未找到项目 72" }],
      })) as { pending_item_ids: number[] };
      assert.deepEqual(repeated.pending_item_ids, first.pending_item_ids);

      const detail = (await service.getRun(
        claim.run_id,
        new URLSearchParams("include=weekly_report_pending_items"),
        42,
      )) as {
        weekly_report_pending_item_count: number;
        weekly_report_pending_items: Array<{
          id: number;
          trigger_event_id: string;
          source_report_id: string;
          owner_user_id: number;
          original_content: string;
          ai_summary: string;
          ai_reason: string;
          status: string;
        }>;
      };
      assert.equal(detail.weekly_report_pending_item_count, 1);
      assert.deepEqual(detail.weekly_report_pending_items, [{
        ...detail.weekly_report_pending_items[0],
        id: first.pending_item_ids[0],
        trigger_event_id: eventId,
        source_report_id: `report-${suffix}`,
        owner_user_id: 42,
        original_content: "项目 72：修复登录问题",
        ai_summary: "修复登录问题",
        ai_reason: "仍未找到项目 72",
        status: "pending",
      }]);

      assert.equal(
        await service.getWeeklyReportSummaryBinding(claim.run_id, 51, {
          ...lease,
          summary_date: "2026-08-30",
        }),
        null,
      );
      const savedBinding = await service.saveWeeklyReportSummaryBinding(
        claim.run_id,
        51,
        {
          ...lease,
          summary_date: "2026-08-30",
          commit_summary_id: 901,
        },
      );
      assert.deepEqual(savedBinding, {
        commit_summary_id: 901,
        source_version: 1,
      });
      assert.deepEqual(
        await service.getWeeklyReportSummaryBinding(claim.run_id, 51, {
          ...lease,
          summary_date: "2026-08-30",
        }),
        savedBinding,
      );
      await assert.rejects(
        service.saveWeeklyReportSummaryBinding(claim.run_id, 51, {
          ...lease,
          summary_date: "2026-08-30",
          commit_summary_id: 902,
        }),
        (error) =>
          error instanceof AutomationHttpError &&
          error.code === "weekly_report_summary_binding_conflict",
      );
    } finally {
      await database.close();
    }
  },
);

test(
  "does not create a retry when a run reaches its deadline",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!);
    assert.match(url.pathname, /_automation_test$/);
    await runAutomationMigrations(url, new URL("../..", import.meta.url).pathname);
    const database = createAutomationDatabase(url);
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute();
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 3,
      manualTriggerWindowSeconds: 300,
    });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

    try {
      const job = (await service.createJob(
        {
          job_key: `deadline-${suffix}`,
          job_type: "github_project_progress_sync",
          name: "Deadline job",
          description: "",
          enabled: true,
          timezone: "Asia/Shanghai",
          schedule_type: "cron",
          cron_expression: "0 20 * * 1-5",
          catch_up_policy: "latest",
          overlap_policy: "forbid",
          model_provider: "nexttoken",
          model_id: "gpt-5.6-terra",
          model_parameters: {},
          retry_max_attempts: 3,
          retry_interval_seconds: 0,
          timeout_seconds: 600,
          retention_days: 90,
          tag_ids: [],
        },
        42,
      )) as { id: number };
      const triggered = (await service.triggerJob(job.id, 42)) as {
        run_id: string;
      };
      await database.db
        .updateTable("automation_job_runs")
        .set({ deadline_at: new Date(Date.now() - 1_000) })
        .where("id", "=", triggered.run_id)
        .execute();

      await service.runMaintenanceCycle();

      const attempts = await database.db
        .selectFrom("automation_job_runs")
        .select(["status", "attempt", "retry_recommended", "error_code"])
        .where("root_run_id", "=", triggered.run_id)
        .orderBy("attempt", "asc")
        .execute();
      assert.deepEqual(attempts, [{
        status: "failed",
        attempt: 1,
        retry_recommended: 0,
        error_code: "job_timeout",
      }]);
    } finally {
      await database.close();
    }
  },
);

test(
  "inherits the summary scope snapshot when retrying a failed run",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!);
    assert.match(url.pathname, /_automation_test$/);
    await runAutomationMigrations(url, new URL("../..", import.meta.url).pathname);
    const database = createAutomationDatabase(url);
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute();
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 3,
      manualTriggerWindowSeconds: 300,
    });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

    try {
      const job = (await service.createJob({
        job_key: `retry-scope-${suffix}`,
        job_type: "github_project_progress_sync",
        name: "Retry scope job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "cron",
        cron_expression: "0 20 * * 1-5",
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: {
          summary_scope: "latest_commit_of_updating_projects",
        },
        retry_max_attempts: 2,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [],
      }, 42)) as { id: number; version: number };
      const triggered = (await service.triggerJob(job.id, {
        project_id: 72,
        summary_scope: "today",
      }, 42)) as { run_id: string };
      const firstClaim = (await service.claimRun({
        worker_instance: "retry-scope-worker-1",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as {
        lease_token: string;
        model_parameters: Record<string, unknown>;
        execution_parameters: Record<string, unknown>;
      };
      assert.equal(
        firstClaim.model_parameters.summary_scope,
        "latest_commit_of_updating_projects",
      );
      assert.deepEqual(firstClaim.execution_parameters, {
        project_id: 72,
        summary_scope: "today",
      });

      await service.patchJob(job.id, {
        version: job.version,
        model_parameters: { summary_scope: "today" },
      }, 42);
      await service.updateRun(triggered.run_id, {
        worker_instance: "retry-scope-worker-1",
        lease_token: firstClaim.lease_token,
        status: "failed",
        error_code: "summary_failed",
        error_summary: "summary failed",
        retry_recommended: true,
      });

      const retryClaim = (await service.claimRun({
        worker_instance: "retry-scope-worker-2",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as {
        trigger_source: string;
        model_parameters: Record<string, unknown>;
        execution_parameters: Record<string, unknown>;
      };
      assert.equal(retryClaim.trigger_source, "retry");
      assert.equal(
        retryClaim.model_parameters.summary_scope,
        "latest_commit_of_updating_projects",
      );
      assert.deepEqual(retryClaim.execution_parameters, {
        project_id: 72,
        summary_scope: "today",
      });
    } finally {
      await database.close();
    }
  },
);

test(
  "deduplicates the same project scope and claims independent projects without overlapping full runs",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!);
    assert.match(url.pathname, /_automation_test$/);
    await runAutomationMigrations(url, new URL("../..", import.meta.url).pathname);
    const database = createAutomationDatabase(url);
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute();
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 10,
      manualTriggerWindowSeconds: 300,
    });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

    try {
      const job = (await service.createJob({
        job_key: `project-concurrency-${suffix}`,
        job_type: "github_project_progress_sync",
        name: "Project concurrency job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "cron",
        cron_expression: "0 20 * * 1-5",
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: { summary_scope: "today" },
        retry_max_attempts: 1,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [],
      }, 42)) as { id: number };

      const [project51First, project51Duplicate] = await Promise.all([
        service.triggerJob(job.id, { project_id: 51, summary_scope: "today" }, 42),
        service.triggerJob(job.id, { project_id: 51, summary_scope: "today" }, 42),
      ]) as Array<{ run_id: string; status: string; reused: boolean }>;
      assert.equal(project51First.run_id, project51Duplicate.run_id);
      assert.deepEqual(
        [project51First.reused, project51Duplicate.reused].sort(),
        [false, true],
      );

      const [project52, project53] = await Promise.all([
        service.triggerJob(job.id, { project_id: 52, summary_scope: "today" }, 42),
        service.triggerJob(job.id, { project_id: 53, summary_scope: "today" }, 42),
      ]) as Array<{ run_id: string; reused: boolean }>;
      assert.notEqual(project52.run_id, project53.run_id);
      assert.equal(project52.reused, false);
      assert.equal(project53.reused, false);

      const project51Latest = (await service.triggerJob(job.id, {
        project_id: 51,
        summary_scope: "latest_commit_of_updating_projects",
      }, 42)) as { run_id: string };
      const fullRun = (await service.triggerJob(job.id, {}, 42)) as {
        run_id: string;
      };

      const project51Active = (await service.listRuns(
        new URLSearchParams(
          `job_id=${job.id}&project_id=51&active_only=true&size=20`,
        ),
        42,
      )) as { items: Array<{ id: string }> };
      assert.deepEqual(
        project51Active.items.map((run) => run.id).sort(),
        [project51First.run_id, project51Latest.run_id, fullRun.run_id].sort(),
      );

      const project51TargetedOnly = (await service.listRuns(
        new URLSearchParams(
          `job_id=${job.id}&project_id=51&active_only=true&include_full_scope=false&size=20`,
        ),
        42,
      )) as { items: Array<{ id: string }> };
      assert.deepEqual(
        project51TargetedOnly.items.map((run) => run.id).sort(),
        [project51First.run_id, project51Latest.run_id].sort(),
      );

      const initialClaimResults = await Promise.all(
        [51, 52, 53].map(async (workerId) => {
          const workerInstance = `project-worker-${workerId}`;
          return {
            workerInstance,
            claim: await service.claimRun({
              worker_instance: workerInstance,
              supported_job_types: ["github_project_progress_sync"],
              lease_seconds: 300,
              claim_request_id: randomUUID(),
            }),
          };
        }),
      );
      assert.equal(
        initialClaimResults.filter((result) => result.claim).length,
        3,
        JSON.stringify(initialClaimResults),
      );
      const initialClaims = initialClaimResults as Array<{
        workerInstance: string;
        claim: {
          run_id: string;
          lease_token: string;
          execution_parameters: { project_id: number; summary_scope: string };
        };
      }>;
      assert.deepEqual(
        initialClaims
          .map(({ claim }) => claim.execution_parameters.project_id)
          .sort(),
        [51, 52, 53],
      );
      assert.equal(await service.claimRun({
        worker_instance: "blocked-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      }), null);

      const initialByProject = new Map(
        initialClaims.map((result) => [
          result.claim.execution_parameters.project_id,
          result,
        ]),
      );
      const project52Initial = initialByProject.get(52)!;
      const project53Initial = initialByProject.get(53)!;
      await finishClaim(service, project52Initial.claim, project52Initial.workerInstance);
      await finishClaim(service, project53Initial.claim, project53Initial.workerInstance);
      const project52Active = (await service.listRuns(
        new URLSearchParams(
          `job_id=${job.id}&project_id=52&active_only=true&include_full_scope=false&size=20`,
        ),
        42,
      )) as { items: Array<{ id: string }> };
      assert.equal(project52Active.items.length, 0);
      assert.equal(await service.claimRun({
        worker_instance: "still-blocked-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      }), null);

      const project51Initial = initialByProject.get(51)!;
      await finishClaim(service, project51Initial.claim, project51Initial.workerInstance);
      const latestClaim = (await service.claimRun({
        worker_instance: "latest-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as {
        run_id: string;
        lease_token: string;
        execution_parameters: { project_id: number; summary_scope: string };
      };
      assert.equal(latestClaim.run_id, project51Latest.run_id);

      const project54 = (await service.triggerJob(job.id, {
        project_id: 54,
        summary_scope: "today",
      }, 42)) as { run_id: string };
      const project54Claim = (await service.claimRun({
        worker_instance: "project-worker-54",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as {
        run_id: string;
        lease_token: string;
        execution_parameters: { project_id: number };
      };
      assert.equal(project54Claim.run_id, project54.run_id);

      await finishClaim(service, latestClaim, "latest-worker");
      assert.equal(await service.claimRun({
        worker_instance: "full-blocked-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      }), null);
      await finishClaim(service, project54Claim, "project-worker-54");

      const fullClaim = (await service.claimRun({
        worker_instance: "full-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as {
        run_id: string;
        lease_token: string;
        execution_parameters: Record<string, unknown>;
      };
      assert.equal(fullClaim.run_id, fullRun.run_id);
      assert.deepEqual(fullClaim.execution_parameters, {});

      const project55 = (await service.triggerJob(job.id, {
        project_id: 55,
        summary_scope: "today",
      }, 42)) as { run_id: string };
      assert.equal(await service.claimRun({
        worker_instance: "full-active-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      }), null);
      await finishClaim(service, fullClaim, "full-worker");

      const project55Claim = (await service.claimRun({
        worker_instance: "project-worker-55",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as { run_id: string; lease_token: string };
      assert.equal(project55Claim.run_id, project55.run_id);
      await finishClaim(service, project55Claim, "project-worker-55");

      const project56 = (await service.triggerJob(job.id, {
        project_id: 56,
        summary_scope: "today",
      }, 42)) as { run_id: string };
      const project56Claim = (await service.claimRun({
        worker_instance: "project-worker-56",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as { run_id: string; lease_token: string };
      assert.equal(project56Claim.run_id, project56.run_id);
      await database.db
        .updateTable("automation_jobs")
        .set({ next_run_at: new Date(Date.now() - 1_000) })
        .where("id", "=", job.id)
        .execute();

      const maintenance = await service.runMaintenanceCycle();
      assert.equal(maintenance.scheduled, 1);
      const scheduledRuns = (await service.listRuns(
        new URLSearchParams(`job_id=${job.id}&trigger_source=schedule&size=10`),
        42,
      )) as { items: Array<{ id: string; status: string }> };
      assert.equal(scheduledRuns.items.length, 1);
      assert.equal(scheduledRuns.items[0]?.status, "pending");
      assert.equal(await service.claimRun({
        worker_instance: "scheduled-blocked-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      }), null);

      await finishClaim(service, project56Claim, "project-worker-56");
      const scheduledClaim = (await service.claimRun({
        worker_instance: "scheduled-worker",
        supported_job_types: ["github_project_progress_sync"],
        lease_seconds: 300,
        claim_request_id: randomUUID(),
      })) as { run_id: string; lease_token: string };
      assert.equal(scheduledClaim.run_id, scheduledRuns.items[0]?.id);
      await finishClaim(service, scheduledClaim, "scheduled-worker");

      const secondJob = (await service.createJob({
        job_key: `second-concurrency-${suffix}`,
        job_type: "github_project_progress_sync",
        name: "Second concurrency job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "cron",
        cron_expression: "0 21 * * 1-5",
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: { summary_scope: "today" },
        retry_max_attempts: 1,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [],
      }, 42)) as { id: number };
      const [firstJobRun, secondJobRun] = await Promise.all([
        service.triggerJob(job.id, { project_id: 61 }, 42),
        service.triggerJob(secondJob.id, { project_id: 62 }, 42),
      ]) as Array<{ run_id: string }>;
      const crossJobResults = await Promise.all(
        [1, 2].map(async (workerId) => {
          const workerInstance = `cross-job-worker-${workerId}`;
          return {
            workerInstance,
            claim: await service.claimRun({
              worker_instance: workerInstance,
              supported_job_types: ["github_project_progress_sync"],
              lease_seconds: 300,
              claim_request_id: randomUUID(),
            }),
          };
        }),
      ) as Array<{
        workerInstance: string;
        claim: { run_id: string; lease_token: string } | null;
      }>;
      assert.deepEqual(
        crossJobResults.map((result) => result.claim?.run_id).sort(),
        [firstJobRun.run_id, secondJobRun.run_id].sort(),
      );
      for (const result of crossJobResults) {
        await finishClaim(service, result.claim!, result.workerInstance);
      }

      const strictRateLimitService = new AutomationService(database, {
        modelProvider: "nexttoken",
        model: "gpt-5.6-terra",
        modelProviders: {
          nexttoken: {
            name: "Nexttoken",
            apiKey: "test",
            baseUrl: "https://example.test/v1",
            envKey: "NEXTTOKEN_API_KEY",
          },
        },
        scheduleGraceSeconds: 120,
        manualTriggerLimit: 1,
        manualTriggerWindowSeconds: 300,
      });
      const rateLimitJob = (await strictRateLimitService.createJob({
        job_key: `project-rate-limit-${suffix}`,
        job_type: "github_project_progress_sync",
        name: "Project rate limit job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "cron",
        cron_expression: "0 22 * * 1-5",
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: { summary_scope: "today" },
        retry_max_attempts: 1,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [],
      }, 42)) as { id: number };
      const rateProject71 = (await strictRateLimitService.triggerJob(
        rateLimitJob.id,
        { project_id: 71 },
        42,
      )) as { run_id: string; reused: boolean };
      const rateProject71Duplicate = (await strictRateLimitService.triggerJob(
        rateLimitJob.id,
        { project_id: 71 },
        42,
      )) as { run_id: string; reused: boolean };
      assert.equal(rateProject71Duplicate.run_id, rateProject71.run_id);
      assert.equal(rateProject71Duplicate.reused, true);
      const rateProject72 = (await strictRateLimitService.triggerJob(
        rateLimitJob.id,
        { project_id: 72 },
        42,
      )) as { reused: boolean };
      assert.equal(rateProject72.reused, false);
      await assert.rejects(
        () => strictRateLimitService.triggerJob(
          rateLimitJob.id,
          {
            project_id: 71,
            summary_scope: "latest_commit_of_updating_projects",
          },
          42,
        ),
        (error: unknown) =>
          error instanceof AutomationHttpError &&
          error.status === 429 &&
          error.code === "rate_limit_exceeded",
      );

      await database.db
        .updateTable("automation_job_runs")
        .set({ deadline_at: new Date(Date.now() - 1_000) })
        .where("id", "=", rateProject71.run_id)
        .execute();
      const replacementAfterDeadline = (await strictRateLimitService.triggerJob(
        rateLimitJob.id,
        { project_id: 71 },
        43,
      )) as { run_id: string; reused: boolean };
      assert.notEqual(replacementAfterDeadline.run_id, rateProject71.run_id);
      assert.equal(replacementAfterDeadline.reused, false);
    } finally {
      await database.close();
    }
  },
);

async function finishClaim(
  service: AutomationService,
  claim: { run_id: string; lease_token: string },
  workerInstance: string,
): Promise<void> {
  await service.updateRun(claim.run_id, {
    worker_instance: workerInstance,
    lease_token: claim.lease_token,
    status: "failed",
    error_code: "test_finished",
    error_summary: "test finished",
    retry_recommended: false,
  });
}
