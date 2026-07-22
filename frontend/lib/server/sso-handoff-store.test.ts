import assert from "node:assert/strict"
import test from "node:test"

import {
  claimSsoHandoff,
  consumePendingSsoHandoff,
  createSsoHandoff,
  getPendingSsoHandoff,
  resetSsoHandoffStoreForTests,
} from "./sso-handoff-store"

const user = { id: 1, email: "user@example.test" }

test("handoff codes are opaque and can only be claimed once", () => {
  resetSsoHandoffStoreForTests()
  const created = createSsoHandoff("secret-oa-token", user, 1_000)

  assert.doesNotMatch(created.code, /secret-oa-token/)
  const claimed = claimSsoHandoff(created.code, 1_001)
  assert.ok(claimed)
  assert.equal(claimSsoHandoff(created.code, 1_002), null)
  assert.equal(getPendingSsoHandoff(claimed.pendingId, 1_003)?.token, "secret-oa-token")
  assert.equal(consumePendingSsoHandoff(claimed.pendingId, 1_004)?.user.email, user.email)
  assert.equal(consumePendingSsoHandoff(claimed.pendingId, 1_005), null)
})

test("expired handoff codes cannot be claimed", () => {
  resetSsoHandoffStoreForTests()
  const originalTtl = process.env.OA_AGENT_SSO_TTL_SECONDS
  process.env.OA_AGENT_SSO_TTL_SECONDS = "10"

  try {
    const created = createSsoHandoff("secret-oa-token", user, 1_000)
    assert.equal(claimSsoHandoff(created.code, 11_000), null)
  } finally {
    restoreEnv("OA_AGENT_SSO_TTL_SECONDS", originalTtl)
  }
})

test("handoff codes are lost when the process store restarts", () => {
  resetSsoHandoffStoreForTests()
  const created = createSsoHandoff("secret-oa-token", user)

  resetSsoHandoffStoreForTests()

  assert.equal(claimSsoHandoff(created.code), null)
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
