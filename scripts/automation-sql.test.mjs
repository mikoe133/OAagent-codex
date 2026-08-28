import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sqlDir = path.join(repoRoot, "scripts", "sql")

test("automation baseline creates only the decoupled automation tables", async () => {
  const sql = await readFile(
    path.join(sqlDir, "001_automation_schema_baseline.up.sql"),
    "utf8",
  )
  const createdTables = [...sql.matchAll(/^CREATE TABLE ([a-z_]+) \(/gm)]
    .map((match) => match[1])

  assert.deepEqual(createdTables, [
    "automation_jobs",
    "automation_tags",
    "automation_job_tags",
    "automation_prompt_profiles",
    "automation_job_runs",
    "automation_job_run_projects",
    "automation_ai_interactions",
    "automation_job_change_logs",
    "automation_run_trace_events",
  ])
  assert.doesNotMatch(sql, /\b(?:projects|project_participants|project_github_commit_summaries|user|auth_permission|async_task)\b/)
  assert.match(sql, /'no_commits'/)
  assert.match(sql, /execution_parameters_snapshot JSON NOT NULL/)
  assert.match(sql, /CREATE TABLE automation_run_trace_events[\s\S]*?run_id VARCHAR\(36\) NOT NULL/)
})

test("automation run execution parameters have a reversible upgrade migration", async () => {
  const up = await readFile(
    path.join(sqlDir, "003_automation_run_execution_parameters.up.sql"),
    "utf8",
  )
  const down = await readFile(
    path.join(sqlDir, "003_automation_run_execution_parameters.down.sql"),
    "utf8",
  )

  assert.match(up, /ADD COLUMN execution_parameters_snapshot JSON NOT NULL/)
  assert.match(down, /DROP COLUMN execution_parameters_snapshot/)
  assert.doesNotMatch(up + down, /DATABASE_URL|mysql:\/\//)
})

test("automation seed does not write OA permissions or secrets", async () => {
  const seed = await readFile(
    path.join(sqlDir, "002_automation_defaults_seed.up.sql"),
    "utf8",
  )
  const combined = seed + "\n" + await readFile(
    path.join(sqlDir, "001_automation_schema_baseline.up.sql"),
    "utf8",
  )

  assert.doesNotMatch(seed, /\bauth_permission\b/)
  assert.doesNotMatch(combined, /DATABASE_URL|mysql:\/\/|47\.115\.88\.183/)
  assert.match(seed, /automation_prompt_profiles/)
  assert.match(seed, /automation_tags/)
  assert.match(seed, /automation_jobs/)
})

test("event trigger migration enables monitor jobs and durable deduplication", async () => {
  const up = await readFile(path.join(sqlDir, "004_automation_event_triggers.up.sql"), "utf8")
  const down = await readFile(path.join(sqlDir, "004_automation_event_triggers.down.sql"), "utf8")
  assert.match(up, /schedule_type IN \('cron', 'event'\)/)
  assert.match(up, /MODIFY COLUMN cron_expression VARCHAR\(100\) NULL/)
  assert.match(up, /MODIFY COLUMN cron_expression_snapshot VARCHAR\(100\) NULL/)
  assert.match(up, /trigger_source IN \('schedule', 'manual', 'retry', 'catch_up', 'event'\)/)
  assert.match(up, /CREATE TABLE automation_trigger_events/)
  assert.match(up, /KEY idx_automation_trigger_event_aggregate/)
  assert.match(down, /DROP TABLE IF EXISTS automation_trigger_events/)
  assert.match(down, /DROP COLUMN trigger_type/)
})

test("weekly report monitor seed creates an event-driven all-project job", async () => {
  const up = await readFile(
    path.join(sqlDir, "005_automation_weekly_report_monitor_seed.up.sql"),
    "utf8",
  )
  const down = await readFile(
    path.join(sqlDir, "005_automation_weekly_report_monitor_seed.down.sql"),
    "utf8",
  )

  assert.match(up, /'weekly-report-project-summary-sync'/)
  assert.match(up, /'weekly_report_project_summary_sync'/)
  assert.match(up, /schedule_type,\s*\n\s*trigger_type,\s*\n\s*trigger_config/)
  assert.match(up, /'event',\s*\n\s*'event'/)
  assert.match(up, /'resource', 'weekly_report'/)
  assert.match(up, /'events', JSON_ARRAY\('created', 'updated'\)/)
  assert.match(up, /'scope', 'job_owner'/)
  assert.match(up, /'project_scope', 'all_projects'/)
  assert.match(up, /'include_archived_projects', TRUE/)
  assert.match(up, /'write_archived_projects', TRUE/)
  assert.match(up, /ON DUPLICATE KEY UPDATE job_key = VALUES\(job_key\)/)
  assert.match(down, /weekly-report-project-summary-sync/)
})

test("automation migration runs the monitor seed after event schema", async () => {
  const migration = await readFile(
    path.join(repoRoot, "agent", "src", "automation", "persistence", "migrations.ts"),
    "utf8",
  )
  const eventMigration = migration.indexOf('"004_automation_event_triggers.up.sql"')
  const monitorSeed = migration.indexOf('"005_automation_weekly_report_monitor_seed.up.sql"')
  assert.ok(eventMigration >= 0)
  assert.ok(monitorSeed > eventMigration)
})
