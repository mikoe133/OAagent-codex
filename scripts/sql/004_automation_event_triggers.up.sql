ALTER TABLE automation_jobs
    ADD COLUMN trigger_type VARCHAR(20) NOT NULL DEFAULT 'schedule' AFTER schedule_type,
    ADD COLUMN trigger_config JSON NULL AFTER trigger_type,
    MODIFY COLUMN cron_expression VARCHAR(100) NULL;

ALTER TABLE automation_jobs
    DROP CHECK chk_automation_jobs_schedule_type,
    ADD CONSTRAINT chk_automation_jobs_schedule_type CHECK (schedule_type IN ('cron', 'event')),
    ADD CONSTRAINT chk_automation_jobs_trigger_type CHECK (trigger_type IN ('schedule', 'event'));

ALTER TABLE automation_job_runs
    ADD COLUMN source_snapshot JSON NULL AFTER execution_parameters_snapshot,
    ADD COLUMN trigger_event_id CHAR(36) NULL AFTER source_snapshot,
    MODIFY COLUMN cron_expression_snapshot VARCHAR(100) NULL,
    ADD KEY idx_automation_job_runs_trigger_event (trigger_event_id);

ALTER TABLE automation_job_runs
    DROP CHECK chk_automation_job_runs_trigger,
    ADD CONSTRAINT chk_automation_job_runs_trigger CHECK (trigger_source IN ('schedule', 'manual', 'retry', 'catch_up', 'event'));

CREATE TABLE automation_trigger_events (
    event_id CHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_version BIGINT NOT NULL,
    event_hash CHAR(64) NOT NULL,
    payload JSON NOT NULL,
    job_id BIGINT NULL,
    run_id CHAR(36) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'received',
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (event_id),
    KEY idx_automation_trigger_event_aggregate (aggregate_type, aggregate_id, aggregate_version),
    KEY idx_automation_trigger_event_run (run_id),
    CONSTRAINT fk_automation_trigger_event_job FOREIGN KEY (job_id)
        REFERENCES automation_jobs (id) ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT fk_automation_trigger_event_run FOREIGN KEY (run_id)
        REFERENCES automation_job_runs (id) ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT chk_automation_trigger_event_status CHECK (status IN ('received', 'deduplicated', 'queued', 'stale', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
