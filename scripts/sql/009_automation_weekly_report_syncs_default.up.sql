-- MySQL 8.0.13+: allow older services to omit the newly added audit column.
ALTER TABLE automation_job_run_projects
    ALTER COLUMN weekly_report_syncs SET DEFAULT (JSON_ARRAY());
