CREATE TABLE automation_weekly_report_summary_bindings (
    id BIGINT NOT NULL AUTO_INCREMENT,
    source_report_id VARCHAR(255) NOT NULL,
    project_id INT NOT NULL,
    summary_date DATE NOT NULL,
    commit_summary_id BIGINT NOT NULL,
    source_version BIGINT NOT NULL,
    created_run_id CHAR(36) NOT NULL,
    last_run_id CHAR(36) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_weekly_summary_binding_source (
        source_report_id,
        project_id,
        summary_date
    ),
    UNIQUE KEY uq_weekly_summary_binding_commit (commit_summary_id),
    KEY idx_weekly_summary_binding_project_date (project_id, summary_date),
    KEY idx_weekly_summary_binding_last_run (last_run_id),
    CONSTRAINT fk_weekly_summary_binding_created_run FOREIGN KEY (created_run_id)
        REFERENCES automation_job_runs (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_weekly_summary_binding_last_run FOREIGN KEY (last_run_id)
        REFERENCES automation_job_runs (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_weekly_summary_binding_source_version CHECK (source_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
