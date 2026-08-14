import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import {
  MODEL_CATALOG,
  MODEL_CATALOG_VERSION,
  getDefaultModel,
  getModelDisplayName,
  resolveAutomationModelSelection,
  type ModelProviderId,
} from "../../config/modelCatalog.js";
import type { ModelProviderConfig } from "../../config/config.js";
import {
  formatDateInTimeZone,
  type ProjectProgressSummaryScope,
} from "../../domain/projectProgress.js";
import {
  automationAiInteractionCreateSchema,
  automationClaimSchema,
  automationHeartbeatSchema,
  automationJobCreateSchema,
  automationJobPatchSchema,
  automationManualRunCreateSchema,
  automationPromptProfilePatchSchema,
  automationRunPatchSchema,
  automationRunProjectUpsertSchema,
  automationTagCreateSchema,
  automationTagPatchSchema,
  automationTraceEventUpsertSchema,
} from "../contracts.js";
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  calculateNextRunAt,
  calculatePreviousRunAt,
  digestLeaseToken,
  ensureRunTransition,
  redactSensitiveData,
  sanitizeErrorSummary,
  verifyLeaseToken,
} from "../domain.js";
import {
  AutomationHttpError,
  type AutomationOperations,
} from "../http/automationHttpApplication.js";
import type {
  AutomationDatabase,
  AutomationDatabaseSchema,
} from "../persistence/database.js";

type DbExecutor =
  | Kysely<AutomationDatabaseSchema>
  | Transaction<AutomationDatabaseSchema>;
type JobRow = Awaited<ReturnType<AutomationService["loadJob"]>>;
type RunRow = Selectable<AutomationDatabaseSchema["automation_job_runs"]>;
type TagRow = Selectable<AutomationDatabaseSchema["automation_tags"]>;
type PromptProfileRow = Selectable<
  AutomationDatabaseSchema["automation_prompt_profiles"]
>;
type RunProjectRow = Selectable<
  AutomationDatabaseSchema["automation_job_run_projects"]
>;
type AiInteractionRow = Selectable<
  AutomationDatabaseSchema["automation_ai_interactions"]
>;
type TraceEventRow = Selectable<
  AutomationDatabaseSchema["automation_run_trace_events"]
>;

const REQUIRED_PROMPT_CAPABILITIES = [
  "github_project_tracking",
  "rwkvos_system_calls",
] as const;
const SUCCESSFUL_PROJECT_OUTCOMES = new Set([
  "evaluated",
  "archived",
  "no_github_urls",
  "no_commits",
]);
const TERMINAL_TRACE_STATUSES = new Set([
  "succeeded",
  "fallback",
  "failed",
  "cancelled",
]);

export type AutomationServiceConfig = {
  modelProvider: ModelProviderId;
  model: string;
  modelProviders: Record<ModelProviderId, ModelProviderConfig>;
  scheduleGraceSeconds: number;
  manualTriggerLimit: number;
  manualTriggerWindowSeconds: number;
};

export class AutomationService implements AutomationOperations {
  private readonly manualTriggerAttempts = new Map<string, number[]>();

  constructor(
    private readonly database: AutomationDatabase,
    private readonly config: AutomationServiceConfig,
  ) {}

  async getModelCatalog(_userId: number): Promise<unknown> {
    return {
      catalog_version: MODEL_CATALOG_VERSION,
      cached_at: new Date().toISOString(),
      stale: false,
      providers: Object.entries(MODEL_CATALOG).map(([provider, models]) => ({
        provider,
        display_name: this.config.modelProviders[provider as ModelProviderId].name,
        models: models.map((model) => ({
          model_id: model,
          display_name: getModelDisplayName(model),
          enabled: true,
          supports_structured_output: true,
          is_default: model === getDefaultModel(provider as ModelProviderId),
        })),
      })),
    };
  }

  async getPromptProfile(jobType: string, _userId: number): Promise<unknown> {
    this.ensureSupportedJobType(jobType, "automation_prompt_profile_not_found");
    const profile = await this.database.db
      .selectFrom("automation_prompt_profiles")
      .selectAll()
      .where("job_type", "=", jobType)
      .executeTakeFirst();
    if (!profile) {
      throw notFound("automation_prompt_profile_not_found", "自动任务内容配置不存在");
    }
    return serializePromptProfile(profile);
  }

  async patchPromptProfile(
    jobType: string,
    body: unknown,
    userId: number,
  ): Promise<unknown> {
    this.ensureSupportedJobType(jobType, "automation_prompt_profile_not_found");
    const input = automationPromptProfilePatchSchema.parse(body);
    return this.database.db.transaction().execute(async (tx) => {
      const profile = await tx
        .selectFrom("automation_prompt_profiles")
        .selectAll()
        .where("job_type", "=", jobType)
        .forUpdate()
        .executeTakeFirst();
      if (!profile) {
        throw notFound("automation_prompt_profile_not_found", "自动任务内容配置不存在");
      }
      if (
        profile.system_prompt === input.system_prompt &&
        Boolean(profile.enabled) === input.enabled
      ) {
        return serializePromptProfile(profile);
      }
      if (profile.version !== input.version) {
        throw conflict(
          "automation_prompt_version_conflict",
          "自动任务内容配置版本冲突",
        );
      }
      const now = new Date();
      const contentChanged = profile.system_prompt !== input.system_prompt;
      await tx
        .updateTable("automation_prompt_profiles")
        .set({
          system_prompt: input.system_prompt,
          prompt_version: contentChanged
            ? promptVersionFor(input.system_prompt)
            : profile.prompt_version,
          enabled: input.enabled ? 1 : 0,
          version: profile.version + 1,
          updated_by: userId,
          updated_at: now,
        })
        .where("id", "=", profile.id)
        .executeTakeFirstOrThrow();
      const updated = await tx
        .selectFrom("automation_prompt_profiles")
        .selectAll()
        .where("id", "=", profile.id)
        .executeTakeFirstOrThrow();
      return serializePromptProfile(updated);
    });
  }

  async listTags(query: URLSearchParams, _userId: number): Promise<unknown> {
    const page = queryInteger(query, "page", 1, 1, Number.MAX_SAFE_INTEGER);
    const size = queryInteger(query, "size", 10, 1, 100);
    const name = optionalQuery(query, "name", 100);
    const enabled = queryBoolean(query, "enabled");
    let selection = this.database.db.selectFrom("automation_tags as tag");
    let countSelection = this.database.db.selectFrom("automation_tags as tag");
    if (name) {
      selection = selection.where("tag.name", "like", `%${escapeLike(name)}%`);
      countSelection = countSelection.where("tag.name", "like", `%${escapeLike(name)}%`);
    }
    if (enabled !== null) {
      selection = selection.where("tag.enabled", "=", enabled ? 1 : 0);
      countSelection = countSelection.where("tag.enabled", "=", enabled ? 1 : 0);
    }
    const [countRow, rows] = await Promise.all([
      countSelection
        .select(({ fn }) => fn.count<number>("tag.id").as("count"))
        .executeTakeFirstOrThrow(),
      selection
        .selectAll("tag")
        .select((eb) =>
          eb
            .selectFrom("automation_job_tags as jt")
            .select(({ fn }) => fn.count<number>("jt.job_id").as("count"))
            .whereRef("jt.tag_id", "=", "tag.id")
            .as("job_count"),
        )
        .orderBy("tag.name", "asc")
        .offset((page - 1) * size)
        .limit(size)
        .execute(),
    ]);
    return {
      total: Number(countRow.count),
      items: rows.map((row) => serializeTag(row, Number(row.job_count))),
    };
  }

