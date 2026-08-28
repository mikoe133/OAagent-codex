import { z } from "zod";
import { createHash } from "node:crypto";
import { MODEL_REASONING_EFFORTS } from "../config/modelCatalog.js";
import { PROJECT_PROGRESS_SUMMARY_SCOPES } from "../domain/projectProgress.js";
import { calculateNextRunAt, validateTimezone } from "./domain.js";

const supportedJobType = z.enum([
  "github_project_progress_sync",
  "weekly_report_project_summary_sync",
]);
const leaseToken = z.string().min(32).max(512);
const workerInstance = z.string().trim().min(1).max(255);
const nullableDateTime = z.string().datetime({ offset: true }).nullable().optional();
const jsonObject = z.record(z.unknown());
const sizedJsonObject = jsonObject.refine(
  (value) => jsonByteLength(value) <= 256 * 1024,
  "json_payload_too_large",
);
const traceMetadata = jsonObject
  .refine(
    (value) => !containsSensitiveTraceKey(value),
    "trace_metadata_contains_sensitive_key",
  )
  .refine(
    (value) => jsonByteLength(value) <= 16 * 1024,
    "trace_metadata_too_large",
  );
const uniquePositiveIds = z
  .array(z.number().int().positive())
  .max(50)
  .refine((items) => new Set(items).size === items.length, "duplicate_tag_ids");
const timezoneSchema = z.string().trim().min(1).max(64).superRefine((value, context) => {
  try {
    validateTimezone(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_timezone" });
  }
});
const cronSchema = z.string().trim().min(1).max(100).superRefine((value, context) => {
  try {
    calculateNextRunAt(value, "UTC", new Date());
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid_cron_expression",
    });
  }
});
const projectProgressJobParameters = z
  .object({
    summary_scope: z.enum(PROJECT_PROGRESS_SUMMARY_SCOPES).default("today"),
    reasoning_effort: z.enum(MODEL_REASONING_EFFORTS).optional(),
    max_output_tokens: z.number().int().min(256).max(4_096).optional(),
  })
  .strict();
const weeklyReportJobParameters = z
  .object({
    project_scope: z.literal("all_projects").default("all_projects"),
    include_archived_projects: z.boolean().default(true),
    write_archived_projects: z.boolean().default(true),
    minimum_confidence: z.number().min(0).max(1).default(0.8),
    on_ambiguous: z.enum(["no_write", "record_and_continue"]).default("no_write"),
    debounce_seconds: z.number().int().min(0).max(3600).default(60),
    reasoning_effort: z.enum(MODEL_REASONING_EFFORTS).optional(),
    max_output_tokens: z.number().int().min(256).max(4_096).optional(),
  })
  .strict();
const weeklyReportTriggerConfig = z
  .object({
    resource: z.literal("weekly_report"),
    events: z.array(z.enum(["created", "updated"])).min(1).max(2),
    scope: z.enum(["job_owner", "all_users"]).default("job_owner"),
  })
  .strict();

export const automationPromptProfilePatchSchema = z
  .object({
    system_prompt: z
      .string()
      .transform((value) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim())
      .refine((value) => value.length >= 1 && value.length <= 16_000)
      .refine(
        (value) =>
          ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return (code < 32 || (code >= 127 && code <= 159)) &&
              character !== "\n" &&
              character !== "\t";
          }),
        "automation_prompt_invalid",
      ),
    enabled: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict();

export const automationTagCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().max(32).nullable().default(null),
    description: z.string().max(500).default(""),
    enabled: z.boolean().default(true),
  })
  .strict();

export const automationTagPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    color: z.string().max(32).nullable().optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "no_changes");

