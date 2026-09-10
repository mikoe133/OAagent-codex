import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../../config/config.js";

const ACCESS_TTL_MS = 30 * 60_000;
const CONFIRMATION_TTL_MS = 10 * 60_000;
type PendingWrite = { key: string; code: string; expiresAt: number; approved: boolean };
type ChatAccess = { tokenDigest: string; isAdmin: boolean; expiresAt: number; pending?: PendingWrite };
const sessions = new Map<string, ChatAccess>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// /admin/permissions returns the permission catalog, but its router requires admin_user.
// A successful authenticated response proves access; catalog entries alone do not.
export async function readOaAdminPermission(config: AppConfig, token: string | null): Promise<boolean> {
  if (!config.oaApiBaseUrl || !token) return false;
  try {
    const headers = new Headers({ accept: "application/json", "cache-control": "no-store" });
    const prefix = config.oaApiTokenPrefix;
    headers.set(config.oaApiTokenHeader, prefix ? `${prefix}${/[=\s]$/.test(prefix) ? "" : " "}${token}` : token);
    const response = await fetch(new URL("/admin/permissions", config.oaApiBaseUrl), {
      headers, signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown> | null;
    return body?.success === true && body?.code === 200 && Array.isArray(body?.data);
  } catch {
    return false;
  }
}

// Only the authenticated chat ingress supplies message, never a model tool parameter.
export async function prepareOaChatAccess(config: AppConfig, sessionId: string, token: string | null, message: string): Promise<boolean> {
  const now = Date.now();
  for (const [key, access] of sessions) if (access.expiresAt <= now) sessions.delete(key);
  const previous = sessions.get(sessionId);
  sessions.delete(sessionId);
  const isAdmin = await readOaAdminPermission(config, token);
  if (!token) return false;
  const tokenDigest = digest(token);
  const pending = isAdmin && previous?.tokenDigest === tokenDigest && previous.pending &&
    previous.pending.expiresAt > now ? previous.pending : undefined;
  if (pending) {
    pending.approved = message.trim() === `确认操作 ${pending.code}`;
    if (!pending.approved) {
      // A different request or cancellation invalidates the previous proposed write.
      sessions.set(sessionId, { tokenDigest, isAdmin, expiresAt: now + ACCESS_TTL_MS });
      return isAdmin;
    }
  }
  sessions.set(sessionId, { tokenDigest, isAdmin, expiresAt: now + ACCESS_TTL_MS, pending });
  return isAdmin;
}

export function hasOaAdminAccess(sessionId: string | null, token: string): boolean {
  const access = sessionId ? sessions.get(sessionId) : undefined;
  return !!access && access.expiresAt > Date.now() && access.isAdmin && access.tokenDigest === digest(token);
}

export function finishOaChatAccessTurn(sessionId: string): void {
  const access = sessions.get(sessionId);
  if (access?.pending) access.pending.approved = false;
}

export function authorizeAdminWrite(sessionId: string, token: string, request: unknown): { allowed: true } | { allowed: false; confirmationReply: string } {
  const access = sessions.get(sessionId);
  if (!access || !hasOaAdminAccess(sessionId, token)) throw new Error("Admin access is not active");
  const key = digest(JSON.stringify(canonicalize(request)));
  const pending = access.pending;
  if (pending?.key === key && pending.expiresAt > Date.now()) {
    if (pending.approved) {
      delete access.pending; // Consume before the network request; retries require new consent.
      return { allowed: true };
    }
    return { allowed: false, confirmationReply: `确认操作 ${pending.code}` };
  }
  const code = randomBytes(6).toString("hex");
  access.pending = { key, code, expiresAt: Date.now() + CONFIRMATION_TTL_MS, approved: false };
  return { allowed: false, confirmationReply: `确认操作 ${code}` };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