  async createTag(body: unknown, userId: number): Promise<unknown> {
    const input = automationTagCreateSchema.parse(body);
    const now = new Date();
    try {
      const result = await this.database.db
        .insertInto("automation_tags")
        .values({
          name: input.name,
          normalized_name: normalizeTagName(input.name),
          color: input.color,
          description: input.description,
          enabled: input.enabled ? 1 : 0,
          created_by: userId,
          updated_by: userId,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      const row = await this.database.db
        .selectFrom("automation_tags")
        .selectAll()
        .where("id", "=", Number(result.insertId))
        .executeTakeFirstOrThrow();
      return serializeTag(row, 0);
    } catch (error) {
      rethrowDuplicate(error, "tag_name_conflict", "标签名称已存在");
    }
  }

  async patchTag(tagId: number, body: unknown, userId: number): Promise<unknown> {
    const input = automationTagPatchSchema.parse(body);
    const existing = await this.database.db
      .selectFrom("automation_tags")
      .selectAll()
      .where("id", "=", tagId)
      .executeTakeFirst();
    if (!existing) {
      throw notFound("automation_tag_not_found", "标签不存在");
    }
    try {
      await this.database.db
        .updateTable("automation_tags")
        .set({
          ...(input.name !== undefined
            ? { name: input.name, normalized_name: normalizeTagName(input.name) }
            : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where("id", "=", tagId)
        .executeTakeFirstOrThrow();
    } catch (error) {
      rethrowDuplicate(error, "tag_name_conflict", "标签名称已存在");
    }
    const [row, count] = await Promise.all([
      this.database.db
        .selectFrom("automation_tags")
        .selectAll()
        .where("id", "=", tagId)
        .executeTakeFirstOrThrow(),
      this.database.db
        .selectFrom("automation_job_tags")
        .select(({ fn }) => fn.count<number>("job_id").as("count"))
        .where("tag_id", "=", tagId)
        .executeTakeFirstOrThrow(),
    ]);
    return serializeTag(row, Number(count.count));
  }

  async deleteTag(tagId: number, _userId: number): Promise<unknown> {
    const row = await this.database.db
      .selectFrom("automation_tags")
      .select("id")
      .where("id", "=", tagId)
      .executeTakeFirst();
    if (!row) {
      throw notFound("automation_tag_not_found", "标签不存在");
    }
    const count = await this.database.db
      .selectFrom("automation_job_tags")
      .select(({ fn }) => fn.count<number>("job_id").as("count"))
      .where("tag_id", "=", tagId)
      .executeTakeFirstOrThrow();
    if (Number(count.count) > 0) {
      throw conflict("tag_in_use", "标签正在被任务使用，请先停用");
    }
    await this.database.db
      .deleteFrom("automation_tags")
      .where("id", "=", tagId)
      .executeTakeFirst();
    return { id: tagId };
  }

  async listJobs(query: URLSearchParams, _userId: number): Promise<unknown> {
    const page = queryInteger(query, "page", 1, 1, Number.MAX_SAFE_INTEGER);
    const size = queryInteger(query, "size", 10, 1, 100);
    const includeDeleted = queryBoolean(query, "include_deleted") ?? false;
    const enabled = queryBoolean(query, "enabled");
    const tagId = queryOptionalInteger(query, "tag_id");
    const filters = {
      name: optionalQuery(query, "name", 255),
      jobType: optionalQuery(query, "job_type", 100),
      modelProvider: optionalQuery(query, "model_provider", 100),
      modelId: optionalQuery(query, "model_id", 150),
      configurationStatus: optionalQuery(query, "configuration_status", 20),
    };
    const sort = query.get("sort") || "-created_at";
    const sortColumn = jobSortColumn(sort.replace(/^-/, ""));
    const direction = sort.startsWith("-") ? "desc" : "asc";

    let base = this.database.db.selectFrom("automation_jobs as job");
    if (tagId !== null) {
      base = base
        .innerJoin("automation_job_tags as filter_tag", "filter_tag.job_id", "job.id")
        .where("filter_tag.tag_id", "=", tagId);
    }
    if (!includeDeleted) base = base.where("job.deleted_at", "is", null);
    if (enabled !== null) base = base.where("job.enabled", "=", enabled ? 1 : 0);
    if (filters.name) base = base.where("job.name", "like", `%${escapeLike(filters.name)}%`);
    if (filters.jobType) base = base.where("job.job_type", "=", filters.jobType);
    if (filters.modelProvider) base = base.where("job.model_provider", "=", filters.modelProvider);
    if (filters.modelId) base = base.where("job.model_id", "=", filters.modelId);
    if (filters.configurationStatus) {
      base = base.where("job.configuration_status", "=", filters.configurationStatus);
    }
    const [countRow, jobs] = await Promise.all([
      base
        .select(({ fn }) => fn.count<number>("job.id").distinct().as("count"))
        .executeTakeFirstOrThrow(),
      base
        .selectAll("job")
        .orderBy(sortColumn, direction)
        .orderBy("job.id", "desc")
        .offset((page - 1) * size)
        .limit(size)
        .execute(),
    ]);
    const tags = await this.tagsByJobIds(jobs.map((job) => job.id));
    return {
      total: Number(countRow.count),
      items: jobs.map((job) => serializeJob(job, tags.get(job.id) ?? [], false)),
    };
  }

  async createJob(body: unknown, userId: number): Promise<unknown> {
    const input = automationJobCreateSchema.parse(body);
    this.validateModel(input.model_provider, input.model_id);
    const now = new Date();
    try {
      const jobId = await this.database.db.transaction().execute(async (tx) => {
        await this.resolveTags(tx, input.tag_ids);
        const result = await tx
          .insertInto("automation_jobs")
          .values({
            job_key: input.job_key,
            job_type: input.job_type,
            name: input.name,
            description: input.description,
            enabled: input.enabled ? 1 : 0,
            timezone: input.timezone,
            schedule_type: input.schedule_type,
            cron_expression: input.cron_expression,
            catch_up_policy: input.catch_up_policy,
            overlap_policy: input.overlap_policy,
            model_provider: input.model_provider,
            model_id: input.model_id,
            model_parameters: JSON.stringify(input.model_parameters),
            model_catalog_version: MODEL_CATALOG_VERSION,
            retry_max_attempts: input.retry_max_attempts,
            retry_interval_seconds: input.retry_interval_seconds,
            timeout_seconds: input.timeout_seconds,
            retention_days: input.retention_days,
            last_scheduled_at: null,
            last_started_at: null,
            last_finished_at: null,
            next_run_at: input.enabled
              ? calculateNextRunAt(input.cron_expression, input.timezone, now)
              : null,
            last_run_status: null,
            configuration_status: "valid",
            configuration_error: null,
            version: 1,
            created_by: userId,
            updated_by: userId,
            deleted_at: null,
            deleted_by: null,
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
        const id = Number(result.insertId);
        if (input.tag_ids.length) {
          await tx
            .insertInto("automation_job_tags")
            .values(input.tag_ids.map((tagId) => ({ job_id: id, tag_id: tagId, created_at: now })))
            .execute();
        }
        await tx
          .insertInto("automation_job_change_logs")
          .values({
            job_id: id,
            action: "created",
            version_before: null,
            version_after: 1,
            changes_json: JSON.stringify({ created: true }),
            operated_by: userId,
            created_at: now,
          })
          .execute();
        return id;
      });
      return this.getJob(jobId, new URLSearchParams(), userId);
    } catch (error) {
      rethrowDuplicate(
        error,
        "automation_job_key_conflict",
        "job_key 已存在",
      );
    }
  }

  async getJob(
    jobId: number,
    query: URLSearchParams,
    _userId: number,
  ): Promise<unknown> {
    const includeDeleted = queryBoolean(query, "include_deleted") ?? false;
    const job = await this.loadJob(jobId, includeDeleted);
    const tags = await this.tagsByJobIds([jobId]);
    const recent = await this.database.db
      .selectFrom("automation_job_runs")
      .select(["id", "status", "scheduled_at", "error_code", "error_summary"])
      .where("job_id", "=", jobId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return {
      ...serializeJob(job, tags.get(jobId) ?? [], true),
      recent_run: recent
        ? {
            ...recent,
            scheduled_at: formatUtc(recent.scheduled_at),
          }
        : null,
    };
  }

  async patchJob(jobId: number, body: unknown, userId: number): Promise<unknown> {
    const input = automationJobPatchSchema.parse(body);
    return this.database.db.transaction().execute(async (tx) => {
      const job = await tx
        .selectFrom("automation_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
      if (job.version !== input.version) {
        throw conflict("automation_job_version_conflict", "任务版本冲突");
      }
      const provider = input.model_provider ?? job.model_provider;
      const modelId = input.model_id ?? job.model_id;
      this.validateModel(provider, modelId);
      if (input.tag_ids) await this.resolveTags(tx, input.tag_ids);
      const now = new Date();
      const enabled = input.enabled ?? Boolean(job.enabled);
      const cronExpression = input.cron_expression ?? job.cron_expression;
      const timezone = input.timezone ?? job.timezone;
      const scheduleChanged =
        input.enabled !== undefined ||
        input.cron_expression !== undefined ||
        input.timezone !== undefined;
      const nextRunAt = !enabled
        ? null
        : scheduleChanged || !job.next_run_at
          ? calculateNextRunAt(cronExpression, timezone, now)
          : job.next_run_at;
      const changes = Object.fromEntries(
        Object.entries(input)
          .filter(([key]) => key !== "version")
          .map(([key, after]) => [
            key,
            { before: (job as Record<string, unknown>)[key] ?? null, after },
          ]),
      );
      const result = await tx
        .updateTable("automation_jobs")
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.cron_expression !== undefined
            ? { cron_expression: input.cron_expression }
            : {}),
          ...(input.catch_up_policy !== undefined
            ? { catch_up_policy: input.catch_up_policy }
            : {}),
          ...(input.model_provider !== undefined
            ? { model_provider: input.model_provider }
            : {}),
          ...(input.model_id !== undefined ? { model_id: input.model_id } : {}),
          ...(input.model_parameters !== undefined
            ? { model_parameters: JSON.stringify(input.model_parameters) }
            : {}),
          ...(input.retry_max_attempts !== undefined
            ? { retry_max_attempts: input.retry_max_attempts }
            : {}),
          ...(input.retry_interval_seconds !== undefined
            ? { retry_interval_seconds: input.retry_interval_seconds }
            : {}),
          ...(input.timeout_seconds !== undefined
            ? { timeout_seconds: input.timeout_seconds }
            : {}),
          ...(input.retention_days !== undefined
            ? { retention_days: input.retention_days }
            : {}),
          next_run_at: nextRunAt,
          configuration_status: "valid",
          configuration_error: null,
          model_catalog_version: MODEL_CATALOG_VERSION,
          updated_by: userId,
          updated_at: now,
          version: input.version + 1,
        })
        .where("id", "=", jobId)
        .where("version", "=", input.version)
        .executeTakeFirstOrThrow();
      if (Number(result.numUpdatedRows) !== 1) {
        throw conflict("automation_job_version_conflict", "任务版本冲突");
      }
      if (input.tag_ids) {
        await tx.deleteFrom("automation_job_tags").where("job_id", "=", jobId).execute();
        if (input.tag_ids.length) {
          await tx
            .insertInto("automation_job_tags")
            .values(input.tag_ids.map((tagId) => ({ job_id: jobId, tag_id: tagId, created_at: now })))
            .execute();
        }
      }
      await tx
        .insertInto("automation_job_change_logs")
        .values({
          job_id: jobId,
          action: "updated",
          version_before: input.version,
          version_after: input.version + 1,
          changes_json: JSON.stringify(changes),
          operated_by: userId,
          created_at: now,
        })
        .execute();
      return this.getJobWithExecutor(tx, jobId, false);
    });
  }

  async deleteJob(jobId: number, version: number, userId: number): Promise<unknown> {
    return this.database.db.transaction().execute(async (tx) => {
      const job = await tx
        .selectFrom("automation_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .forUpdate()
        .executeTakeFirst();
      if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
      if (job.deleted_at) return this.getJobWithExecutor(tx, jobId, true);
      if (job.version !== version) {
        throw conflict("automation_job_version_conflict", "任务版本冲突");
      }
      const active = await tx
        .selectFrom("automation_job_runs")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .where("job_id", "=", jobId)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .executeTakeFirstOrThrow();
      if (Number(active.count)) {
        throw conflict("job_has_active_run", "任务存在未结束运行");
      }
      const now = new Date();
      await tx
        .updateTable("automation_jobs")
        .set({
          enabled: 0,
          next_run_at: null,
          deleted_at: now,
          deleted_by: userId,
          updated_by: userId,
          updated_at: now,
          version: version + 1,
        })
        .where("id", "=", jobId)
        .where("version", "=", version)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("automation_job_change_logs")
        .values({
          job_id: jobId,
          action: "deleted",
          version_before: version,
          version_after: version + 1,
          changes_json: JSON.stringify({
            enabled: { before: Boolean(job.enabled), after: false },
            next_run_at: { before: formatUtc(job.next_run_at), after: null },
            deleted_at: { before: null, after: formatUtc(now) },
            deleted_by: { before: null, after: userId },
          }),
          operated_by: userId,
          created_at: now,
        })
        .execute();
      return this.getJobWithExecutor(tx, jobId, true);
    });
  }

  async validateJob(jobId: number, userId: number): Promise<unknown> {
    const job = await this.loadJob(jobId, false);
    try {
      this.validateModel(job.model_provider, job.model_id);
    } catch {
      await this.setJobValidation(
        jobId,
        false,
        null,
        "model_configuration_invalid",
        userId,
      );
      throw new AutomationHttpError(
        422,
        "model_configuration_invalid",
        "任务模型配置无效",
      );
    }
    return this.setJobValidation(
      jobId,
      true,
      MODEL_CATALOG_VERSION,
      null,
      userId,
    );
  }

  async triggerJob(jobId: number, userId: number): Promise<unknown>;
  async triggerJob(jobId: number, body: unknown, userId: number): Promise<unknown>;
  async triggerJob(
    jobId: number,
    bodyOrUserId: unknown,
    explicitUserId?: number,
  ): Promise<unknown> {
    const userId = explicitUserId ?? Number(bodyOrUserId);
    const input = automationManualRunCreateSchema.parse(
      explicitUserId === undefined ? {} : bodyOrUserId,
    );
    try {
      return await this.database.db.transaction().execute(async (tx) => {
        const job = await tx
          .selectFrom("automation_jobs")
          .selectAll()
          .where("id", "=", jobId)
          .where("deleted_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
        if (!job.enabled) throw conflict("job_disabled", "任务未启用");
        if (job.configuration_status !== "valid") {
          throw conflict("job_configuration_invalid", "任务配置无效");
        }
        this.validateModel(job.model_provider, job.model_id);
        const now = new Date();
        const activeRuns = await tx
          .selectFrom("automation_job_runs")
          .select([
            "id",
            "status",
            "scheduled_at",
            "timezone_snapshot",
            "model_parameters_snapshot",
            "execution_parameters_snapshot",
          ])
          .where("job_id", "=", jobId)
          .where("status", "in", [...ACTIVE_RUN_STATUSES])
          .where("deadline_at", ">", now)
          .orderBy("created_at", "asc")
          .execute();
        const requestedScope = resolveRequestedRunScope(
          input,
          parseJson(job.model_parameters, {}),
        );
        const reusable = activeRuns.find((run) =>
          isSameManualRunScope(requestedScope, run, now, job.timezone),
        );
        if (reusable) {
          return {
            run_id: reusable.id,
            status: reusable.status,
            reused: true,
          };
        }
        this.enforceManualRateLimit(userId, jobId, input.project_id ?? null);
        const scheduledAt = await nextManualScheduledAt(tx, jobId, now);
        const runId = await this.insertRootRun(
          tx,
          job,
          "manual",
          scheduledAt,
          now,
          now,
          undefined,
          input,
        );
        await tx
          .updateTable("automation_jobs")
          .set({ model_catalog_version: MODEL_CATALOG_VERSION, updated_at: now })
          .where("id", "=", jobId)
          .execute();
        return { run_id: runId, status: "pending", reused: false };
      });
    } catch (error) {
      if (error instanceof AutomationHttpError && error.code === "invalid_model") {
        await this.setJobValidation(
          jobId,
          false,
          null,
          "model_configuration_invalid",
          userId,
        );
        throw conflict("job_configuration_invalid", "任务模型配置无效");
      }
      throw error;
    }
  }

  async listRuns(query: URLSearchParams, _userId: number): Promise<unknown> {
    const page = queryInteger(query, "page", 1, 1, Number.MAX_SAFE_INTEGER);
    const size = queryInteger(query, "size", 10, 1, 100);
    const jobId = queryOptionalInteger(query, "job_id");
    const tagId = queryOptionalInteger(query, "tag_id");
    const projectId = queryOptionalInteger(query, "project_id");
    const activeOnly = queryBoolean(query, "active_only") ?? false;
    const includeFullScope = queryBoolean(query, "include_full_scope") ?? true;
    const filters = {
      status: optionalQuery(query, "status", 32),
      triggerSource: optionalQuery(query, "trigger_source", 20),
      modelProvider: optionalQuery(query, "model_provider", 100),
      modelId: optionalQuery(query, "model_id", 150),
      startedAfter: queryDate(query, "started_after"),
      startedBefore: queryDate(query, "started_before"),
    };
    const sort = optionalQuery(query, "sort", 32) ?? "-scheduled_at";
    const sortColumn = runSortColumn(sort.replace(/^-/, ""));
    const sortDirection = sort.startsWith("-") ? "desc" : "asc";
    let base = this.database.db
      .selectFrom("automation_job_runs as run")
      .leftJoin("automation_jobs as job", "job.id", "run.job_id");
    if (tagId !== null) {
      base = base.where(
        sql<boolean>`JSON_CONTAINS(run.tags_snapshot, ${JSON.stringify({ id: tagId })})`,
      );
    }
    if (jobId !== null) base = base.where("run.job_id", "=", jobId);
    if (projectId !== null) {
      const targetProjectId = sql<number | null>`CAST(
        JSON_UNQUOTE(JSON_EXTRACT(run.execution_parameters_snapshot, '$.project_id'))
        AS UNSIGNED
      )`;
      base = base.where(
        includeFullScope
          ? sql<boolean>`(${targetProjectId} = ${projectId} OR ${targetProjectId} IS NULL)`
          : sql<boolean>`${targetProjectId} = ${projectId}`,
      );
    }
    if (activeOnly) base = base.where("run.status", "in", [...ACTIVE_RUN_STATUSES]);
    if (filters.status) base = base.where("run.status", "=", filters.status);
    if (filters.triggerSource) base = base.where("run.trigger_source", "=", filters.triggerSource);
    if (filters.modelProvider) base = base.where("run.model_provider_snapshot", "=", filters.modelProvider);
    if (filters.modelId) base = base.where("run.model_id_snapshot", "=", filters.modelId);
    if (filters.startedAfter) base = base.where("run.started_at", ">=", filters.startedAfter);
    if (filters.startedBefore) base = base.where("run.started_at", "<=", filters.startedBefore);
    const [count, rows] = await Promise.all([
      base
        .select(({ fn }) => fn.count<number>("run.id").distinct().as("count"))
        .executeTakeFirstOrThrow(),
      base
        .selectAll("run")
        .select("job.deleted_at as job_deleted_at")
        .orderBy(sortColumn, sortDirection)
        .orderBy("run.id", "desc")
        .offset((page - 1) * size)
        .limit(size)
        .execute(),
    ]);
    return {
      total: Number(count.count),
      items: rows.map((row) => serializeRun(row, row.job_deleted_at !== null)),
    };
  }

  async getRun(
    runId: string,
    query: URLSearchParams,
    _userId: number,
  ): Promise<unknown> {
    const includes = new Set(
      (query.get("include") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    for (const include of includes) {
      if (!["projects", "ai_interactions", "attempts"].includes(include)) {
        throw new AutomationHttpError(422, "invalid_include", "include 参数不支持");
      }
    }
    const row = await this.database.db
      .selectFrom("automation_job_runs as run")
      .leftJoin("automation_jobs as job", "job.id", "run.job_id")
      .selectAll("run")
      .select("job.deleted_at as job_deleted_at")
      .where("run.id", "=", runId)
      .executeTakeFirst();
    if (!row) throw notFound("automation_run_not_found", "运行记录不存在");
    const result = serializeRun(row, row.job_deleted_at !== null) as Record<string, unknown>;
    const aiCount = await this.database.db
      .selectFrom("automation_ai_interactions")
      .select(({ fn }) => fn.count<number>("id").as("count"))
      .where("run_id", "=", runId)
      .executeTakeFirstOrThrow();
    result.ai_interaction_count = Number(aiCount.count);
    if (includes.has("projects")) {
      const projects = await this.database.db
        .selectFrom("automation_job_run_projects")
        .selectAll()
        .where("run_id", "=", runId)
        .orderBy("id", "asc")
        .execute();
      result.projects = projects.map(serializeRunProject);
    }
    if (includes.has("ai_interactions")) {
      const interactions = await this.database.db
        .selectFrom("automation_ai_interactions")
        .selectAll()
        .where("run_id", "=", runId)
        .orderBy("id", "asc")
        .execute();
      result.ai_interactions = interactions.map(serializeAiInteraction);
    }
    if (includes.has("attempts")) {
      const attempts = await this.database.db
        .selectFrom("automation_job_runs")
        .selectAll()
        .where("root_run_id", "=", row.root_run_id)
        .orderBy("attempt", "asc")
        .execute();
      result.attempts = attempts.map((attempt) => serializeRun(attempt, false));
    }
    return result;
  }

  async cancelRun(runId: string, userId: number): Promise<unknown> {
    return this.database.db.transaction().execute(async (tx) => {
      const run = await tx
        .selectFrom("automation_job_runs")
        .selectAll()
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw notFound("automation_run_not_found", "运行记录不存在");
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw conflict("invalid_run_transition", "运行已结束");
      }
      const now = new Date();
      const pending = run.status === "pending";
      await tx
        .updateTable("automation_job_runs")
        .set({
          cancel_requested_at: now,
          cancel_requested_by: userId,
          updated_at: now,
          ...(pending
            ? { status: "cancelled", finished_at: now, duration_ms: 0 }
            : {}),
        })
        .where("id", "=", runId)
        .execute();
      if (pending) {
        await tx
          .updateTable("automation_jobs")
          .set({ last_finished_at: now, last_run_status: "cancelled", updated_at: now })
          .where("id", "=", run.job_id)
          .execute();
      }
      const updated = await tx
        .selectFrom("automation_job_runs")
        .selectAll()
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      return serializeRun(updated, false);
    });
  }

  async listTraceEvents(
    runId: string,
    _query: URLSearchParams,
    _userId: number,
  ): Promise<unknown> {
    const exists = await this.database.db
      .selectFrom("automation_job_runs")
      .select("id")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!exists) throw notFound("automation_run_not_found", "运行记录不存在");
    const items = await this.database.db
      .selectFrom("automation_run_trace_events")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("sequence", "asc")
      .orderBy("occurred_at", "asc")
      .orderBy("id", "asc")
      .limit(1000)
      .execute();
    return { total: items.length, items: items.map(serializeTraceEvent) };
  }

  async runMaintenanceCycle(): Promise<{
    scheduled: number;
    modelConfigurationsInvalidated: number;
    aiInteractionsPurged: number;
    traceEventsPurged: number;
  }> {
    await this.withWorkerTransaction(async (connection, now) => {
      await this.expireDeadlines(connection, now);
    });
    let scheduled = 0;
    for (let index = 0; index < 20; index += 1) {
      const handled = await this.database.db.transaction().execute(async (tx) => {
        const job = await tx
          .selectFrom("automation_jobs")
          .selectAll()
          .where("enabled", "=", 1)
          .where("deleted_at", "is", null)
          .where("configuration_status", "=", "valid")
          .where("next_run_at", "is not", null)
          .where("next_run_at", "<=", new Date())
          .orderBy("next_run_at", "asc")
          .orderBy("id", "asc")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!job?.next_run_at) return false;
        const now = new Date();
        const missedAt = job.next_run_at;
        let scheduledAt = missedAt;
        let triggerSource: "schedule" | "catch_up" = "schedule";
        let nextRunAt: Date;
        let shouldRun = true;
        try {
          const delaySeconds = Math.max(0, (now.getTime() - missedAt.getTime()) / 1000);
          if (delaySeconds <= this.config.scheduleGraceSeconds) {
            nextRunAt = calculateNextRunAt(
              job.cron_expression,
              job.timezone,
              missedAt,
            );
          } else {
            scheduledAt = calculatePreviousRunAt(
              job.cron_expression,
              job.timezone,
              now,
            );
            nextRunAt = calculateNextRunAt(job.cron_expression, job.timezone, now);
            shouldRun = job.catch_up_policy === "latest";
            triggerSource = shouldRun ? "catch_up" : "schedule";
          }
        } catch (error) {
          await this.insertRootRun(
            tx,
            job,
            "schedule",
            missedAt,
            now,
            now,
            {
              status: "configuration_error",
              code:
                error && typeof error === "object" && "code" in error
                  ? String((error as { code: unknown }).code)
                  : "invalid_cron_expression",
              summary: "任务调度配置无效",
            },
          );
          await tx
            .updateTable("automation_jobs")
            .set({
              configuration_status: "invalid",
              configuration_error: "invalid_cron_expression",
              last_scheduled_at: missedAt,
              last_run_status: "configuration_error",
              next_run_at: null,
              updated_at: now,
            })
            .where("id", "=", job.id)
            .execute();
          return true;
        }
        if (!shouldRun) {
          await this.insertRootRun(
            tx,
            job,
            triggerSource,
            scheduledAt,
            now,
            now,
            {
              status: "skipped",
              code: "schedule_missed",
              summary: "计划时间已错过",
            },
          );
        } else {
          await this.insertRootRun(
            tx,
            job,
            triggerSource,
            scheduledAt,
            now,
            now,
          );
        }
        await tx
          .updateTable("automation_jobs")
          .set({
            last_scheduled_at: scheduledAt,
            next_run_at: nextRunAt!,
            ...(!shouldRun ? { last_run_status: "skipped" } : {}),
            updated_at: now,
          })
          .where("id", "=", job.id)
          .execute();
        return true;
      });
      if (!handled) break;
      scheduled += 1;
    }

    const modelConfigurationsInvalidated = await this.reconcileModelCatalog();
    const { aiInteractionsPurged, traceEventsPurged } = await this.purgeAuditData();
    return {
      scheduled,
      modelConfigurationsInvalidated,
      aiInteractionsPurged,
      traceEventsPurged,
    };
  }

  // Worker methods are implemented below to keep their transaction boundary explicit.
  claimRun(body: unknown): Promise<unknown> {
    return this.claimRunWithLease(body);
  }

  heartbeatRun(runId: string, body: unknown): Promise<unknown> {
    return this.heartbeatRunWithLease(runId, body);
  }

  updateRun(runId: string, body: unknown): Promise<unknown> {
    return this.updateRunWithLease(runId, body);
  }

  upsertRunProject(runId: string, projectId: number, body: unknown): Promise<unknown> {
    return this.upsertRunProjectWithLease(runId, projectId, body);
  }

  createAiInteraction(runId: string, body: unknown): Promise<unknown> {
    return this.createAiInteractionWithLease(runId, body);
  }

  upsertTraceEvent(runId: string, body: unknown): Promise<unknown> {
    return this.upsertTraceEventWithLease(runId, body);
  }

  private async loadJob(jobId: number, includeDeleted: boolean) {
    let query = this.database.db
      .selectFrom("automation_jobs")
      .selectAll()
      .where("id", "=", jobId);
    if (!includeDeleted) query = query.where("deleted_at", "is", null);
    const job = await query.executeTakeFirst();
    if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
    return job;
  }

  private async getJobWithExecutor(
    executor: DbExecutor,
    jobId: number,
    includeDeleted: boolean,
  ): Promise<unknown> {
    let query = executor.selectFrom("automation_jobs").selectAll().where("id", "=", jobId);
    if (!includeDeleted) query = query.where("deleted_at", "is", null);
    const job = await query.executeTakeFirst();
    if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
    const tags = await this.tagsByJobIds([jobId], executor);
    const recent = await executor
      .selectFrom("automation_job_runs")
      .select(["id", "status", "scheduled_at", "error_code", "error_summary"])
      .where("job_id", "=", jobId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return {
      ...serializeJob(job, tags.get(jobId) ?? [], true),
      recent_run: recent
        ? { ...recent, scheduled_at: formatUtc(recent.scheduled_at) }
        : null,
    };
  }

  private async setJobValidation(
    jobId: number,
    valid: boolean,
    catalogVersion: string | null,
    error: string | null,
    userId: number,
  ): Promise<unknown> {
    return this.database.db.transaction().execute(async (tx) => {
      const job = await tx
        .selectFrom("automation_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!job) throw notFound("automation_job_not_found", "自动化任务不存在");
      const now = new Date();
      await tx
        .updateTable("automation_jobs")
        .set({
          configuration_status: valid ? "valid" : "invalid",
          configuration_error: error,
          model_catalog_version: catalogVersion,
          next_run_at:
            valid && job.enabled
              ? calculateNextRunAt(job.cron_expression, job.timezone, now)
              : null,
          updated_by: userId,
          updated_at: now,
        })
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("automation_job_change_logs")
        .values({
          job_id: jobId,
          action: valid ? "validated" : "validation_failed",
          version_before: job.version,
          version_after: job.version,
          changes_json: JSON.stringify({
            configuration_status: valid ? "valid" : "invalid",
          }),
          operated_by: userId,
          created_at: now,
        })
        .execute();
      return this.getJobWithExecutor(tx, jobId, false);
    });
  }

  private async tagsByJobIds(
    jobIds: number[],
    executor: DbExecutor = this.database.db,
  ): Promise<Map<number, TagRow[]>> {
    const result = new Map<number, TagRow[]>();
    if (!jobIds.length) return result;
    const rows = await executor
      .selectFrom("automation_job_tags as jt")
      .innerJoin("automation_tags as tag", "tag.id", "jt.tag_id")
      .selectAll("tag")
      .select("jt.job_id")
      .where("jt.job_id", "in", jobIds)
      .orderBy("tag.name", "asc")
      .execute();
    for (const row of rows) {
      const list = result.get(row.job_id) ?? [];
      list.push(row);
      result.set(row.job_id, list);
    }
    return result;
  }

  private async resolveTags(executor: DbExecutor, tagIds: number[]): Promise<void> {
    if (!tagIds.length) return;
    const rows = await executor
      .selectFrom("automation_tags")
      .select("id")
      .where("id", "in", tagIds)
      .where("enabled", "=", 1)
      .execute();
    if (rows.length !== tagIds.length) {
      throw new AutomationHttpError(422, "invalid_tag", "标签不存在或已停用");
    }
  }

  private validateModel(provider: string, modelId: string): void {
    try {
      resolveAutomationModelSelection(
        { modelProvider: provider, modelId, modelParameters: {} },
        { modelProvider: this.config.modelProvider, modelId: this.config.model },
      );
    } catch {
      throw new AutomationHttpError(422, "invalid_model", "模型不存在或已停用");
    }
  }

  private ensureSupportedJobType(jobType: string, code: string): void {
    if (jobType !== "github_project_progress_sync") {
      throw notFound(code, "自动任务内容配置不存在");
    }
  }

  private enforceManualRateLimit(
    userId: number,
    jobId: number,
    projectId: number | null,
  ): void {
    const now = Date.now();
    const threshold = now - this.config.manualTriggerWindowSeconds * 1000;
    const key = `${userId}:${jobId}:${projectId ?? "all"}`;
    const recent = (this.manualTriggerAttempts.get(key) ?? []).filter(
      (timestamp) => timestamp > threshold,
    );
    if (recent.length >= this.config.manualTriggerLimit) {
      throw new AutomationHttpError(429, "rate_limit_exceeded", "手动触发过于频繁");
    }
    recent.push(now);
    this.manualTriggerAttempts.set(key, recent);
  }

  private async insertRootRun(
    executor: DbExecutor,
    job: JobRow,
    triggerSource: "manual" | "schedule" | "catch_up",
    scheduledAt: Date,
    availableAt: Date,
    triggeredAt: Date,
    terminal?: { status: "skipped" | "configuration_error"; code: string; summary: string },
    executionParameters: Record<string, unknown> = {},
  ): Promise<string> {
    const tags = await this.tagsByJobIds([job.id], executor);
    const profile = await executor
      .selectFrom("automation_prompt_profiles")
      .selectAll()
      .where("job_type", "=", job.job_type)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    const id = randomUUID();
    const finishedAt = terminal ? triggeredAt : null;
    await executor
      .insertInto("automation_job_runs")
      .values({
        id,
        root_run_id: id,
        parent_run_id: null,
        job_id: job.id,
        job_key_snapshot: job.job_key,
        job_name_snapshot: job.name,
        job_type_snapshot: job.job_type,
        description_snapshot: job.description,
        tags_snapshot: JSON.stringify(
          (tags.get(job.id) ?? []).map((tag) => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
          })),
        ),
        trigger_source: triggerSource,
        scheduled_at: scheduledAt,
        available_at: availableAt,
        triggered_at: triggeredAt,
        started_at: null,
        finished_at: finishedAt,
        status: terminal?.status ?? "pending",
        attempt: 1,
        model_provider_snapshot: job.model_provider,
        model_id_snapshot: job.model_id,
        model_parameters_snapshot: JSON.stringify(parseJson(job.model_parameters, {})),
        execution_parameters_snapshot: JSON.stringify(executionParameters),
        model_catalog_version_snapshot: job.model_catalog_version,
        prompt_version_snapshot: profile?.prompt_version ?? null,
        system_prompt_snapshot: profile?.system_prompt ?? null,
        cron_expression_snapshot: job.cron_expression,
        timezone_snapshot: job.timezone,
        retry_max_attempts_snapshot: job.retry_max_attempts,
        retry_interval_seconds_snapshot: job.retry_interval_seconds,
        timeout_seconds_snapshot: job.timeout_seconds,
        deadline_at: new Date(availableAt.getTime() + job.timeout_seconds * 1000),
        worker_instance: null,
        lease_token_digest: null,
        lease_duration_seconds: null,
        lease_expires_at: null,
        heartbeat_at: null,
        projects_total: 0,
        projects_succeeded: 0,
        projects_failed: 0,
        mutations_applied: 0,
        retry_recommended: 0,
        duration_ms: terminal ? 0 : null,
        error_code: terminal?.code ?? null,
        error_summary: sanitizeErrorSummary(terminal?.summary),
        cancel_requested_at: null,
        cancel_requested_by: null,
        created_at: triggeredAt,
        updated_at: triggeredAt,
      })
      .execute();
    return id;
  }

  private async claimRunWithLease(body: unknown): Promise<unknown> {
    const input = automationClaimSchema.parse(body);
    const connection = await this.database.pool.promise().getConnection();
    let claimLockName: string | null = null;
    try {
      await connection.beginTransaction();
      await this.expireDeadlines(connection, new Date());
      await connection.commit();
      for (let scan = 0; scan < 20; scan += 1) {
        const now = new Date();
        await connection.beginTransaction();
        let candidateJobId = await selectJobForClaim(
          connection,
          `candidate.status IN ('claimed', 'running')
           AND candidate.lease_expires_at IS NOT NULL
           AND candidate.lease_expires_at <= ?
           AND candidate.deadline_at > ?
           AND candidate.job_type_snapshot IN (?)`,
          [now, now, input.supported_job_types],
          "candidate.lease_expires_at ASC",
          now,
        );
        if (candidateJobId === null) {
          candidateJobId = await selectJobForClaim(
            connection,
            `candidate.status = 'pending'
             AND candidate.available_at <= ?
             AND candidate.deadline_at > ?
             AND candidate.job_type_snapshot IN (?)`,
            [now, now, input.supported_job_types],
            "candidate.available_at ASC, candidate.created_at ASC",
            now,
          );
        }
        if (candidateJobId === null) {
          await connection.commit();
          return null;
        }
        await connection.commit();
        claimLockName = `automation-claim-job-${candidateJobId}`;
        if (!(await acquireNamedLock(connection, claimLockName))) {
          claimLockName = null;
          return null;
        }
        await connection.beginTransaction();
        let run = await selectRunForClaim(
          connection,
          `candidate.job_id = ?
           AND candidate.status IN ('claimed', 'running')
           AND candidate.lease_expires_at IS NOT NULL
           AND candidate.lease_expires_at <= ?
           AND candidate.deadline_at > ?
           AND candidate.job_type_snapshot IN (?)`,
          [candidateJobId, now, now, input.supported_job_types],
          "candidate.lease_expires_at ASC",
          now,
        );
        if (!run) {
          run = await selectRunForClaim(
            connection,
            `candidate.job_id = ?
             AND candidate.status = 'pending'
             AND candidate.available_at <= ?
             AND candidate.deadline_at > ?
             AND candidate.job_type_snapshot IN (?)`,
            [candidateJobId, now, now, input.supported_job_types],
            "candidate.available_at ASC, candidate.created_at ASC",
            now,
          );
        }
        if (!run) {
          await connection.commit();
          await releaseNamedLock(connection, claimLockName);
          claimLockName = null;
          continue;
        }
        const rawToken = randomBytes(32).toString("base64url");
        const leaseExpiresAt = new Date(
          Math.min(
            now.getTime() + input.lease_seconds * 1000,
            asDate(run.deadline_at).getTime(),
          ),
        );
        await connection.execute<ResultSetHeader>(
          `UPDATE automation_job_runs
              SET status = 'claimed', worker_instance = ?, lease_token_digest = ?,
                  lease_duration_seconds = ?, lease_expires_at = ?, heartbeat_at = ?,
                  updated_at = ?
            WHERE id = ?`,
          [
            input.worker_instance,
            digestLeaseToken(rawToken),
            input.lease_seconds,
            leaseExpiresAt,
            now,
            now,
            run.id,
          ],
        );
        await connection.commit();
        await releaseNamedLock(connection, claimLockName);
        claimLockName = null;
        return claimResponse(
          {
            ...run,
            status: "claimed",
            worker_instance: input.worker_instance,
            lease_duration_seconds: input.lease_seconds,
            lease_expires_at: leaseExpiresAt,
            heartbeat_at: now,
          },
          rawToken,
        );
      }
      return null;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      if (claimLockName) {
        await releaseNamedLock(connection, claimLockName);
      }
      connection.release();
    }
  }

  private async heartbeatRunWithLease(runId: string, body: unknown): Promise<unknown> {
    const input = automationHeartbeatSchema.parse(body);
    return this.withWorkerTransaction(async (connection, now) => {
      const run = await loadWorkerRun(connection, runId, input, now);
      const duration = input.lease_seconds ?? run.lease_duration_seconds ?? 300;
      const leaseExpiresAt = new Date(
        Math.min(now.getTime() + duration * 1000, asDate(run.deadline_at).getTime()),
      );
      await connection.execute<ResultSetHeader>(
        `UPDATE automation_job_runs
            SET lease_duration_seconds = ?, heartbeat_at = ?, lease_expires_at = ?,
                updated_at = ?
          WHERE id = ?`,
        [duration, now, leaseExpiresAt, now, runId],
      );
      return {
        run_id: runId,
        status: run.status,
        heartbeat_at: formatUtc(now),
        lease_expires_at: formatUtc(leaseExpiresAt),
        cancel_requested: run.cancel_requested_at !== null,
      };
    });
  }

  private async updateRunWithLease(runId: string, body: unknown): Promise<unknown> {
    const input = automationRunPatchSchema.parse(body);
    return this.withWorkerTransaction(async (connection, now) => {
      const run = await loadWorkerRun(connection, runId, input, now, input.status);
      const cleanSummary = sanitizeErrorSummary(input.error_summary);
      if (run.status === input.status && TERMINAL_RUN_STATUSES.has(run.status)) {
        if (
          run.error_code !== (input.error_code ?? null) ||
          run.error_summary !== cleanSummary ||
          Boolean(run.retry_recommended) !== input.retry_recommended ||
          (input.mutations_applied !== undefined &&
            Boolean(run.mutations_applied) !== input.mutations_applied)
        ) {
          throw conflict("invalid_run_transition", "终态运行记录不可修改");
        }
        const [retryRows] = await connection.query<RowDataPacket[]>(
          `SELECT id FROM automation_job_runs
            WHERE root_run_id = ? AND attempt = ? LIMIT 1`,
          [run.root_run_id, run.attempt + 1],
        );
        return { run: serializeRun(run, false), retry_run_id: retryRows[0]?.id ?? null };
      }

      try {
        ensureRunTransition(run.status, input.status);
      } catch {
        throw conflict("invalid_run_transition", "运行状态不允许更新");
      }
      const terminal = TERMINAL_RUN_STATUSES.has(input.status);
      const startedAt = input.status === "running" ? run.started_at ?? now : run.started_at;
      const finishedAt = terminal ? now : run.finished_at;
      let projectsTotal = run.projects_total;
      let projectsSucceeded = run.projects_succeeded;
      let projectsFailed = run.projects_failed;
      if (terminal) {
        const [counterRows] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS total,
                  SUM(outcome IN ('evaluated','archived','no_github_urls','no_commits')) AS succeeded
             FROM automation_job_run_projects
            WHERE run_id = ?`,
          [runId],
        );
        projectsTotal = Number(counterRows[0]?.total ?? 0);
        projectsSucceeded = Number(counterRows[0]?.succeeded ?? 0);
        projectsFailed = projectsTotal - projectsSucceeded;
      }
      const durationMs = terminal
        ? Math.max(0, now.getTime() - asDate(startedAt ?? run.triggered_at).getTime())
        : run.duration_ms;
      await connection.execute<ResultSetHeader>(
        `UPDATE automation_job_runs
            SET status = ?, started_at = ?, finished_at = ?, updated_at = ?,
                error_code = ?, error_summary = ?, retry_recommended = ?,
                mutations_applied = COALESCE(?, mutations_applied), duration_ms = ?,
                projects_total = ?, projects_succeeded = ?, projects_failed = ?,
                lease_expires_at = IF(?, NULL, lease_expires_at)
          WHERE id = ?`,
        [
          input.status,
          startedAt,
          finishedAt,
          now,
          input.error_code ?? null,
          cleanSummary,
          input.retry_recommended ? 1 : 0,
          input.mutations_applied === undefined ? null : input.mutations_applied ? 1 : 0,
          durationMs,
          projectsTotal,
          projectsSucceeded,
          projectsFailed,
          terminal,
          runId,
        ],
      );
      if (input.status === "running") {
        await connection.execute<ResultSetHeader>(
          `UPDATE automation_jobs
              SET last_started_at = ?, last_run_status = 'running', updated_at = ?
            WHERE id = ?`,
          [startedAt, now, run.job_id],
        );
      } else if (terminal) {
        await connection.execute<ResultSetHeader>(
          `UPDATE automation_jobs
              SET last_finished_at = ?, last_run_status = ?, updated_at = ?,
                  configuration_status = IF(? = 'configuration_error', 'invalid', configuration_status),
                  configuration_error = IF(? = 'configuration_error', COALESCE(?, 'model_configuration_invalid'), configuration_error),
                  next_run_at = IF(? = 'configuration_error', NULL, next_run_at)
            WHERE id = ?`,
          [
            now,
            input.status,
            now,
            input.status,
            input.status,
            input.error_code ?? null,
            input.status,
            run.job_id,
          ],
        );
      }
      let retryRunId: string | null = null;
      if (
        terminal &&
        ["failed", "partial_failed"].includes(input.status) &&
        input.retry_recommended &&
        run.attempt < run.retry_max_attempts_snapshot
      ) {
        const [retryRows] = await connection.query<RowDataPacket[]>(
          `SELECT id FROM automation_job_runs
            WHERE root_run_id = ? AND attempt = ? LIMIT 1`,
          [run.root_run_id, run.attempt + 1],
        );
        retryRunId = retryRows[0]?.id ? String(retryRows[0].id) : null;
        if (!retryRunId) {
          retryRunId = randomUUID();
          const availableAt = new Date(
            now.getTime() + run.retry_interval_seconds_snapshot * 1000,
          );
          await connection.execute<ResultSetHeader>(
            `INSERT INTO automation_job_runs (
               id, root_run_id, parent_run_id, job_id, job_key_snapshot,
               job_name_snapshot, job_type_snapshot, description_snapshot,
               tags_snapshot, trigger_source, scheduled_at, available_at,
               triggered_at, status, attempt, model_provider_snapshot,
               model_id_snapshot, model_parameters_snapshot, execution_parameters_snapshot,
               model_catalog_version_snapshot, prompt_version_snapshot,
               system_prompt_snapshot, cron_expression_snapshot, timezone_snapshot,
               retry_max_attempts_snapshot, retry_interval_seconds_snapshot,
               timeout_seconds_snapshot, deadline_at, projects_total,
               projects_succeeded, projects_failed, mutations_applied,
               retry_recommended, created_at, updated_at
             ) SELECT ?, root_run_id, id, job_id, job_key_snapshot,
                      job_name_snapshot, job_type_snapshot, description_snapshot,
                      tags_snapshot, 'retry', scheduled_at, ?, ?, 'pending', attempt + 1,
                      model_provider_snapshot, model_id_snapshot, model_parameters_snapshot,
                      execution_parameters_snapshot,
                      model_catalog_version_snapshot, prompt_version_snapshot,
                      system_prompt_snapshot, cron_expression_snapshot, timezone_snapshot,
                      retry_max_attempts_snapshot, retry_interval_seconds_snapshot,
                      timeout_seconds_snapshot, ?, 0, 0, 0, 0, 0, ?, ?
                 FROM automation_job_runs WHERE id = ?`,
            [
              retryRunId,
              availableAt,
              now,
              new Date(availableAt.getTime() + run.timeout_seconds_snapshot * 1000),
              now,
              now,
              runId,
            ],
          );
        }
      }
      const updated: RunRow = {
        ...run,
        status: input.status,
        started_at: startedAt,
        finished_at: finishedAt,
        updated_at: now,
        error_code: input.error_code ?? null,
        error_summary: cleanSummary,
        retry_recommended: input.retry_recommended ? 1 : 0,
        mutations_applied:
          input.mutations_applied === undefined
            ? run.mutations_applied
            : input.mutations_applied
              ? 1
              : 0,
        duration_ms: durationMs,
        projects_total: projectsTotal,
        projects_succeeded: projectsSucceeded,
        projects_failed: projectsFailed,
        lease_token_digest: terminal ? null : run.lease_token_digest,
        lease_expires_at: terminal ? null : run.lease_expires_at,
      };
      return { run: serializeRun(updated, false), retry_run_id: retryRunId };
    });
  }

  private async upsertRunProjectWithLease(
    runId: string,
    projectId: number,
    body: unknown,
  ): Promise<unknown> {
    const input = automationRunProjectUpsertSchema.parse(body);
    return this.withWorkerTransaction(async (connection, now) => {
      await loadWorkerRun(connection, runId, input, now);
      const warnings = redactSensitiveData(input.warnings);
      await connection.execute<ResultSetHeader>(
        `INSERT INTO automation_job_run_projects (
           run_id, project_id, project_name_snapshot, status_before, status_after,
           outcome, repository_count, commit_count, summary_date, source_digest,
           generated_summary, ai_confidence, ai_note, warnings, mutations_applied,
           started_at, finished_at, duration_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           project_name_snapshot = VALUES(project_name_snapshot),
           status_before = VALUES(status_before), status_after = VALUES(status_after),
           outcome = VALUES(outcome), repository_count = VALUES(repository_count),
           commit_count = VALUES(commit_count), summary_date = VALUES(summary_date),
           source_digest = VALUES(source_digest), generated_summary = VALUES(generated_summary),
           ai_confidence = VALUES(ai_confidence), ai_note = VALUES(ai_note),
           warnings = VALUES(warnings), mutations_applied = VALUES(mutations_applied),
           started_at = VALUES(started_at), finished_at = VALUES(finished_at),
           duration_ms = VALUES(duration_ms), updated_at = VALUES(updated_at)`,
        [
          runId,
          projectId,
          input.project_name_snapshot,
          input.status_before ?? null,
          input.status_after ?? null,
          input.outcome,
          input.repository_count,
          input.commit_count,
          input.summary_date ?? null,
          input.source_digest ?? null,
          input.generated_summary ?? null,
          input.ai_confidence ?? null,
          input.ai_note ?? null,
          JSON.stringify(warnings),
          input.mutations_applied ? 1 : 0,
          input.started_at ? new Date(input.started_at) : null,
          input.finished_at ? new Date(input.finished_at) : null,
          input.duration_ms ?? null,
          now,
          now,
        ],
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM automation_job_run_projects
          WHERE run_id = ? AND project_id = ?`,
        [runId, projectId],
      );
      return { run_project_id: Number(rows[0]?.id), project_id: projectId };
    });
  }

  private async createAiInteractionWithLease(
    runId: string,
    body: unknown,
  ): Promise<unknown> {
    const input = automationAiInteractionCreateSchema.parse(body);
    return this.withWorkerTransaction(async (connection, now) => {
      const run = await loadWorkerRun(connection, runId, input, now);
      if (
        run.prompt_version_snapshot !== null &&
        (input.prompt_version !== run.prompt_version_snapshot ||
          input.system_prompt_snapshot !== run.system_prompt_snapshot)
      ) {
        throw new AutomationHttpError(
          422,
          "automation_prompt_snapshot_mismatch",
          "AI 审计提示词快照与运行不一致",
        );
      }
      const [projectRows] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM automation_job_run_projects
          WHERE id = ? AND run_id = ? LIMIT 1`,
        [input.run_project_id, runId],
      );
      if (!projectRows.length) {
        throw new AutomationHttpError(422, "run_project_not_found", "项目执行记录不存在");
      }
      await connection.execute<ResultSetHeader>(
        `INSERT INTO automation_ai_interactions (
           run_id, run_project_id, interaction_key, provider, model,
           model_catalog_version, prompt_version, system_prompt_snapshot,
           request_payload_sanitized, response_payload_sanitized, final_summary,
           limitations, fallback_used, upstream_request_id, input_tokens,
           output_tokens, latency_ms, status, error_code, error_summary,
           purged_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE
           run_project_id = VALUES(run_project_id), provider = VALUES(provider),
           model = VALUES(model), model_catalog_version = VALUES(model_catalog_version),
           prompt_version = VALUES(prompt_version),
           system_prompt_snapshot = VALUES(system_prompt_snapshot),
           request_payload_sanitized = VALUES(request_payload_sanitized),
           response_payload_sanitized = VALUES(response_payload_sanitized),
           final_summary = VALUES(final_summary), limitations = VALUES(limitations),
           fallback_used = VALUES(fallback_used),
           upstream_request_id = VALUES(upstream_request_id),
           input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
           latency_ms = VALUES(latency_ms), status = VALUES(status),
           error_code = VALUES(error_code), error_summary = VALUES(error_summary)`,
        [
          runId,
          input.run_project_id,
          input.interaction_key,
          input.provider,
          input.model,
          input.model_catalog_version ?? null,
          input.prompt_version ?? null,
          input.system_prompt_snapshot ?? null,
          jsonOrNull(redactSensitiveData(input.request_payload_sanitized)),
          jsonOrNull(redactSensitiveData(input.response_payload_sanitized)),
          input.final_summary ?? null,
          JSON.stringify(redactSensitiveData(input.limitations)),
          input.fallback_used ? 1 : 0,
          input.upstream_request_id ?? null,
          input.input_tokens ?? null,
          input.output_tokens ?? null,
          input.latency_ms ?? null,
          input.status,
          input.error_code ?? null,
          sanitizeErrorSummary(input.error_summary),
          now,
        ],
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM automation_ai_interactions
          WHERE run_id = ? AND interaction_key = ?`,
        [runId, input.interaction_key],
      );
      return {
        interaction_id: Number(rows[0]?.id),
        interaction_key: input.interaction_key,
      };
    });
  }

  private async upsertTraceEventWithLease(
    runId: string,
    body: unknown,
  ): Promise<unknown> {
    const input = automationTraceEventUpsertSchema.parse(body);
    return this.withWorkerTransaction(async (connection, now) => {
      await loadWorkerRun(connection, runId, input, now);
      const [existingRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM automation_run_trace_events
          WHERE run_id = ? AND event_key = ? FOR UPDATE`,
        [runId, input.event_key],
      );
      const existing = existingRows[0];
      if (
        existing &&
        TERMINAL_TRACE_STATUSES.has(String(existing.status)) &&
        ["pending", "running"].includes(input.status)
      ) {
        throw conflict("automation_trace_invalid", "Trace 终态不允许回退");
      }
      let occurredAt = new Date(input.occurred_at);
      const metadata = redactSensitiveData(input.metadata_sanitized) as Record<string, unknown>;
      if (Math.abs(occurredAt.getTime() - now.getTime()) > 5 * 60 * 1000) {
        occurredAt = now;
        metadata.occurred_at_corrected = true;
      }
      const startedAt = input.status === "running"
        ? existing?.started_at ?? now
        : existing?.started_at ?? null;
      const finishedAt = TERMINAL_TRACE_STATUSES.has(input.status)
        ? existing?.finished_at ?? now
        : existing?.finished_at ?? null;
      await connection.execute<ResultSetHeader>(
        `INSERT INTO automation_run_trace_events (
           run_id, event_key, sequence, phase, status, title, message,
           progress_current, progress_total, project_id, repository_full_name,
           metadata_sanitized, started_at, finished_at, occurred_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           sequence = VALUES(sequence), phase = VALUES(phase), status = VALUES(status),
           title = VALUES(title), message = VALUES(message),
           progress_current = VALUES(progress_current),
           progress_total = VALUES(progress_total), project_id = VALUES(project_id),
           repository_full_name = VALUES(repository_full_name),
           metadata_sanitized = VALUES(metadata_sanitized),
           started_at = VALUES(started_at), finished_at = VALUES(finished_at),
           occurred_at = VALUES(occurred_at), updated_at = VALUES(updated_at)`,
        [
          runId,
          input.event_key,
          input.sequence,
          input.phase,
          input.status,
          input.title,
          input.message ?? null,
          input.progress_current ?? null,
          input.progress_total ?? null,
          input.project_id ?? null,
          input.repository_full_name ?? null,
          JSON.stringify(metadata),
          startedAt,
          finishedAt,
          occurredAt,
          existing?.created_at ?? now,
          now,
        ],
      );
      const [rows] = await connection.query<(RowDataPacket & TraceEventRow)[]>(
        `SELECT * FROM automation_run_trace_events
          WHERE run_id = ? AND event_key = ?`,
        [runId, input.event_key],
      );
      return serializeTraceEvent(rows[0] as TraceEventRow);
    });
  }

  private async withWorkerTransaction<T>(
    operation: (connection: PoolConnection, now: Date) => Promise<T>,
  ): Promise<T> {
    const connection = await this.database.pool.promise().getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection, new Date());
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async expireDeadlines(connection: PoolConnection, now: Date): Promise<void> {
    const [rows] = await connection.query<(RowDataPacket & RunRow)[]>(
      `SELECT * FROM automation_job_runs
        WHERE status IN ('pending','claimed','running') AND deadline_at <= ?
        ORDER BY deadline_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [now],
    );
    for (const row of rows) {
      const run = row as RunRow;
      const duration = Math.max(
        0,
        now.getTime() - asDate(run.started_at ?? run.triggered_at).getTime(),
      );
      await connection.execute<ResultSetHeader>(
        `UPDATE automation_job_runs
            SET status = 'failed', finished_at = ?, duration_ms = ?,
                error_code = 'job_timeout', error_summary = '任务执行超时',
                retry_recommended = 0, lease_token_digest = NULL,
                lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
        [now, duration, now, run.id],
      );
      await connection.execute<ResultSetHeader>(
        `UPDATE automation_jobs
            SET last_finished_at = ?, last_run_status = 'failed', updated_at = ?
          WHERE id = ?`,
        [now, now, run.job_id],
      );
    }
  }

  private async reconcileModelCatalog(): Promise<number> {
    const jobs = await this.database.db
      .selectFrom("automation_jobs")
      .select(["id", "model_provider", "model_id", "configuration_status", "next_run_at"])
      .where("deleted_at", "is", null)
      .execute();
    let changed = 0;
    for (const job of jobs) {
      try {
        this.validateModel(job.model_provider, job.model_id);
      } catch {
        if (job.configuration_status === "invalid" && job.next_run_at === null) {
          continue;
        }
        await this.database.db
          .updateTable("automation_jobs")
          .set({
            configuration_status: "invalid",
            configuration_error: "model_configuration_invalid",
            next_run_at: null,
            updated_at: new Date(),
          })
          .where("id", "=", job.id)
          .execute();
        changed += 1;
      }
    }
    return changed;
  }

  private async purgeAuditData(): Promise<{
    aiInteractionsPurged: number;
    traceEventsPurged: number;
  }> {
    const connection = await this.database.pool.promise().getConnection();
    try {
      const now = new Date();
      const [aiResult] = await connection.execute<ResultSetHeader>(
        `UPDATE automation_ai_interactions AS ai
          JOIN (
            SELECT ai_candidate.id
              FROM automation_ai_interactions AS ai_candidate
              JOIN automation_job_runs AS run ON run.id = ai_candidate.run_id
              JOIN automation_jobs AS job ON job.id = run.job_id
             WHERE ai_candidate.purged_at IS NULL
               AND run.status NOT IN ('pending','claimed','running')
               AND run.finished_at IS NOT NULL
               AND run.finished_at <= DATE_SUB(?, INTERVAL job.retention_days DAY)
             ORDER BY ai_candidate.created_at ASC
             LIMIT 500
          ) AS eligible ON eligible.id = ai.id
           SET ai.system_prompt_snapshot = NULL,
               ai.request_payload_sanitized = NULL,
               ai.response_payload_sanitized = NULL,
               ai.purged_at = ?
         WHERE ai.purged_at IS NULL`,
        [now, now],
      );
      const [traceResult] = await connection.execute<ResultSetHeader>(
        `DELETE trace FROM automation_run_trace_events AS trace
          JOIN (
            SELECT trace_candidate.id
              FROM automation_run_trace_events AS trace_candidate
              JOIN automation_job_runs AS run ON run.id = trace_candidate.run_id
              JOIN automation_jobs AS job ON job.id = run.job_id
             WHERE run.status NOT IN ('pending','claimed','running')
               AND run.finished_at IS NOT NULL
               AND run.finished_at <= DATE_SUB(?, INTERVAL job.retention_days DAY)
             ORDER BY trace_candidate.id ASC
             LIMIT 1000
          ) AS eligible ON eligible.id = trace.id`,
        [now],
      );
      return {
        aiInteractionsPurged: aiResult.affectedRows,
        traceEventsPurged: traceResult.affectedRows,
      };
    } finally {
      connection.release();
    }
  }
}

async function selectRunForClaim(
  connection: PoolConnection,
  whereClause: string,
  parameters: unknown[],
  orderBy: string,
  now: Date,
): Promise<RunRow | null> {
  const [rows] = await connection.query<(RowDataPacket & RunRow)[]>(
    `SELECT candidate.* FROM automation_job_runs AS candidate
      WHERE ${whereClause}
        AND NOT EXISTS (
          SELECT 1
            FROM automation_job_runs AS active
           WHERE active.job_id = candidate.job_id
             AND active.id <> candidate.id
             AND active.status IN ('claimed', 'running')
             AND active.lease_expires_at IS NOT NULL
             AND active.lease_expires_at > ?
             AND active.deadline_at > ?
             AND (
               JSON_EXTRACT(candidate.execution_parameters_snapshot, '$.project_id') IS NULL
               OR JSON_EXTRACT(active.execution_parameters_snapshot, '$.project_id') IS NULL
               OR JSON_EXTRACT(active.execution_parameters_snapshot, '$.project_id') =
                  JSON_EXTRACT(candidate.execution_parameters_snapshot, '$.project_id')
             )
        )
      ORDER BY ${orderBy}
      LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [...parameters, now, now],
  );
  return (rows[0] as RunRow | undefined) ?? null;
}

async function acquireNamedLock(
  connection: PoolConnection,
  lockName: string,
): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT GET_LOCK(?, 5) AS acquired",
    [lockName],
  );
  return Number(rows[0]?.acquired) === 1;
}

async function releaseNamedLock(
  connection: PoolConnection,
  lockName: string,
): Promise<void> {
  await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
}

async function selectJobForClaim(
  connection: PoolConnection,
  whereClause: string,
  parameters: unknown[],
  orderBy: string,
  now: Date,
): Promise<number | null> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT candidate.job_id
       FROM automation_job_runs AS candidate
      WHERE ${whereClause}
        AND NOT EXISTS (
          SELECT 1
            FROM automation_job_runs AS active
           WHERE active.job_id = candidate.job_id
             AND active.id <> candidate.id
             AND active.status IN ('claimed', 'running')
             AND active.lease_expires_at IS NOT NULL
             AND active.lease_expires_at > ?
             AND active.deadline_at > ?
             AND (
               JSON_EXTRACT(candidate.execution_parameters_snapshot, '$.project_id') IS NULL
               OR JSON_EXTRACT(active.execution_parameters_snapshot, '$.project_id') IS NULL
               OR JSON_EXTRACT(active.execution_parameters_snapshot, '$.project_id') =
                  JSON_EXTRACT(candidate.execution_parameters_snapshot, '$.project_id')
             )
        )
      ORDER BY ${orderBy}
      LIMIT 1`,
    [...parameters, now, now],
  );
  return rows[0]?.job_id === undefined ? null : Number(rows[0].job_id);
}

type ManualRunScope = {
  projectId: number | null;
  summaryScope: ProjectProgressSummaryScope;
};

function resolveRequestedRunScope(
  executionParameters: { project_id?: number; summary_scope?: ProjectProgressSummaryScope },
  modelParameters: Record<string, unknown>,
): ManualRunScope {
  const modelScope = modelParameters.summary_scope;
  return {
    projectId: executionParameters.project_id ?? null,
    summaryScope:
      executionParameters.summary_scope ??
      (modelScope === "latest_commit_of_updating_projects"
        ? modelScope
        : "today"),
  };
}

function runScope(run: {
  model_parameters_snapshot: unknown;
  execution_parameters_snapshot: unknown;
}): ManualRunScope {
  return resolveRequestedRunScope(
    parseJson(run.execution_parameters_snapshot, {}),
    parseJson(run.model_parameters_snapshot, {}),
  );
}

function isSameManualRunScope(
  requested: ManualRunScope,
  active: {
    scheduled_at: Date;
    timezone_snapshot: string;
    model_parameters_snapshot: unknown;
    execution_parameters_snapshot: unknown;
  },
  now: Date,
  requestedTimezone: string,
): boolean {
  const existing = runScope(active);
  if (
    requested.projectId !== existing.projectId ||
    requested.summaryScope !== existing.summaryScope
  ) {
    return false;
  }
  if (requested.summaryScope !== "today") return true;
  return (
    formatDateInTimeZone(asDate(active.scheduled_at), active.timezone_snapshot) ===
    formatDateInTimeZone(now, requestedTimezone)
  );
}

async function nextManualScheduledAt(
  executor: DbExecutor,
  jobId: number,
  now: Date,
): Promise<Date> {
  let scheduledAt = now;
  for (;;) {
    const collision = await executor
      .selectFrom("automation_job_runs")
      .select("id")
      .where("job_id", "=", jobId)
      .where("scheduled_at", "=", scheduledAt)
      .where("attempt", "=", 1)
      .executeTakeFirst();
    if (!collision) return scheduledAt;
    scheduledAt = new Date(scheduledAt.getTime() + 1);
  }
}

async function loadWorkerRun(
  connection: PoolConnection,
  runId: string,
  input: { worker_instance: string; lease_token: string },
  now: Date,
  replayStatus?: string,
): Promise<RunRow> {
  const [rows] = await connection.query<(RowDataPacket & RunRow)[]>(
    "SELECT * FROM automation_job_runs WHERE id = ? FOR UPDATE",
    [runId],
  );
  const run = rows[0] as RunRow | undefined;
  if (!run) throw notFound("automation_run_not_found", "运行记录不存在");
  if (
    run.worker_instance !== input.worker_instance ||
    !run.lease_token_digest ||
    !verifyLeaseToken(input.lease_token, run.lease_token_digest)
  ) {
    throw conflict("invalid_lease_token", "租约令牌无效");
  }
  if (replayStatus && run.status === replayStatus && TERMINAL_RUN_STATUSES.has(run.status)) {
    return run;
  }
  if (!["claimed", "running"].includes(run.status)) {
    throw conflict("invalid_run_transition", "运行状态不允许更新");
  }
  if (
    !run.lease_expires_at ||
    asDate(run.lease_expires_at).getTime() <= now.getTime() ||
    asDate(run.deadline_at).getTime() <= now.getTime()
  ) {
    throw conflict("lease_expired", "租约已过期");
  }
  return run;
}

function claimResponse(run: RunRow, rawLeaseToken: string): Record<string, unknown> {
  return {
    run_id: run.id,
    lease_token: rawLeaseToken,
    job_id: run.job_id,
    job_key: run.job_key_snapshot,
    job_type: run.job_type_snapshot,
    name: run.job_name_snapshot,
    description: run.description_snapshot,
    tags: parseJson(run.tags_snapshot, []),
    trigger_source: run.trigger_source,
    scheduled_at: formatUtc(asDate(run.scheduled_at)),
    timezone: run.timezone_snapshot,
    model_provider: run.model_provider_snapshot,
    model_id: run.model_id_snapshot,
    model_parameters: parseJson(run.model_parameters_snapshot, {}),
    execution_parameters: parseJson(run.execution_parameters_snapshot, {}),
    model_catalog_version: run.model_catalog_version_snapshot,
    prompt_profile:
      run.prompt_version_snapshot && run.system_prompt_snapshot
        ? {
            prompt_version: run.prompt_version_snapshot,
            system_prompt: run.system_prompt_snapshot,
            required_capabilities: [...REQUIRED_PROMPT_CAPABILITIES],
          }
        : null,
    retry_policy: {
      attempt: run.attempt,
      max_attempts: run.retry_max_attempts_snapshot,
      interval_seconds: run.retry_interval_seconds_snapshot,
    },
    timeout_seconds: run.timeout_seconds_snapshot,
    deadline_at: formatUtc(asDate(run.deadline_at)),
    lease_expires_at: run.lease_expires_at
      ? formatUtc(asDate(run.lease_expires_at))
      : null,
    cancel_requested: run.cancel_requested_at !== null,
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function serializeTag(
  tag: TagRow,
  jobCount?: number,
): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    description: tag.description,
    enabled: Boolean(tag.enabled),
    created_by: tag.created_by,
    updated_by: tag.updated_by,
    created_at: formatUtc(tag.created_at),
    updated_at: formatUtc(tag.updated_at),
    ...(jobCount === undefined ? {} : { job_count: jobCount }),
  };
}

function serializePromptProfile(
  profile: PromptProfileRow,
): Record<string, unknown> {
  return {
    id: profile.id,
    job_type: profile.job_type,
    system_prompt: profile.system_prompt,
    required_capabilities: [...REQUIRED_PROMPT_CAPABILITIES],
    prompt_version: profile.prompt_version,
    enabled: Boolean(profile.enabled),
    version: profile.version,
    created_by: profile.created_by,
    updated_by: profile.updated_by,
    created_at: formatUtc(profile.created_at),
    updated_at: formatUtc(profile.updated_at),
  };
}

function serializeJob(
  job: Selectable<AutomationDatabaseSchema["automation_jobs"]>,
  tags: TagRow[],
  includeConfiguration: boolean,
): Record<string, unknown> {
  const deleted = job.deleted_at !== null;
  return {
    id: job.id,
    job_key: job.job_key,
    job_type: job.job_type,
    name: job.name,
    display_name: deleted ? `${job.name}（已删除）` : job.name,
    deleted,
    deleted_at: formatUtc(job.deleted_at),
    deleted_by: job.deleted_by,
    description: job.description,
    tags: tags.map((tag) => serializeTag(tag)),
    enabled: Boolean(job.enabled),
    timezone: job.timezone,
    schedule_type: job.schedule_type,
    cron_expression: job.cron_expression,
    schedule_description: `${job.cron_expression} (${job.timezone})`,
    catch_up_policy: job.catch_up_policy,
    overlap_policy: job.overlap_policy,
    model_provider: job.model_provider,
    model_id: job.model_id,
    configuration_status: job.configuration_status,
    configuration_error: job.configuration_error,
    next_run_at: formatUtc(job.next_run_at),
    last_run_at: formatUtc(job.last_started_at ?? job.last_scheduled_at),
    last_run_status: job.last_run_status,
    version: job.version,
    created_by: job.created_by,
    updated_by: job.updated_by,
    created_at: formatUtc(job.created_at),
    updated_at: formatUtc(job.updated_at),
    ...(includeConfiguration
      ? {
          model_parameters: parseJson(job.model_parameters, {}),
          model_catalog_version: job.model_catalog_version,
          retry_max_attempts: job.retry_max_attempts,
          retry_interval_seconds: job.retry_interval_seconds,
          timeout_seconds: job.timeout_seconds,
          retention_days: job.retention_days,
          last_scheduled_at: formatUtc(job.last_scheduled_at),
          last_started_at: formatUtc(job.last_started_at),
          last_finished_at: formatUtc(job.last_finished_at),
        }
      : {}),
  };
}

function serializeRun(run: RunRow, jobDeleted: boolean): Record<string, unknown> {
  return {
    id: run.id,
    root_run_id: run.root_run_id,
    parent_run_id: run.parent_run_id,
    job_id: run.job_id,
    job_key: run.job_key_snapshot,
    job_name: run.job_name_snapshot,
    job_display_name: jobDeleted
      ? `${run.job_name_snapshot}（已删除）`
      : run.job_name_snapshot,
    job_deleted: jobDeleted,
    job_type: run.job_type_snapshot,
    description: run.description_snapshot,
    tags: parseJson(run.tags_snapshot, []),
    trigger_source: run.trigger_source,
    scheduled_at: formatUtc(run.scheduled_at),
    available_at: formatUtc(run.available_at),
    triggered_at: formatUtc(run.triggered_at),
    started_at: formatUtc(run.started_at),
    finished_at: formatUtc(run.finished_at),
    status: run.status,
    attempt: run.attempt,
    model_provider: run.model_provider_snapshot,
    model_id: run.model_id_snapshot,
    model_parameters: parseJson(run.model_parameters_snapshot, {}),
    execution_parameters: parseJson(run.execution_parameters_snapshot, {}),
    model_catalog_version: run.model_catalog_version_snapshot,
    cron_expression: run.cron_expression_snapshot,
    timezone: run.timezone_snapshot,
    retry_max_attempts: run.retry_max_attempts_snapshot,
    retry_interval_seconds: run.retry_interval_seconds_snapshot,
    timeout_seconds: run.timeout_seconds_snapshot,
    deadline_at: formatUtc(run.deadline_at),
    worker_instance: run.worker_instance,
    lease_expires_at: formatUtc(run.lease_expires_at),
    heartbeat_at: formatUtc(run.heartbeat_at),
    projects_total: run.projects_total,
    projects_succeeded: run.projects_succeeded,
    projects_failed: run.projects_failed,
    mutations_applied: Boolean(run.mutations_applied),
    retry_recommended: Boolean(run.retry_recommended),
    duration_ms: run.duration_ms,
    error_code: run.error_code,
    error_summary: run.error_summary,
    cancel_requested_at: formatUtc(run.cancel_requested_at),
    cancel_requested_by: run.cancel_requested_by,
    created_at: formatUtc(run.created_at),
    updated_at: formatUtc(run.updated_at),
  };
}

function serializeRunProject(
  row: RunProjectRow,
): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.run_id,
    project_id: row.project_id,
    project_name: row.project_name_snapshot,
    status_before: row.status_before,
    status_after: row.status_after,
    outcome: row.outcome,
    repository_count: row.repository_count,
    commit_count: row.commit_count,
    summary_date: row.summary_date instanceof Date
      ? row.summary_date.toISOString().slice(0, 10)
      : row.summary_date,
    source_digest: row.source_digest,
    generated_summary: row.generated_summary,
    ai_confidence: row.ai_confidence,
    ai_note: row.ai_note,
    warnings: parseJson(row.warnings, []),
    mutations_applied: Boolean(row.mutations_applied),
    started_at: formatUtc(row.started_at),
    finished_at: formatUtc(row.finished_at),
    duration_ms: row.duration_ms,
    created_at: formatUtc(row.created_at),
    updated_at: formatUtc(row.updated_at),
  };
}

function serializeAiInteraction(
  row: AiInteractionRow,
): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.run_id,
    run_project_id: row.run_project_id,
    interaction_key: row.interaction_key,
    provider: row.provider,
    model: row.model,
    model_catalog_version: row.model_catalog_version,
    prompt_version: row.prompt_version,
    fallback_used: Boolean(row.fallback_used),
    upstream_request_id: row.upstream_request_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    latency_ms: row.latency_ms,
    status: row.status,
    error_code: row.error_code,
    error_summary: row.error_summary,
    purged_at: formatUtc(row.purged_at),
    created_at: formatUtc(row.created_at),
    system_prompt_snapshot: row.system_prompt_snapshot,
    request_payload_sanitized: parseJson(row.request_payload_sanitized, null),
    response_payload_sanitized: parseJson(row.response_payload_sanitized, null),
    final_summary: row.final_summary,
    limitations: parseJson(row.limitations, []),
  };
}

function serializeTraceEvent(
  row: TraceEventRow,
): Record<string, unknown> {
  return {
    id: row.id,
    event_key: row.event_key,
    sequence: row.sequence,
    phase: row.phase,
    status: row.status,
    title: row.title,
    message: row.message,
    progress_current: row.progress_current,
    progress_total: row.progress_total,
    project_id: row.project_id,
    repository_full_name: row.repository_full_name,
    metadata_sanitized: parseJson(row.metadata_sanitized, {}),
    started_at: formatUtc(row.started_at),
    finished_at: formatUtc(row.finished_at),
    occurred_at: formatUtc(row.occurred_at),
    updated_at: formatUtc(row.updated_at),
  };
}

function formatUtc(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value ?? fallback) as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTagName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function promptVersionFor(systemPrompt: string): string {
  const normalized = systemPrompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function queryInteger(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = query.get(name);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AutomationHttpError(422, "invalid_request", `${name} 参数无效`);
  }
  return parsed;
}

function queryOptionalInteger(query: URLSearchParams, name: string): number | null {
  const value = query.get(name);
  return value === null || value === ""
    ? null
    : queryInteger(query, name, 1, 1, Number.MAX_SAFE_INTEGER);
}

function queryBoolean(query: URLSearchParams, name: string): boolean | null {
  const value = query.get(name);
  if (value === null || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AutomationHttpError(422, "invalid_request", `${name} 参数无效`);
}

function optionalQuery(query: URLSearchParams, name: string, maxLength: number): string | null {
  const value = query.get(name)?.trim();
  if (!value) return null;
  if (value.length > maxLength) {
    throw new AutomationHttpError(422, "invalid_request", `${name} 参数过长`);
  }
  return value;
}

function queryDate(query: URLSearchParams, name: string): Date | null {
  const value = query.get(name);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AutomationHttpError(422, "invalid_request", `${name} 参数无效`);
  }
  return date;
}

function jobSortColumn(
  name: string,
): "job.created_at" | "job.name" | "job.next_run_at" | "job.updated_at" {
  if (name === "name") return "job.name";
  if (name === "next_run_at") return "job.next_run_at";
  if (name === "updated_at") return "job.updated_at";
  return "job.created_at";
}

function runSortColumn(
  name: string,
): "run.scheduled_at" | "run.started_at" | "run.created_at" {
  if (name === "started_at") return "run.started_at";
  if (name === "created_at") return "run.created_at";
  return "run.scheduled_at";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function notFound(code: string, message: string): AutomationHttpError {
  return new AutomationHttpError(404, code, message);
}

function conflict(code: string, message: string): AutomationHttpError {
  return new AutomationHttpError(409, code, message);
}

function rethrowDuplicate(error: unknown, code: string, message: string): never {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  ) {
    throw conflict(code, message);
  }
  throw error;
}