export const automationJobCreateSchema = z
  .object({
    job_key: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    job_type: supportedJobType,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(4000).default(""),
    enabled: z.boolean().default(false),
    timezone: timezoneSchema.default("Asia/Shanghai"),
    schedule_type: z.enum(["cron", "event"]).default("cron"),
    trigger_type: z.enum(["schedule", "event"]).default("schedule"),
    trigger_config: weeklyReportTriggerConfig.nullable().optional().default(null),
    cron_expression: z.union([cronSchema, z.null()]).optional(),
    catch_up_policy: z.enum(["skip", "latest"]).default("latest"),
    overlap_policy: z.literal("forbid").default("forbid"),
    model_provider: z.string().trim().min(1).max(100),
    model_id: z.string().trim().min(1).max(150),
    model_parameters: z.record(z.unknown()).default({}),
    retry_max_attempts: z.number().int().min(1).max(10).default(3),
    retry_interval_seconds: z.number().int().min(0).max(86_400).default(300),
    timeout_seconds: z.number().int().min(60).max(86_400).default(2700),
    retention_days: z.number().int().min(1).max(3650).default(90),
    tag_ids: uniquePositiveIds.default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const eventJob = value.job_type === "weekly_report_project_summary_sync";
    if (eventJob) {
      if (value.schedule_type !== "event" || value.trigger_type !== "event") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "weekly_report_job_must_be_event" });
      }
      if (!value.trigger_config) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "weekly_report_trigger_config_required" });
      }
      if (value.cron_expression !== undefined && value.cron_expression !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "event_job_cannot_have_cron" });
      }
      const parsed = weeklyReportJobParameters.safeParse(value.model_parameters);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) context.addIssue(issue);
      }
    } else {
      if (value.schedule_type !== "cron" || value.trigger_type !== "schedule") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "project_progress_job_must_be_cron" });
      }
      if (!value.cron_expression) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "cron_expression_required" });
      }
      if (value.trigger_config !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "schedule_job_cannot_have_trigger_config" });
      }
      const parsed = projectProgressJobParameters.safeParse(value.model_parameters);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) context.addIssue(issue);
      }
    }
  })
  .transform((value) => ({
    ...value,
    cron_expression: value.schedule_type === "event" ? null : value.cron_expression as string,
    trigger_config: value.schedule_type === "event" ? value.trigger_config : null,
    model_parameters: value.job_type === "weekly_report_project_summary_sync"
      ? weeklyReportJobParameters.parse(value.model_parameters)
      : projectProgressJobParameters.parse(value.model_parameters),
  }));

export const automationJobPatchSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(4000).optional(),
    enabled: z.boolean().optional(),
    tag_ids: uniquePositiveIds.optional(),
    timezone: timezoneSchema.optional(),
    cron_expression: z.union([cronSchema, z.null()]).optional(),
    catch_up_policy: z.enum(["skip", "latest"]).optional(),
    model_provider: z.string().trim().min(1).max(100).optional(),
    model_id: z.string().trim().min(1).max(150).optional(),
    model_parameters: z.record(z.unknown()).optional(),
    retry_max_attempts: z.number().int().min(1).max(10).optional(),
    retry_interval_seconds: z.number().int().min(0).max(86_400).optional(),
    timeout_seconds: z.number().int().min(60).max(86_400).optional(),
    retention_days: z.number().int().min(1).max(3650).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "version"), "no_changes")
  .superRefine((value, context) => {
    if (value.model_parameters) {
      const project = projectProgressJobParameters.safeParse(value.model_parameters);
      const weekly = weeklyReportJobParameters.safeParse(value.model_parameters);
      if (!project.success && !weekly.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_model_parameters" });
      }
    }
  });

export const automationManualRunCreateSchema = z
  .object({
    project_id: z.number().int().positive().optional(),
    summary_scope: z.enum(PROJECT_PROGRESS_SUMMARY_SCOPES).optional(),
  })
  .strict()
  .transform((value) =>
    value.project_id !== undefined && value.summary_scope === undefined
      ? { ...value, summary_scope: "today" as const }
      : value,
  );

export const automationClaimSchema = z
  .object({
    worker_instance: workerInstance,
    supported_job_types: z.array(supportedJobType).min(1).max(20),
    lease_seconds: z.number().int().min(60).max(600).default(300),
    claim_request_id: z.string().uuid().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    supported_job_types: [...new Set(value.supported_job_types)],
  }));

export const automationEventCreateSchema = z
  .object({
    event_id: z.string().uuid(),
    event_type: z.enum(["weekly_report.created", "weekly_report.updated"]),
    aggregate_type: z.literal("weekly_report"),
    aggregate_id: z.string().trim().min(1).max(255),
    aggregate_version: z.number().int().positive(),
    occurred_at: z.string().datetime({ offset: true }),
    actor_id: z.number().int().positive().nullable().optional(),
    scope: z.object({ user_id: z.number().int().positive().optional() }).strict().default({}),
    data: z
      .object({
        weekly_num: z.number().int().positive(),
        content: z.string().min(1).max(900_000).optional(),
        content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
        updated_at: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.data.content && value.data.content_hash) {
      const digest = `sha256:${createHash("sha256").update(value.data.content, "utf8").digest("hex")}`;
      if (digest !== value.data.content_hash) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "content_hash_mismatch", path: ["data", "content_hash"] });
      }
    }
  });

export const automationHeartbeatSchema = z
  .object({
    worker_instance: workerInstance,
    lease_token: leaseToken,
    lease_seconds: z.number().int().min(60).max(600).optional(),
  })
  .strict();

export const automationRunPatchSchema = z
  .object({
    worker_instance: workerInstance,
    lease_token: leaseToken,
    status: z.enum([
      "running",
      "succeeded",
      "partial_failed",
      "failed",
      "configuration_error",
      "cancelled",
    ]),
    mutations_applied: z.boolean().optional(),
    retry_recommended: z.boolean().default(false),
    error_code: z.string().max(100).nullable().optional(),
    error_summary: z.string().max(1000).nullable().optional(),
  })
  .strict();

