DROP TABLE IF EXISTS automation_trigger_events;
ALTER TABLE automation_job_runs
    DROP CHECK chk_automation_job_runs_trigger,
    ADD CONSTRAINT chk_automation_job_runs_trigger CHECK (trigger_source IN ('schedule', 'manual', 'retry', 'catch_up'));
UPDATE automation_job_runs
   SET cron_expression_snapshot = ''
 WHERE cron_expression_snapshot IS NULL;
ALTER TABLE automation_job_runs
    DROP KEY idx_automation_job_runs_trigger_event,
    DROP COLUMN trigger_event_id,
    DROP COLUMN source_snapshot,
    MODIFY COLUMN cron_expression_snapshot VARCHAR(100) NOT NULL;
UPDATE automation_jobs
   SET schedule_type = 'cron',
       trigger_type = 'schedule',
       trigger_config = NULL,
       cron_expression = COALESCE(cron_expression, '0 0 * * *')
 WHERE schedule_type = 'event'
    OR trigger_type = 'event'
    OR cron_expression IS NULL;
ALTER TABLE automation_jobs
    DROP CHECK chk_automation_jobs_trigger_type,
    DROP CHECK chk_automation_jobs_schedule_type,
    ADD CONSTRAINT chk_automation_jobs_schedule_type CHECK (schedule_type = 'cron'),
    DROP COLUMN trigger_config,
    DROP COLUMN trigger_type,
    MODIFY COLUMN cron_expression VARCHAR(100) NOT NULL;
