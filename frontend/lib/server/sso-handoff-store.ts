import { randomBytes } from "node:crypto"

import type { OaSessionUser } from "@/lib/server/oa-session"
import { readServerEnvValue } from "@/lib/server/server-env"

export type SsoHandoff = {
  token: string
  user: OaSessionUser
  expiresAt: number
}

type SsoStoreState = {
  handoffs: Map<string, SsoHandoff>
  pending: Map<string, SsoHandoff>
}

const DEFAULT_TTL_SECONDS = 60
const MIN_TTL_SECONDS = 10
const MAX_TTL_SECONDS = 300

const globalSsoStore = globalThis as typeof globalThis & {
  __oaAgentSsoStore?: SsoStoreState
}

function getStore(): SsoStoreState {
  globalSsoStore.__oaAgentSsoStore ??= {
    handoffs: new Map(),
    pending: new Map(),
  }
  return globalSsoStore.__oaAgentSsoStore
}

export function createSsoHandoff(
  token: string,
  user: OaSessionUser,
  now = Date.now(),
): { code: string; expiresAt: string } {
  clearExpiredSsoEntries(now)
  const code = createOpaqueId()
  const expiresAt = now + getSsoTtlSeconds() * 1_000
  getStore().handoffs.set(code, { token, user, expiresAt })
  return { code, expiresAt: new Date(expiresAt).toISOString() }
}

export function claimSsoHandoff(
  code: string,
  now = Date.now(),
): { pendingId: string; handoff: SsoHandoff } | null {
  clearExpiredSsoEntries(now)
  const store = getStore()
  const handoff = store.handoffs.get(code)
  if (!handoff) {
    return null
  }

  store.handoffs.delete(code)
  const pendingId = createOpaqueId()
  store.pending.set(pendingId, handoff)
  return { pendingId, handoff }
}

export function getPendingSsoHandoff(pendingId: string, now = Date.now()): SsoHandoff | null {
  clearExpiredSsoEntries(now)
  return getStore().pending.get(pendingId) ?? null
}

export function consumePendingSsoHandoff(
  pendingId: string,
  now = Date.now(),
): SsoHandoff | null {
  clearExpiredSsoEntries(now)
  const store = getStore()
  const handoff = store.pending.get(pendingId)
  if (!handoff) {
    return null
  }
  store.pending.delete(pendingId)
  return handoff
}

export function discardPendingSsoHandoff(pendingId: string): void {
  getStore().pending.delete(pendingId)
}

export function getSsoTtlSeconds(): number {
  const configured = Number.parseInt(readServerEnvValue("OA_AGENT_SSO_TTL_SECONDS") || "", 10)
  if (!Number.isFinite(configured)) {
    return DEFAULT_TTL_SECONDS
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, configured))
}

export function resetSsoHandoffStoreForTests(): void {
  globalSsoStore.__oaAgentSsoStore = {
    handoffs: new Map(),
    pending: new Map(),
  }
}

function clearExpiredSsoEntries(now: number): void {
  const store = getStore()
  for (const [code, handoff] of store.handoffs) {
    if (handoff.expiresAt <= now) {
      store.handoffs.delete(code)
    }
  }
  for (const [pendingId, handoff] of store.pending) {
    if (handoff.expiresAt <= now) {
      store.pending.delete(pendingId)
    }
  }
}

function createOpaqueId(): string {
  return randomBytes(32).toString("base64url")
}
