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
  sessions: AgentSession[];
};

export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly oaTokens = new Map<string, string>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getOrCreate(sessionId: string): Promise<AgentSession> {
    await this.load();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const created: AgentSession = {
      sessionId,
      threadId: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, created);
    await this.persist();
    return created;
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

  async bindOaToken(sessionId: string, token: string): Promise<void> {
    await this.getOrCreate(sessionId);
    this.oaTokens.set(sessionId, token);
  }

  getOaToken(sessionId: string): string | null {
    return this.oaTokens.get(sessionId) ?? null;
  }

  async list(): Promise<AgentSession[]> {
    await this.load();
    return [...this.sessions.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
      for (const session of parsed.sessions ?? []) {
        if (isAgentSession(session)) {
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

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as Partial<AgentSession>;
  return (
    typeof session.sessionId === "string" &&
    (typeof session.threadId === "string" || session.threadId === null) &&
    (typeof session.summary === "string" || session.summary === null) &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
