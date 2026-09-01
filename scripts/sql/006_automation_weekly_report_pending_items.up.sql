CREATE TABLE automation_weekly_report_pending_items (
    id BIGINT NOT NULL AUTO_INCREMENT,
    run_id CHAR(36) NOT NULL,
    trigger_event_id CHAR(36) NOT NULL,
    source_report_id VARCHAR(255) NOT NULL,
    source_version BIGINT NOT NULL,
    weekly_num INT NOT NULL,
    owner_user_id BIGINT NULL,
    segment_key CHAR(64) NOT NULL,
    segment_order INT NOT NULL,
    content_digest CHAR(64) NOT NULL,
    original_content MEDIUMTEXT NULL,
    ai_summary TEXT NULL,
    ai_reason VARCHAR(1000) NULL,
    reason_code VARCHAR(50) NOT NULL,
    classification_source VARCHAR(20) NOT NULL,
    referenced_project_id INT NULL,
    candidate_project_ids JSON NOT NULL,
    ai_confidence TINYINT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    resolution_type VARCHAR(20) NULL,
    resolved_project_id INT NULL,
    resolution_batch_id CHAR(36) NULL,
    resolution_note VARCHAR(1000) NULL,
    resolved_by BIGINT NULL,
    resolved_at DATETIME(6) NULL,
    sync_status VARCHAR(20) NOT NULL DEFAULT 'not_started',
    sync_error VARCHAR(1000) NULL,
    reprocessed_run_id CHAR(36) NULL,
    content_purged_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_weekly_pending_run_segment (run_id, segment_key),
    KEY idx_weekly_pending_report (source_report_id, source_version, segment_order),
    KEY idx_weekly_pending_review (status, created_at),
    KEY idx_weekly_pending_reference (referenced_project_id, status),
    KEY idx_weekly_pending_resolution_batch (resolution_batch_id),
    KEY idx_weekly_pending_digest (content_digest),
    CONSTRAINT fk_weekly_pending_run FOREIGN KEY (run_id)
        REFERENCES automation_job_runs (id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_weekly_pending_event FOREIGN KEY (trigger_event_id)
        REFERENCES automation_trigger_events (event_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_weekly_pending_reprocessed_run FOREIGN KEY (reprocessed_run_id)
        REFERENCES automation_job_runs (id) ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT chk_weekly_pending_segment_order CHECK (segment_order >= 1),
    CONSTRAINT chk_weekly_pending_reason CHECK (
        reason_code IN (
            'project_not_found',
            'no_project_match',
            'ambiguous_project',
            'below_confidence',
            'invalid_agent_result',
            'archived_write_disabled'
        )
    ),
    CONSTRAINT chk_weekly_pending_source CHECK (
        classification_source IN ('deterministic', 'agent', 'validation', 'fallback')
    ),
    CONSTRAINT chk_weekly_pending_status CHECK (
        status IN ('pending', 'processing', 'resolved', 'sync_failed', 'ignored')
    ),
    CONSTRAINT chk_weekly_pending_resolution CHECK (
        resolution_type IS NULL OR resolution_type IN ('existing_project', 'new_project')
    ),
    CONSTRAINT chk_weekly_pending_sync_status CHECK (
        sync_status IN ('not_started', 'pending', 'succeeded', 'failed')
    ),
    CONSTRAINT chk_weekly_pending_confidence CHECK (
        ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 100
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
