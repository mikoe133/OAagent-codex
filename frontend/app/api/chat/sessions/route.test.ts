import assert from "node:assert/strict"
import test from "node:test"

import * as sessionsRoute from "./route"

type DeleteHandler = (request: Request) => Promise<Response>

test("GET sorts merged sessions from newest to oldest creation time", async () => {
  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  const originalAgentApiBaseUrl = process.env.AGENT_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.AGENT_API_BASE_URL = "https://agent.example.test"

  let agentAuthorization: string | null = null
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === "oa.example.test") {
      return Response.json({
        data: {
          items: [
            {
              id: 1,
              record: { agentSessionId: "older-created", title: "Older" },
              created_at: "2026-07-10T08:00:00.000Z",
              updated_at: "2026-07-14T08:00:00.000Z",
            },
            {
              id: 2,
              record: { agentSessionId: "newer-created", title: "Newer" },
              created_at: "2026-07-13T08:00:00.000Z",
              updated_at: "2026-07-13T08:00:00.000Z",
            },
          ],
          page: 1,
          size: 100,
          total: 2,
        },
      })
    }

    agentAuthorization = new Headers(init?.headers).get("authorization")
    return Response.json({ sessions: [] })
  }

  try {
    const response = await sessionsRoute.GET(
      new Request("http://localhost/api/chat/sessions", {
        headers: { cookie: "sessionid=test-session-token" },
      }),
    )
    const payload = (await response.json()) as { sessions: Array<{ sessionId: string }> }

    assert.equal(response.status, 200)
    assert.deepEqual(
      payload.sessions.map((session) => session.sessionId),
      ["newer-created", "older-created"],
    )
    assert.equal(agentAuthorization, "Bearer test-session-token")
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
    restoreEnv("AGENT_API_BASE_URL", originalAgentApiBaseUrl)
  }
})

test("DELETE removes both the OA record and agent session", async () => {
  const deleteHandler = (sessionsRoute as unknown as { DELETE?: DeleteHandler }).DELETE
  assert.equal(typeof deleteHandler, "function")
  if (!deleteHandler) {
    return
  }

  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  const originalAgentApiBaseUrl = process.env.AGENT_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.AGENT_API_BASE_URL = "https://agent.example.test"
  const calls: Array<{ method: string; url: URL; headers: Headers }> = []

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: init?.method || "GET", url, headers: new Headers(init?.headers) })
    return Response.json({ deleted: true })
  }

  try {
    const response = await deleteHandler(
      new Request("http://localhost/api/chat/sessions", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({ sessionId: "web-session-1", recordId: 41 }),
      }),
    )

    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.method, "DELETE")
    assert.equal(calls[0]?.url.hostname, "oa.example.test")
    assert.equal(calls[0]?.url.pathname, "/copilot/record")
    assert.equal(calls[0]?.url.searchParams.get("record_id"), "41")
    assert.equal(calls[1]?.method, "DELETE")
    assert.equal(calls[1]?.url.href, "https://agent.example.test/v1/sessions/web-session-1")
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer test-session-token")
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
    restoreEnv("AGENT_API_BASE_URL", originalAgentApiBaseUrl)
  }
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
