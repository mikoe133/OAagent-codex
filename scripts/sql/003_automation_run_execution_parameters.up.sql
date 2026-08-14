ALTER TABLE automation_job_runs
    ADD COLUMN execution_parameters_snapshot JSON NOT NULL DEFAULT (JSON_OBJECT())
    AFTER model_parameters_snapshot;

ALTER TABLE automation_job_runs
    ALTER COLUMN execution_parameters_snapshot DROP DEFAULT;
