import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AutomationService } from "../src/automation/application/automationService.js";
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
