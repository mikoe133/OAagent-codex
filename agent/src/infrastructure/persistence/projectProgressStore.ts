import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ProjectProgressOutboxIntent = {
  intentKey: string;
  operation: string;
  projectId: number;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "conflict" | "non_retryable";
  attempts: number;
  lastError: string | null;
};

export type ManagedProjectSummary = {
  summaryId: number;
  sourceDigest: string;
  appliedPayload: {
    summary: string;
    aiConfidence: number;
    aiNote: string;
  };
};

export class ProjectProgressStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  saveProjectRepositoryWatermark(
    projectId: number,
    repositoryId: number,
    watermark: string,
  ): void {
    assertPositiveInteger(projectId, "projectId");
    assertPositiveInteger(repositoryId, "repositoryId");
    assertIsoDate(watermark, "watermark");
    this.database.prepare(`
      INSERT INTO project_repository_state (
        project_id, repository_id, membership_epoch, joined_at,
        last_consumed_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(project_id, repository_id) DO UPDATE SET
        last_consumed_at = excluded.last_consumed_at,
        updated_at = excluded.updated_at
    `).run(projectId, repositoryId, watermark, watermark, watermark);
  }

  getProjectRepositoryWatermark(projectId: number, repositoryId: number): string | null {
    const row = this.database.prepare(`
      SELECT last_consumed_at
      FROM project_repository_state
      WHERE project_id = ? AND repository_id = ?
    `).get(projectId, repositoryId) as { last_consumed_at: string | null } | undefined;
    return row?.last_consumed_at ?? null;
  }

  saveDailySummaryDraft(input: {
    projectId: number;
    summaryDate: string;
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  }): void {
    assertPositiveInteger(input.projectId, "projectId");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.summaryDate)) {
      throw new Error("summaryDate 必须是 YYYY-MM-DD。");
    }
    if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
      throw new Error("sourceDigest 必须是 SHA-256 hex。");
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO project_daily_summary (
        project_id, summary_date, source_digest, draft_summary,
        draft_ai_confidence, draft_ai_note, managed, adopted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(project_id, summary_date) DO UPDATE SET
        source_digest = excluded.source_digest,
        draft_summary = excluded.draft_summary,
        draft_ai_confidence = excluded.draft_ai_confidence,
        draft_ai_note = excluded.draft_ai_note,
        updated_at = excluded.updated_at
    `).run(
      input.projectId,
      input.summaryDate,
      input.sourceDigest,
      input.summary,
      input.aiConfidence,
      input.aiNote,
      now,
    );
  }

  getDailySummaryDraft(
    projectId: number,
    summaryDate: string,
  ): {
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  } | null {
    const row = this.database.prepare(`
      SELECT source_digest, draft_summary, draft_ai_confidence, draft_ai_note
      FROM project_daily_summary
      WHERE project_id = ? AND summary_date = ?
    `).get(projectId, summaryDate) as {
      source_digest: string;
      draft_summary: string;
      draft_ai_confidence: number;
      draft_ai_note: string;
    } | undefined;
    return row
      ? {
          sourceDigest: row.source_digest,
          summary: row.draft_summary,
          aiConfidence: row.draft_ai_confidence,
          aiNote: row.draft_ai_note,
        }
      : null;
  }

  enqueueOutbox(input: {
    intentKey: string;
    operation: string;
    projectId: number;
    payload: Record<string, unknown>;
  }): void {
    if (!input.intentKey.trim() || !input.operation.trim()) {
      throw new Error("intentKey 和 operation 不能为空。");
    }
    assertPositiveInteger(input.projectId, "projectId");
    this.database.prepare(`
      INSERT OR IGNORE INTO oa_outbox (
        intent_key, operation, project_id, payload_json, status,
        attempts, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
    `).run(
      input.intentKey,
      input.operation,
      input.projectId,
      JSON.stringify(input.payload),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  listPendingOutbox(): ProjectProgressOutboxIntent[] {
    const rows = this.database.prepare(`
      SELECT intent_key, operation, project_id, payload_json, status, attempts, last_error
      FROM oa_outbox
      WHERE status = 'pending'
      ORDER BY created_at, intent_key
    `).all() as Array<{
      intent_key: string;
      operation: string;
      project_id: number;
      payload_json: string;
      status: ProjectProgressOutboxIntent["status"];
      attempts: number;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      intentKey: row.intent_key,
      operation: row.operation,
      projectId: row.project_id,
      payload: decodePayload(row.payload_json),
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
  }

  markOutboxApplied(intentKey: string): void {
    this.database.prepare(`
      UPDATE oa_outbox
      SET status = 'applied', updated_at = ?
      WHERE intent_key = ? AND status = 'pending'
    `).run(new Date().toISOString(), intentKey);
  }

  getManagedSummary(
    projectId: number,
    summaryDate: string,
  ): ManagedProjectSummary | null {
    const row = this.database.prepare(`
      SELECT oa_summary_id, source_digest, applied_payload_json
      FROM project_daily_summary
      WHERE project_id = ? AND summary_date = ? AND managed = 1
    `).get(projectId, summaryDate) as {
      oa_summary_id: number | null;
      source_digest: string;
      applied_payload_json: string | null;
    } | undefined;
    if (!row || row.oa_summary_id === null || row.applied_payload_json === null) {
      return null;
    }
    const payload = decodeAppliedPayload(row.applied_payload_json);
    return {
      summaryId: row.oa_summary_id,
      sourceDigest: row.source_digest,
      appliedPayload: payload,
    };
  }

  markSummaryApplied(input: {
    projectId: number;
    summaryDate: string;
    summaryId: number;
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  }): void {
    const result = this.database.prepare(`
      UPDATE project_daily_summary
      SET oa_summary_id = ?, managed = 1,
          applied_payload_json = ?, updated_at = ?
      WHERE project_id = ? AND summary_date = ? AND source_digest = ?
    `).run(
      input.summaryId,
      JSON.stringify({
        summary: input.summary,
        aiConfidence: input.aiConfidence,
        aiNote: input.aiNote,
      }),
      new Date().toISOString(),
      input.projectId,
      input.summaryDate,
      input.sourceDigest,
    );
    if (result.changes !== 1) {
      throw new Error("无法标记 summary applied：本地 draft 不存在或 digest 已变化。");
    }
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_slot (
        business_slot TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        caught_up_by TEXT
      );

      CREATE TABLE IF NOT EXISTS project_state (
        project_id INTEGER PRIMARY KEY,
        last_applied_business_slot TEXT,
        oa_status TEXT,
        github_urls_hash TEXT,
        last_result TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repository_state (
        repository_id INTEGER PRIMARY KEY,
        canonical_full_name TEXT NOT NULL,
        last_activity_at TEXT,
        cursor_json TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_repository_state (
        project_id INTEGER NOT NULL,
        repository_id INTEGER NOT NULL,
        membership_epoch INTEGER NOT NULL,
        joined_at TEXT NOT NULL,
        last_consumed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, repository_id)
      );

      CREATE TABLE IF NOT EXISTS repository_ref (
        repository_id INTEGER NOT NULL,
        ref_name TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, ref_name)
      );

      CREATE TABLE IF NOT EXISTS processed_commit (
        repository_id INTEGER NOT NULL,
        sha TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        subject TEXT,
        summary_date TEXT NOT NULL,
        PRIMARY KEY(repository_id, sha)
      );

      CREATE TABLE IF NOT EXISTS project_daily_summary (
        project_id INTEGER NOT NULL,
        summary_date TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        draft_summary TEXT NOT NULL,
        draft_ai_confidence INTEGER NOT NULL,
        draft_ai_note TEXT NOT NULL,
        oa_summary_id INTEGER,
        managed INTEGER NOT NULL DEFAULT 0,
        adopted INTEGER NOT NULL DEFAULT 0,
        applied_payload_json TEXT,
        oa_updated_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, summary_date)
      );

      CREATE TABLE IF NOT EXISTS oa_outbox (
        intent_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        expected_version INTEGER,
        depends_on_intent_key TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'conflict', 'non_retryable')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mutation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_slot TEXT,
        project_id INTEGER NOT NULL,
        summary_id INTEGER,
        operation TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        compensation_status TEXT,
        created_at TEXT NOT NULL
      );

      PRAGMA user_version = 1;
    `);
  }
}

function decodePayload(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("outbox payload 不是对象。");
  }
  return parsed as Record<string, unknown>;
}

function decodeAppliedPayload(value: string): ManagedProjectSummary["appliedPayload"] {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("summary" in parsed) ||
    typeof parsed.summary !== "string" ||
    !("aiConfidence" in parsed) ||
    !Number.isInteger(parsed.aiConfidence) ||
    !("aiNote" in parsed) ||
    typeof parsed.aiNote !== "string"
  ) {
    throw new Error("applied summary payload 无效。");
  }
  return {
    summary: parsed.summary,
    aiConfidence: parsed.aiConfidence as number,
    aiNote: parsed.aiNote,
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数。`);
  }
}

function assertIsoDate(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} 必须是有效时间。`);
  }
}
