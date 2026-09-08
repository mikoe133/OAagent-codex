ALTER TABLE automation_job_run_projects
    ADD COLUMN weekly_report_syncs JSON NULL AFTER ai_note;

UPDATE automation_job_run_projects
   SET weekly_report_syncs = JSON_ARRAY()
 WHERE weekly_report_syncs IS NULL;

ALTER TABLE automation_job_run_projects
    MODIFY COLUMN weekly_report_syncs JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER ai_note;
