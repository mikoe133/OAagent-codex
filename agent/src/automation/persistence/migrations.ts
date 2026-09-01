import { readFile } from "node:fs/promises";
import path from "node:path";
import mysql, { type RowDataPacket } from "mysql2/promise";

import { mysqlPoolOptions } from "./database.js";

const AUTOMATION_TABLES = [
  "automation_jobs",
  "automation_tags",
  "automation_job_tags",
  "automation_prompt_profiles",
  "automation_job_runs",
  "automation_job_run_projects",
  "automation_ai_interactions",
  "automation_job_change_logs",
  "automation_run_trace_events",
] as const;
const AUTOMATION_EVENT_TABLES = ["automation_trigger_events"] as const;
const AUTOMATION_WEEKLY_PENDING_TABLES = ["automation_weekly_report_pending_items"] as const;
const AUTOMATION_WEEKLY_SUMMARY_BINDING_TABLES = [
  "automation_weekly_report_summary_bindings",
] as const;

const MIGRATION_LOCK = "oaagent_automation_schema_baseline";

export type AutomationMigrationResult = {
  baselineApplied: boolean;
  executionParametersApplied: boolean;
  eventTriggersApplied: boolean;
  weeklyPendingItemsApplied: boolean;
  weeklySummaryBindingsApplied: boolean;
  seedApplied: boolean;
  tables: readonly string[];
};

export async function runAutomationMigrations(
  databaseUrl: URL,
  repoRoot: string,
): Promise<AutomationMigrationResult> {
  const options = mysqlPoolOptions(databaseUrl);
  const connection = await mysql.createConnection({
    ...options,
    multipleStatements: true,
  });
  let lockAcquired = false;
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, 60) AS acquired",
      [MIGRATION_LOCK],
    );
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) {
      throw new Error("获取 automation migration lock 超时。");
    }

    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    const [tableRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name IN (?)`,
      [databaseName, [...AUTOMATION_TABLES]],
    );
    const existing = new Set(
      tableRows.map((row) => String(row.table_name ?? row.TABLE_NAME)),
    );
    if (existing.size !== 0 && existing.size !== AUTOMATION_TABLES.length) {
      const missing = AUTOMATION_TABLES.filter((table) => !existing.has(table));
      throw new Error(
        `检测到不完整的 automation schema，拒绝继续迁移。缺少: ${missing.join(", ")}`,
      );
    }

    const sqlDirectory = path.join(repoRoot, "scripts", "sql");
    let baselineApplied = false;
    if (existing.size === 0) {
      const baseline = await readFile(
        path.join(sqlDirectory, "001_automation_schema_baseline.up.sql"),
        "utf8",
      );
      await connection.query(baseline);
      baselineApplied = true;
    }

    const [columnRows] = await connection.query<RowDataPacket[]>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = 'automation_job_runs'
          AND column_name = 'execution_parameters_snapshot'`,
      [databaseName],
    );
    let executionParametersApplied = false;
    if (columnRows.length === 0) {
      const executionParametersMigration = await readFile(
        path.join(sqlDirectory, "003_automation_run_execution_parameters.up.sql"),
        "utf8",
      );
      await connection.query(executionParametersMigration);
      executionParametersApplied = true;
    }

    const [eventColumnRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = ?
          AND (
            (table_name = 'automation_jobs' AND column_name IN ('trigger_type', 'trigger_config', 'cron_expression'))
            OR
            (table_name = 'automation_job_runs' AND column_name IN ('source_snapshot', 'trigger_event_id', 'cron_expression_snapshot'))
          )`,
      [databaseName],
    );
    const [eventTableRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 'automation_trigger_events'`,
      [databaseName],
    );
    let eventTriggersApplied = false;
    const eventColumns = new Map(
      eventColumnRows.map((row) => [
        `${String(row.table_name ?? row.TABLE_NAME)}.${String(
          row.column_name ?? row.COLUMN_NAME,
        )}`,
        String(row.is_nullable ?? row.IS_NULLABLE),
      ]),
    );
    const requiredEventColumns = [
      "automation_jobs.trigger_type",
      "automation_jobs.trigger_config",
      "automation_jobs.cron_expression",
      "automation_job_runs.source_snapshot",
      "automation_job_runs.trigger_event_id",
      "automation_job_runs.cron_expression_snapshot",
    ];
    const eventSpecificColumns = requiredEventColumns.filter(
      (column) => !column.endsWith(".cron_expression") &&
        !column.endsWith(".cron_expression_snapshot"),
    );
    const eventSchemaComplete = requiredEventColumns.every((column) => eventColumns.has(column)) &&
      eventColumns.get("automation_jobs.cron_expression") === "YES" &&
      eventColumns.get("automation_job_runs.cron_expression_snapshot") === "YES";
    if (!eventSchemaComplete || eventTableRows.length === 0) {
      if (eventSpecificColumns.some((column) => eventColumns.has(column)) || eventTableRows.length !== 0) {
        throw new Error("检测到不完整的 automation event schema，拒绝继续迁移。");
      }
      const eventTriggersMigration = await readFile(
        path.join(sqlDirectory, "004_automation_event_triggers.up.sql"),
        "utf8",
      );
      await connection.query(eventTriggersMigration);
      eventTriggersApplied = true;
    }

    const [weeklyPendingTableRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name = 'automation_weekly_report_pending_items'`,
      [databaseName],
    );
    let weeklyPendingItemsApplied = false;
    if (weeklyPendingTableRows.length === 0) {
      const weeklyPendingMigration = await readFile(
        path.join(sqlDirectory, "006_automation_weekly_report_pending_items.up.sql"),
        "utf8",
      );
      await connection.query(weeklyPendingMigration);
      weeklyPendingItemsApplied = true;
    }

    const [weeklySummaryBindingTableRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name = 'automation_weekly_report_summary_bindings'`,
      [databaseName],
    );
    let weeklySummaryBindingsApplied = false;
    if (weeklySummaryBindingTableRows.length === 0) {
      const weeklySummaryBindingMigration = await readFile(
        path.join(
          sqlDirectory,
          "007_automation_weekly_report_summary_bindings.up.sql",
        ),
        "utf8",
      );
      await connection.query(weeklySummaryBindingMigration);
      weeklySummaryBindingsApplied = true;
    }

    const seed = await readFile(
      path.join(sqlDirectory, "002_automation_defaults_seed.up.sql"),
      "utf8",
    );
    await connection.query(seed);
    const monitorSeed = await readFile(
      path.join(sqlDirectory, "005_automation_weekly_report_monitor_seed.up.sql"),
      "utf8",
    );
    await connection.query(monitorSeed);
    return {
      baselineApplied,
      executionParametersApplied,
      eventTriggersApplied,
      weeklyPendingItemsApplied,
      weeklySummaryBindingsApplied,
      seedApplied: true,
      tables: [
        ...AUTOMATION_TABLES,
        ...AUTOMATION_EVENT_TABLES,
        ...AUTOMATION_WEEKLY_PENDING_TABLES,
        ...AUTOMATION_WEEKLY_SUMMARY_BINDING_TABLES,
      ],
    };
  } finally {
    if (lockAcquired) {
      await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
    }
    await connection.end();
  }
}
