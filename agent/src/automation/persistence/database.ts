import { Kysely, MysqlDialect, type Generated } from "kysely";
import mysql, { type Pool, type PoolOptions } from "mysql2";

type Timestamp = Date;
type JsonValue = unknown;

export type AutomationDatabaseSchema = {
  automation_jobs: {
    id: Generated<number>;
    job_key: string;
    job_type: string;
    name: string;
    description: string;
    enabled: number;
    timezone: string;
    schedule_type: string;
    trigger_type: string;
    trigger_config: JsonValue | null;
    cron_expression: string | null;
    catch_up_policy: string;
    overlap_policy: string;
    model_provider: string;
    model_id: string;
    model_parameters: JsonValue;
    model_catalog_version: string | null;
    retry_max_attempts: number;
    retry_interval_seconds: number;
    timeout_seconds: number;
    retention_days: number;
    last_scheduled_at: Timestamp | null;
    last_started_at: Timestamp | null;
    last_finished_at: Timestamp | null;
    next_run_at: Timestamp | null;
    last_run_status: string | null;
    configuration_status: string;
    configuration_error: string | null;
    version: number;
    created_by: number | null;
    updated_by: number | null;
    deleted_at: Timestamp | null;
    deleted_by: number | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_tags: {
    id: Generated<number>;
    name: string;
    normalized_name: string;
    color: string | null;
    description: string;
    enabled: number;
    created_by: number | null;
    updated_by: number | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_job_tags: {
    job_id: number;
    tag_id: number;
    created_at: Timestamp;
  };
  automation_prompt_profiles: {
    id: Generated<number>;
    job_type: string;
    system_prompt: string;
    prompt_version: string;
    enabled: number;
    version: number;
    created_by: number | null;
    updated_by: number | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_job_runs: {
    id: string;
    root_run_id: string;
    parent_run_id: string | null;
    job_id: number;
    job_key_snapshot: string;
    job_name_snapshot: string;
    job_type_snapshot: string;
    description_snapshot: string;
    tags_snapshot: JsonValue;
    trigger_source: string;
    scheduled_at: Timestamp;
    available_at: Timestamp;
    triggered_at: Timestamp;
    started_at: Timestamp | null;
    finished_at: Timestamp | null;
    status: string;
    attempt: number;
    model_provider_snapshot: string;
    model_id_snapshot: string;
    model_parameters_snapshot: JsonValue;
    execution_parameters_snapshot: JsonValue;
    source_snapshot: JsonValue | null;
    trigger_event_id: string | null;
    model_catalog_version_snapshot: string | null;
    prompt_version_snapshot: string | null;
    system_prompt_snapshot: string | null;
    cron_expression_snapshot: string | null;
    timezone_snapshot: string;
    retry_max_attempts_snapshot: number;
    retry_interval_seconds_snapshot: number;
    timeout_seconds_snapshot: number;
    deadline_at: Timestamp;
    worker_instance: string | null;
    lease_token_digest: string | null;
    lease_duration_seconds: number | null;
    lease_expires_at: Timestamp | null;
    heartbeat_at: Timestamp | null;
    projects_total: number;
    projects_succeeded: number;
    projects_failed: number;
    mutations_applied: number;
    retry_recommended: number;
    duration_ms: number | null;
    error_code: string | null;
    error_summary: string | null;
    cancel_requested_at: Timestamp | null;
    cancel_requested_by: number | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_job_run_projects: {
    id: Generated<number>;
    run_id: string;
    project_id: number;
    project_name_snapshot: string;
    status_before: string | null;
    status_after: string | null;
    outcome: string;
    repository_count: number;
    commit_count: number;
    summary_date: Date | null;
    source_digest: string | null;
    generated_summary: string | null;
    ai_confidence: number | null;
    ai_note: string | null;
    warnings: JsonValue;
    mutations_applied: number;
    started_at: Timestamp | null;
    finished_at: Timestamp | null;
    duration_ms: number | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_ai_interactions: {
    id: Generated<number>;
    run_id: string;
    run_project_id: number;
    interaction_key: string;
    provider: string;
    model: string;
    model_catalog_version: string | null;
    prompt_version: string | null;
    system_prompt_snapshot: string | null;
    request_payload_sanitized: JsonValue | null;
    response_payload_sanitized: JsonValue | null;
    final_summary: string | null;
    limitations: JsonValue;
    fallback_used: number;
    upstream_request_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    status: string;
    error_code: string | null;
    error_summary: string | null;
    purged_at: Timestamp | null;
    created_at: Timestamp;
  };
  automation_job_change_logs: {
    id: Generated<number>;
    job_id: number;
    action: string;
    version_before: number | null;
    version_after: number;
    changes_json: JsonValue;
    operated_by: number | null;
    created_at: Timestamp;
  };
  automation_run_trace_events: {
    id: Generated<number>;
    run_id: string;
    event_key: string;
    sequence: number;
    phase: string;
    status: string;
    title: string;
    message: string | null;
    progress_current: number | null;
    progress_total: number | null;
    project_id: number | null;
    repository_full_name: string | null;
    metadata_sanitized: JsonValue;
    started_at: Timestamp | null;
    finished_at: Timestamp | null;
    occurred_at: Timestamp;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  automation_trigger_events: {
    event_id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: number;
    event_hash: string;
    payload: JsonValue;
    job_id: number | null;
    run_id: string | null;
    status: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
};

export type AutomationDatabase = {
  db: Kysely<AutomationDatabaseSchema>;
  pool: Pool;
  close(): Promise<void>;
};

export function createAutomationDatabase(databaseUrl: URL): AutomationDatabase {
  const pool = mysql.createPool(mysqlPoolOptions(databaseUrl));
  const db = new Kysely<AutomationDatabaseSchema>({
    dialect: new MysqlDialect({ pool }),
  });
  return {
    db,
    pool,
    close: () => db.destroy(),
  };
}

export function mysqlPoolOptions(databaseUrl: URL): PoolOptions {
  return {
    host: databaseUrl.hostname,
    port: databaseUrl.port ? Number(databaseUrl.port) : 3306,
    user: decodeUrlComponent(databaseUrl.username),
    password: decodeUrlComponent(databaseUrl.password),
    database: decodeUrlComponent(databaseUrl.pathname.slice(1)),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: "Z",
    charset: "utf8mb4",
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  };
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
