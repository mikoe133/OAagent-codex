import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { POST as createHandoff } from "./handoff/route"
import { POST as decide } from "./decision/route"
import { GET as callback } from "../../../auth/sso/callback/route"
import {
  claimSsoHandoff,
  createSsoHandoff as seedHandoff,
  getPendingSsoHandoff,
  resetSsoHandoffStoreForTests,
} from "@/lib/server/sso-handoff-store"

const SHARED_SECRET = "test-shared-secret"
const INCOMING_TOKEN = "incoming-oa-token"
const CURRENT_TOKEN = "current-oa-token"

test("handoff rejects an incorrect service secret", async () => {
  const originalSecret = process.env.OA_AGENT_SSO_SHARED_SECRET
  process.env.OA_AGENT_SSO_SHARED_SECRET = SHARED_SECRET

  try {
    const response = await createHandoff(
      new Request("http://localhost/api/auth/sso/handoff", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ oaToken: INCOMING_TOKEN }),
      }),
    )
    assert.equal(response.status, 401)
  } finally {
    restoreEnv("OA_AGENT_SSO_SHARED_SECRET", originalSecret)
  }
})

test("valid handoff returns an opaque code without exposing the OA token", async () => {
  resetSsoHandoffStoreForTests()
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ code: 200, success: true, data: { id: 7, email: "user@example.test" } })

  try {
    const response = await createHandoff(
      new Request("http://localhost/api/auth/sso/handoff", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ oaToken: INCOMING_TOKEN }),
      }),
    )
    const text = await response.text()
    const payload = JSON.parse(text) as { code: string }

    assert.equal(response.status, 201)
    assert.doesNotMatch(text, new RegExp(INCOMING_TOKEN))
    assert.match(payload.code, /^[A-Za-z0-9_-]{40,128}$/)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("handoff rejects an invalid OA token", async () => {
  resetSsoHandoffStoreForTests()
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ detail: "invalid session" }, { status: 401 })

  try {
    const response = await createHandoff(
      new Request("http://localhost/api/auth/sso/handoff", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ oaToken: INCOMING_TOKEN }),
      }),
    )

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "invalid_token" })
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("callback automatically activates the incoming account when Agent is logged out", async () => {
  resetSsoHandoffStoreForTests()
  const { code } = seedHandoff(INCOMING_TOKEN, { id: 1, email: "incoming@example.test" })

  const response = await callback(
    new NextRequest(`http://localhost/auth/sso/callback?code=${encodeURIComponent(code)}`),
  )

  assert.equal(response.status, 307)
  assert.equal(new URL(response.headers.get("location") || "").pathname, "/auth/sso/complete")
  const setCookie = response.headers.get("set-cookie") || ""
  assert.match(setCookie, /sessionid=incoming-oa-token/)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /Secure/i)
  assert.match(setCookie, /SameSite=Lax/i)

  const replay = await callback(
    new NextRequest(`http://localhost/auth/sso/callback?code=${encodeURIComponent(code)}`),
  )
  assert.equal(new URL(replay.headers.get("location") || "").searchParams.get("sso_error"), "invalid_or_expired")
})

test("callback ignores an incoming token for the same account", async () => {
  resetSsoHandoffStoreForTests()
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  const { code } = seedHandoff(INCOMING_TOKEN, { id: 1, email: "same@example.test" })
  globalThis.fetch = async () =>
    Response.json({ code: 200, success: true, data: { id: 1, email: "same@example.test" } })

  try {
    const response = await callback(
      new NextRequest(`http://localhost/auth/sso/callback?code=${encodeURIComponent(code)}`, {
        headers: { cookie: `sessionid=${CURRENT_TOKEN}` },
      }),
    )
    assert.equal(new URL(response.headers.get("location") || "").pathname, "/chat")
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /sessionid=incoming-oa-token/)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("different accounts require a choice and use-oa replaces the session", async () => {
  resetSsoHandoffStoreForTests()
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  const { code } = seedHandoff(INCOMING_TOKEN, { id: 2, email: "incoming@example.test" })
  globalThis.fetch = async (_input, init) => {
    const cookie = new Headers(init?.headers).get("cookie") || ""
    const email = cookie.includes(INCOMING_TOKEN)
      ? "incoming@example.test"
      : "current@example.test"
    return Response.json({ code: 200, success: true, data: { id: email, email } })
  }

  try {
    const callbackResponse = await callback(
      new NextRequest(`http://localhost/auth/sso/callback?code=${encodeURIComponent(code)}`, {
        headers: { cookie: `sessionid=${CURRENT_TOKEN}` },
      }),
    )
    assert.equal(new URL(callbackResponse.headers.get("location") || "").pathname, "/auth/sso/choose")
    const pendingCookie = extractCookie(callbackResponse.headers.get("set-cookie") || "", "oa-agent-sso-pending")
    assert.ok(pendingCookie)

    const decisionResponse = await decide(
      new NextRequest("http://localhost/api/auth/sso/decision", {
        method: "POST",
        headers: {
          cookie: `oa-agent-sso-pending=${pendingCookie}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "use-oa" }),
      }),
    )
    assert.equal(decisionResponse.status, 303)
    assert.equal(new URL(decisionResponse.headers.get("location") || "").pathname, "/auth/sso/complete")
    assert.match(decisionResponse.headers.get("set-cookie") || "", /sessionid=incoming-oa-token/)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("keep-current discards the pending account without replacing the session", async () => {
  resetSsoHandoffStoreForTests()
  const created = seedHandoff(INCOMING_TOKEN, { id: 2, email: "incoming@example.test" })
  const claimed = claimSsoHandoff(created.code)
  assert.ok(claimed)

  const response = await decide(
    new NextRequest("http://localhost/api/auth/sso/decision", {
      method: "POST",
      headers: {
        cookie: `oa-agent-sso-pending=${claimed.pendingId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "keep-current" }),
    }),
  )

  assert.equal(new URL(response.headers.get("location") || "").pathname, "/chat")
  assert.doesNotMatch(response.headers.get("set-cookie") || "", /sessionid=incoming-oa-token/)
})

test("use-oa fails closed if the incoming token changes account before the decision", async () => {
  resetSsoHandoffStoreForTests()
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  const created = seedHandoff(INCOMING_TOKEN, { id: 2, email: "incoming@example.test" })
  const claimed = claimSsoHandoff(created.code)
  assert.ok(claimed)
  globalThis.fetch = async () =>
    Response.json({
      code: 200,
      success: true,
      data: { id: 3, email: "different@example.test" },
    })

  try {
    const response = await decide(
      new NextRequest("http://localhost/api/auth/sso/decision", {
        method: "POST",
        headers: {
          cookie: `oa-agent-sso-pending=${claimed.pendingId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "use-oa" }),
      }),
    )

    assert.equal(
      new URL(response.headers.get("location") || "").searchParams.get("sso_error"),
      "incoming_session_invalid",
    )
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /sessionid=incoming-oa-token/)
    assert.equal(getPendingSsoHandoff(claimed.pendingId), null)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

function configureAuthEnvironment(): () => void {
  const originalSecret = process.env.OA_AGENT_SSO_SHARED_SECRET
  const originalBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_AGENT_SSO_SHARED_SECRET = SHARED_SECRET
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  return () => {
    restoreEnv("OA_AGENT_SSO_SHARED_SECRET", originalSecret)
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
  }
}

function extractCookie(header: string, name: string): string | null {
  return header.match(new RegExp(`${name}=([^;,]+)`))?.[1] || null
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
