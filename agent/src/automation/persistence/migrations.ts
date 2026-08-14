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

const MIGRATION_LOCK = "oaagent_automation_schema_baseline";

export type AutomationMigrationResult = {
  baselineApplied: boolean;
  executionParametersApplied: boolean;
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

    const seed = await readFile(
      path.join(sqlDirectory, "002_automation_defaults_seed.up.sql"),
      "utf8",
    );
    await connection.query(seed);
    return {
      baselineApplied,
      executionParametersApplied,
      seedApplied: true,
      tables: AUTOMATION_TABLES,
    };
  } finally {
    if (lockAcquired) {
      await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
    }
    await connection.end();
  }
}
