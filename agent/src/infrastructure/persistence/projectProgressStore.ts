import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CachedRepositorySummary,
  RepositorySummaryCache,
} from "../../domain/repositorySummaryCache.js";
import type { ProjectProgressCommit } from "../../domain/projectProgress.js";

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

export type AutomationClaimIdentityInput = {
  workerInstance: string;
  supportedJobTypes: string[];
  leaseSeconds: number;
};

export type AutomationClaimIdentity = {
  claimRequestId: string;
  requestDigest: string;
};

export type AutomationTraceSpoolEntry = {
  runId: string;
  eventKey: string;
  payload: Record<string, unknown>;
  terminal: boolean;
};

const AUTOMATION_TRACE_SPOOL_CAPACITY = 100;

export class ProjectProgressStore implements RepositorySummaryCache {
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

  getOrCreateAutomationClaimIdentity(
    input: AutomationClaimIdentityInput,
  ): AutomationClaimIdentity {
    const normalized = normalizeClaimIdentityInput(input);
    const requestDigest = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database.prepare(`
        SELECT claim_request_id, worker_instance, request_digest
        FROM automation_claim_identity
        WHERE identity_slot = 1
      `).get() as {
        claim_request_id: string;
        worker_instance: string;
        request_digest: string;
      } | undefined;
      if (row) {
        if (
          row.worker_instance !== normalized.worker_instance ||
          row.request_digest !== requestDigest
        ) {
          throw new Error(
            "active claim identity 与当前 worker 或请求摘要不匹配。",
          );
        }
        this.database.exec("COMMIT;");
        return {
          claimRequestId: row.claim_request_id,
          requestDigest: row.request_digest,
        };
      }

      const claimRequestId = randomUUID();
      this.database.prepare(`
        INSERT INTO automation_claim_identity (
          identity_slot, claim_request_id, worker_instance,
          request_digest, supported_job_types_json, lease_seconds, created_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `).run(
        claimRequestId,
        normalized.worker_instance,
        requestDigest,
        JSON.stringify(normalized.supported_job_types),
        normalized.lease_seconds,
        new Date().toISOString(),
      );
      this.database.exec("COMMIT;");
      return { claimRequestId, requestDigest };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  clearAutomationClaimIdentity(claimRequestId: string): void {
    if (!claimRequestId.trim()) {
      throw new Error("claimRequestId 不能为空。");
    }
    this.database.prepare(`
      DELETE FROM automation_claim_identity
      WHERE identity_slot = 1 AND claim_request_id = ?
    `).run(claimRequestId);
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

  saveProcessedCommits(
    commits: ProjectProgressCommit[],
    summaryDate: string,
    firstSeenAt: string,
  ): void {
    assertDate(summaryDate, "summaryDate");
    assertIsoDate(firstSeenAt, "firstSeenAt");
    const statement = this.database.prepare(`
      INSERT INTO processed_commit (
        repository_id, repository_full_name, sha, committed_at, first_seen_at,
        subject, summary_date, author_login, author_name, author_email,
        committer_login, committer_name, committer_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, sha) DO UPDATE SET
        repository_full_name = excluded.repository_full_name,
        committed_at = excluded.committed_at,
        subject = excluded.subject,
        summary_date = excluded.summary_date,
        author_login = excluded.author_login,
        author_name = excluded.author_name,
        author_email = excluded.author_email,
        committer_login = excluded.committer_login,
        committer_name = excluded.committer_name,
        committer_email = excluded.committer_email
    `);
    for (const commit of commits) {
      assertPositiveInteger(commit.repositoryId, "repositoryId");
      assertNonEmptyString(commit.repositoryFullName, "repositoryFullName");
      assertNonEmptyString(commit.sha, "sha");
      assertIsoDate(commit.committedAt, "committedAt");
      statement.run(
        commit.repositoryId,
        commit.repositoryFullName,
        commit.sha,
        commit.committedAt,
        firstSeenAt,
        commit.subject,
        summaryDate,
        commit.authorLogin ?? null,
        commit.authorName ?? null,
        commit.authorEmail ?? null,
        commit.committerLogin ?? null,
        commit.committerName ?? null,
        commit.committerEmail ?? null,
      );
    }
  }

  getProcessedCommits(
    summaryDate: string,
    repositoryFullNames: string[],
  ): ProjectProgressCommit[] {
    assertDate(summaryDate, "summaryDate");
    const repositories = [...new Set(
      repositoryFullNames.map((repository) => repository.trim().toLowerCase()).filter(Boolean),
    )];
    if (repositories.length === 0) {
      return [];
    }
    const placeholders = repositories.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT repository_id, repository_full_name, sha, committed_at, subject,
             author_login, author_name, author_email,
             committer_login, committer_name, committer_email
      FROM processed_commit
      WHERE summary_date = ? AND LOWER(repository_full_name) IN (${placeholders})
      ORDER BY committed_at, repository_id, sha
    `).all(summaryDate, ...repositories) as Array<{
      repository_id: number;
      repository_full_name: string;
      sha: string;
      committed_at: string;
      subject: string | null;
      author_login: string | null;
      author_name: string | null;
      author_email: string | null;
      committer_login: string | null;
      committer_name: string | null;
      committer_email: string | null;
    }>;
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      repositoryFullName: row.repository_full_name,
      sha: row.sha,
      committedAt: row.committed_at,
      subject: row.subject ?? "",
      ...(row.author_login === null ? {} : { authorLogin: row.author_login }),
      ...(row.author_name === null ? {} : { authorName: row.author_name }),
      ...(row.author_email === null ? {} : { authorEmail: row.author_email }),
      ...(row.committer_login === null ? {} : { committerLogin: row.committer_login }),
      ...(row.committer_name === null ? {} : { committerName: row.committer_name }),
      ...(row.committer_email === null ? {} : { committerEmail: row.committer_email }),
    }));
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

  getRepositorySummaryCache(identityDigest: string): CachedRepositorySummary | null {
    assertSha256Digest(identityDigest, "identityDigest");
    const row = this.database.prepare(`
      SELECT summary, limitations_json
      FROM repository_summary_cache
      WHERE identity_digest = ?
    `).get(identityDigest) as {
      summary: string;
      limitations_json: string;
    } | undefined;
    return row
      ? {
          summary: row.summary,
          limitations: decodeLimitations(row.limitations_json),
        }
      : null;
  }

  putRepositorySummaryCache(input: {
    identityDigest: string;
    evidenceDigest: string;
    summary: string;
    limitations: string[];
  }): void {
    assertSha256Digest(input.identityDigest, "identityDigest");
    assertSha256Digest(input.evidenceDigest, "evidenceDigest");
    assertNonEmptyString(input.summary, "summary");
    if (!input.limitations.every((item) => typeof item === "string")) {
      throw new Error("limitations 必须是字符串数组。");
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO repository_summary_cache (
        identity_digest, evidence_digest, summary, limitations_json,
        created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_digest) DO UPDATE SET
        evidence_digest = excluded.evidence_digest,
        summary = excluded.summary,
        limitations_json = excluded.limitations_json,
        last_used_at = excluded.last_used_at
    `).run(
      input.identityDigest,
      input.evidenceDigest,
      input.summary,
      JSON.stringify(input.limitations),
      now,
      now,
    );
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

  upsertAutomationTraceSpool(input: AutomationTraceSpoolEntry): boolean {
    assertNonEmptyString(input.runId, "runId");
    assertNonEmptyString(input.eventKey, "eventKey");
    if (input.runId.length > 255 || input.eventKey.length > 200) {
      throw new Error("trace spool runId/eventKey 超过长度上限。");
    }
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare(`
        SELECT terminal
        FROM automation_trace_spool
        WHERE run_id = ? AND event_key = ?
      `).get(input.runId, input.eventKey) as { terminal: number } | undefined;
      if (!existing) {
        const row = this.database.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_trace_spool
          WHERE run_id = ?
        `).get(input.runId) as { count: number };
        if (row.count >= AUTOMATION_TRACE_SPOOL_CAPACITY) {
          if (!input.terminal) {
            this.database.exec("COMMIT;");
            return false;
          }
          const evicted = this.database.prepare(`
            DELETE FROM automation_trace_spool
            WHERE rowid = (
              SELECT rowid
              FROM automation_trace_spool
              WHERE run_id = ? AND terminal = 0
              ORDER BY created_at, event_key
              LIMIT 1
            )
          `).run(input.runId);
          if (evicted.changes !== 1) {
            this.database.exec("COMMIT;");
            return false;
          }
        }
      }
      this.database.prepare(`
        INSERT INTO automation_trace_spool (
          run_id, event_key, payload_json, terminal, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, event_key) DO UPDATE SET
          payload_json = excluded.payload_json,
          terminal = excluded.terminal,
          updated_at = excluded.updated_at
        WHERE automation_trace_spool.terminal = 0 OR excluded.terminal = 1
      `).run(
        input.runId,
        input.eventKey,
        JSON.stringify(input.payload),
        input.terminal ? 1 : 0,
        now,
        now,
      );
      this.database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  listAutomationTraceSpool(runId: string): AutomationTraceSpoolEntry[] {
    assertNonEmptyString(runId, "runId");
    const rows = this.database.prepare(`
      SELECT run_id, event_key, payload_json, terminal
      FROM automation_trace_spool
      WHERE run_id = ?
      ORDER BY created_at, event_key
    `).all(runId) as Array<{
      run_id: string;
      event_key: string;
      payload_json: string;
      terminal: number;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      eventKey: row.event_key,
      payload: decodePayload(row.payload_json),
      terminal: row.terminal === 1,
    }));
  }

  deleteAutomationTraceSpool(runId: string, eventKey: string): void {
    assertNonEmptyString(runId, "runId");
    assertNonEmptyString(eventKey, "eventKey");
    this.database.prepare(`
      DELETE FROM automation_trace_spool
      WHERE run_id = ? AND event_key = ?
    `).run(runId, eventKey);
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

      CREATE TABLE IF NOT EXISTS automation_claim_identity (
        identity_slot INTEGER PRIMARY KEY CHECK(identity_slot = 1),
        claim_request_id TEXT NOT NULL UNIQUE,
        worker_instance TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        supported_job_types_json TEXT NOT NULL,
        lease_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS automation_trace_spool (
        run_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, event_key)
      );

      CREATE TABLE IF NOT EXISTS repository_summary_cache (
        identity_digest TEXT PRIMARY KEY,
        evidence_digest TEXT NOT NULL,
        summary TEXT NOT NULL,
        limitations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );

      PRAGMA user_version = 4;
    `);
    this.ensureProcessedCommitColumns();
  }

  private ensureProcessedCommitColumns(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(processed_commit)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    for (const column of [
      "repository_full_name",
      "author_login",
      "author_name",
      "author_email",
      "committer_login",
      "committer_name",
      "committer_email",
    ]) {
      if (!columns.has(column)) {
        this.database.exec(`ALTER TABLE processed_commit ADD COLUMN ${column} TEXT`);
      }
    }
  }
}

function normalizeClaimIdentityInput(input: AutomationClaimIdentityInput): {
  worker_instance: string;
  supported_job_types: string[];
  lease_seconds: number;
} {
  const workerInstance = input.workerInstance.trim();
  if (!workerInstance) {
    throw new Error("workerInstance 不能为空。");
  }
  assertPositiveInteger(input.leaseSeconds, "leaseSeconds");
  const supportedJobTypes = [...new Set(
    input.supportedJobTypes.map((jobType) => jobType.trim()),
  )].sort();
  if (
    supportedJobTypes.length === 0 ||
    supportedJobTypes.some((jobType) => jobType.length === 0)
  ) {
    throw new Error("supportedJobTypes 必须包含非空任务类型。");
  }
  return {
    worker_instance: workerInstance,
    supported_job_types: supportedJobTypes,
    lease_seconds: input.leaseSeconds,
  };
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

function decodeLimitations(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("repository summary cache limitations 无效。");
  }
  return parsed;
}

function assertSha256Digest(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} 必须是 SHA-256 hex。`);
  }
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

function assertDate(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} 必须是 YYYY-MM-DD。`);
  }
}

function assertNonEmptyString(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} 不能为空。`);
  }
}