export const automationRunProjectUpsertSchema = z
  .object({
    worker_instance: workerInstance,
    lease_token: leaseToken,
    project_name_snapshot: z.string().trim().min(1).max(255),
    status_before: z.string().max(32).nullable().optional(),
    status_after: z.string().max(32).nullable().optional(),
    outcome: z.enum([
      "evaluated",
      "archived",
      "no_github_urls",
      "no_commits",
      "invalid_github_urls",
      "incomplete",
      "write_conflict",
      "failed",
    ]),
    repository_count: z.number().int().nonnegative().default(0),
    commit_count: z.number().int().nonnegative().default(0),
    summary_date: z.string().date().nullable().optional(),
    source_digest: z.string().max(128).nullable().optional(),
    generated_summary: z.string().max(1_000_000).nullable().optional(),
    ai_confidence: z.number().int().min(0).max(100).nullable().optional(),
    ai_note: z.string().max(10_000).nullable().optional(),
    warnings: z
      .array(jsonObject)
      .max(100)
      .refine((value) => jsonByteLength(value) <= 256 * 1024, "json_payload_too_large")
      .default([]),
    mutations_applied: z.boolean().default(false),
    started_at: nullableDateTime,
    finished_at: nullableDateTime,
    duration_ms: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const automationTraceEventUpsertSchema = z
  .object({
    worker_instance: workerInstance,
    lease_token: leaseToken,
    event_key: z.string().trim().min(1).max(200),
    sequence: z.number().int().nonnegative(),
    phase: z.string().trim().min(1).max(100),
    status: z.enum([
      "pending",
      "running",
      "succeeded",
      "fallback",
      "failed",
      "cancelled",
    ]),
    title: z.string().trim().min(1).max(200),
    message: z.string().max(1000).nullable().optional(),
    progress_current: z.number().int().nonnegative().nullable().optional(),
    progress_total: z.number().int().nonnegative().nullable().optional(),
    project_id: z.number().int().positive().nullable().optional(),
    repository_full_name: z.string().max(255).nullable().optional(),
    metadata_sanitized: traceMetadata.default({}),
    occurred_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.progress_current != null &&
      value.progress_total != null &&
      value.progress_current > value.progress_total
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trace_progress_current_exceeds_total",
        path: ["progress_current"],
      });
    }
  });

export const automationAiInteractionCreateSchema = z
  .object({
    worker_instance: workerInstance,
    lease_token: leaseToken,
    run_project_id: z.number().int().positive(),
    interaction_key: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(150),
    model_catalog_version: z.string().max(100).nullable().optional(),
    prompt_version: z.string().max(100).nullable().optional(),
    system_prompt_snapshot: z.string().max(1_000_000).nullable().optional(),
    request_payload_sanitized: sizedJsonObject.nullable().optional(),
    response_payload_sanitized: sizedJsonObject.nullable().optional(),
    final_summary: z.string().max(1_000_000).nullable().optional(),
    limitations: z
      .array(jsonObject)
      .max(100)
      .refine((value) => jsonByteLength(value) <= 256 * 1024, "json_payload_too_large")
      .default([]),
    fallback_used: z.boolean().default(false),
    upstream_request_id: z.string().max(255).nullable().optional(),
    input_tokens: z.number().int().nonnegative().nullable().optional(),
    output_tokens: z.number().int().nonnegative().nullable().optional(),
    latency_ms: z.number().int().nonnegative().nullable().optional(),
    status: z.enum(["succeeded", "failed", "fallback"]),
    error_code: z.string().max(100).nullable().optional(),
    error_summary: z.string().max(1000).nullable().optional(),
  })
  .strict();

export type AutomationClaimInput = z.infer<typeof automationClaimSchema>;
export type AutomationEventCreateInput = z.infer<typeof automationEventCreateSchema>;
export type AutomationHeartbeatInput = z.infer<typeof automationHeartbeatSchema>;
export type AutomationRunPatchInput = z.infer<typeof automationRunPatchSchema>;
export type AutomationRunProjectUpsertInput = z.infer<
  typeof automationRunProjectUpsertSchema
>;
export type AutomationTraceEventUpsertInput = z.infer<
  typeof automationTraceEventUpsertSchema
>;
export type AutomationAiInteractionCreateInput = z.infer<
  typeof automationAiInteractionCreateSchema
>;

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function containsSensitiveTraceKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveTraceKey);
  if (!value || typeof value !== "object") return false;
  const blocked = new Set([
    "authorization",
    "token",
    "accesstoken",
    "apikey",
    "cookie",
    "sessionid",
    "password",
    "secret",
    "privatekey",
    "patch",
    "systemprompt",
  ]);
  return Object.entries(value).some(
    ([key, child]) =>
      blocked.has(key.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")) ||
      containsSensitiveTraceKey(child),
  );
}
