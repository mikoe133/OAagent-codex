import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pendingConfirmationSchema, type ChatConfirmation, type ConfirmationDecision, type ConfirmationResponse } from '../../chat/confirmation.js';
import { ChatError } from '../../chat/chatScheduler.js';

export type AgentSession = {
  sessionId: string;
  threadId: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  pendingConfirmation?: ChatConfirmation;
  confirmationDecision?: ConfirmationDecision;
};

type SessionStoreFile = {
  sessions: StoredAgentSession[];
};

type StoredAgentSession = AgentSession & {
  ownerId: string | null;
  confirmationUserId?: string;
};

export class SessionStore {
  private readonly sessions = new Map<string, StoredAgentSession>();
  private readonly oaTokens = new Map<string, string>();
  private readonly oaUserIds = new Map<string, string>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get requestStorePath(): string { return `${this.filePath}.public-requests`; }

  async getOrCreate(sessionId: string): Promise<AgentSession> {
    await this.load();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return publicSession(existing);
    }

    const now = new Date().toISOString();
    const created: StoredAgentSession = {
      sessionId,
      threadId: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
      ownerId: null,
    };
    this.sessions.set(sessionId, created);
    await this.persist();
    return publicSession(created);
  }

  async updateThreadId(sessionId: string, threadId: string): Promise<void> {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`session 不存在:${sessionId}`);
    }
    session.threadId = threadId;
    session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async updateSummary(sessionId: string, summary: string | null): Promise<void> {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`session 不存在:${sessionId}`);
    }
    session.summary = summary;
    session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setConfirmation(sessionId: string, confirmation?: ChatConfirmation): Promise<void> {
    await this.getOrCreate(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (confirmation) {
      const userId = this.getOaUserId(sessionId);
      if (!userId) throw new ChatError(401, 'confirmation_identity_missing', '当前登录身份不可用');
      session.pendingConfirmation = confirmation;
      session.confirmationUserId = userId;
    } else {
      delete session.pendingConfirmation;
      delete session.confirmationUserId;
    }
    await this.persist();
  }

  async respondToConfirmation(sessionId: string, response: ConfirmationResponse): Promise<ConfirmationDecision> {
    await this.load();
    const session = this.sessions.get(sessionId);
    const pending = session?.pendingConfirmation;
    if (!session || !pending || pending.id !== response.id || session.confirmationUserId !== this.getOaUserId(sessionId) || Date.parse(pending.expiresAt) <= Date.now()) {
      throw new ChatError(409, 'confirmation_expired', '这项确认已失效，请重新提出操作请求');
    }
    // Consume synchronously before persisting, so simultaneous clicks cannot
    // both approve the same plan.
    delete session.pendingConfirmation;
    delete session.confirmationUserId;
    await this.persist();
    return { confirmation: pending, decision: response.decision };
  }

  async bindOaToken(
    sessionId: string,
    token: string,
    ownerId?: string,
    oaUserId?: string | null,
  ): Promise<boolean> {
    await this.getOrCreate(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (ownerId && session.ownerId && session.ownerId !== ownerId) {
      return false;
    }
    if (ownerId && !session.ownerId) {
      session.ownerId = ownerId;
      await this.persist();
    }
    this.oaTokens.set(sessionId, token);
    if (oaUserId) {
      this.oaUserIds.set(sessionId, oaUserId);
    } else if (oaUserId === null) {
      this.oaUserIds.delete(sessionId);
    }
    return true;
  }

  getOaToken(sessionId: string): string | null {
    return this.oaTokens.get(sessionId) ?? null;
  }

  getOaUserId(sessionId: string): string | null {
    return this.oaUserIds.get(sessionId) ?? null;
  }

  async list(): Promise<AgentSession[]> {
    await this.load();
    return sortSessions([...this.sessions.values()]).map(publicSession);
  }

  async listForOwner(ownerId: string): Promise<AgentSession[]> {
    await this.load();
    return sortSessions(
      [...this.sessions.values()].filter((session) => session.ownerId === ownerId),
    ).map(publicSession);
  }

  async remove(sessionId: string): Promise<boolean> {
    await this.load();
    const removed = this.sessions.delete(sessionId);
    this.oaTokens.delete(sessionId);
    this.oaUserIds.delete(sessionId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }

  async removeForOwner(sessionId: string, ownerId: string): Promise<boolean> {
    await this.load();
    if (this.sessions.get(sessionId)?.ownerId !== ownerId) {
      return false;
    }
    return this.remove(sessionId);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loadPromise ??= this.loadFromDisk().catch((error) => {
      this.loadPromise = undefined;
      throw error;
    });
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
      for (const value of parsed.sessions ?? []) {
        const session = normalizeStoredSession(value);
        if (session) {
          this.sessions.set(session.sessionId, session);
        }
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: SessionStoreFile = {
      sessions: [...this.sessions.values()].sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId),
      ),
    };
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
    await this.writeQueue;
  }
}

function normalizeStoredSession(value: unknown): StoredAgentSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const session = value as Partial<StoredAgentSession>;
  if (!(
    typeof session.sessionId === "string" &&
    (typeof session.threadId === "string" || session.threadId === null) &&
    (typeof session.summary === "string" || session.summary === null) &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string"
  )) {
    return null;
  }
  const pending = pendingConfirmationSchema.safeParse({ userId: session.confirmationUserId, confirmation: session.pendingConfirmation });
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    summary: session.summary,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ownerId: typeof session.ownerId === "string" ? session.ownerId : null,
    ...(pending.success ? { pendingConfirmation: pending.data.confirmation, confirmationUserId: pending.data.userId } : {}),
  };
}

function publicSession(session: StoredAgentSession): AgentSession {
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    summary: session.summary,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.pendingConfirmation ? { pendingConfirmation: session.pendingConfirmation } : {}),
  };
}

function sortSessions(sessions: StoredAgentSession[]): StoredAgentSession[] {
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
