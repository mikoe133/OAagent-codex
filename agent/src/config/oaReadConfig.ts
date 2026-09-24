import path from "node:path";

export type OaReadConfig = {
  databaseUrl: string;
  metadataPath: string;
  stateDirectory: string;
  syncIntervalSeconds: number;
  queryTimeoutMs: number;
  maxRows: number;
  concurrency: number;
};

export function parseOaReadConfig(env: NodeJS.ProcessEnv, repoRoot: string): OaReadConfig | null {
  const databaseUrl = env.DATABASE_URL_READ?.trim();
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    if (u.protocol !== "mysql:" || !u.hostname || !u.username || !/^\/[a-zA-Z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error();
  } catch { throw new Error("DATABASE_URL_READ 必须是包含库名的 mysql:// 连接串（凭据需 URL 编码）。"); }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 必须在 ${min} 到 ${max} 之间。`);
    return n;
  };
  return {
    databaseUrl,
    metadataPath: path.resolve(env.OA_READ_METADATA_PATH || path.join(repoRoot, "agent/metadata/oa-read.json")),
    stateDirectory: path.resolve(env.OA_READ_STATE_DIRECTORY || path.join(repoRoot, ".context/oa-read")),
    syncIntervalSeconds: integer("OA_READ_SYNC_INTERVAL_SECONDS", 300, 60, 86400),
    queryTimeoutMs: integer("OA_READ_QUERY_TIMEOUT_MS", 10000, 100, 30000),
    maxRows: integer("OA_READ_MAX_ROWS", 200, 1, 1000),
    concurrency: integer("OA_READ_CONCURRENCY", 4, 1, 16),
  };
}
