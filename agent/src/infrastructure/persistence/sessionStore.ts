import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentSession = {
  sessionId: string;
  threadId: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

type SessionStoreFile = {
  sessions: StoredAgentSession[];
};

type StoredAgentSession = AgentSession & {
  ownerId: string | null;
};

export class SessionStore {
  private readonly sessions = new Map<string, StoredAgentSession>();
  private readonly oaTokens = new Map<string, string>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

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

  async bindOaToken(
    sessionId: string,
    token: string,
    ownerId?: string,
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
    return true;
  }

  getOaToken(sessionId: string): string | null {
    return this.oaTokens.get(sessionId) ?? null;
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
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    summary: session.summary,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ownerId: typeof session.ownerId === "string" ? session.ownerId : null,
  };
}

function publicSession(session: StoredAgentSession): AgentSession {
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    summary: session.summary,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
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
