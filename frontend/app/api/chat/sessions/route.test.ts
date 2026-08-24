import assert from "node:assert/strict"
import test from "node:test"

import * as sessionsRoute from "./route"

type DeleteHandler = (request: Request) => Promise<Response>

test("GET sorts merged sessions from newest to oldest creation time", async () => {
  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  const originalAgentApiBaseUrl = process.env.AGENT_API_BASE_URL
  const signedToken = "test-session-token=="
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.AGENT_API_BASE_URL = "https://agent.example.test"

  let agentAuthorization: string | null = null
  let oaCookie: string | null = null
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === "oa.example.test") {
      oaCookie = new Headers(init?.headers).get("cookie")
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
        headers: { cookie: `sessionid=${encodeURIComponent(signedToken)}` },
      }),
    )
    const payload = (await response.json()) as { sessions: Array<{ sessionId: string }> }

    assert.equal(response.status, 200)
    assert.deepEqual(
      payload.sessions.map((session) => session.sessionId),
      ["newer-created", "older-created"],
    )
    assert.equal(agentAuthorization, `Bearer ${signedToken}`)
    assert.equal(oaCookie, `sessionid=${signedToken}`)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
    restoreEnv("AGENT_API_BASE_URL", originalAgentApiBaseUrl)
  }
})

test("GET keeps original creation order and deduplicates replacement records", async () => {
  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  const originalAgentApiBaseUrl = process.env.AGENT_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.AGENT_API_BASE_URL = "https://agent.example.test"

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === "oa.example.test") {
      return Response.json({
        data: {
          items: [
            {
              id: 3,
              record: {
                agentSessionId: "replaced-session",
                title: "Replaced",
                createdAt: "2026-07-10T08:00:00.000Z",
              },
              created_at: "2026-07-16T08:00:00.000Z",
              updated_at: "2026-07-16T08:00:00.000Z",
            },
            {
              id: 2,
              record: {
                agentSessionId: "newer-session",
                title: "Newer",
                createdAt: "2026-07-13T08:00:00.000Z",
              },
              created_at: "2026-07-13T08:00:00.000Z",
              updated_at: "2026-07-13T08:00:00.000Z",
            },
            {
              id: 1,
              record: {
                agentSessionId: "replaced-session",
                title: "Stale replacement",
                createdAt: "2026-07-10T08:00:00.000Z",
              },
              created_at: "2026-07-10T08:00:00.000Z",
              updated_at: "2026-07-10T08:00:00.000Z",
            },
          ],
          page: 1,
          size: 100,
          total: 3,
        },
      })
    }

    return Response.json({ sessions: [] })
  }

  try {
    const response = await sessionsRoute.GET(
      new Request("http://localhost/api/chat/sessions", {
        headers: { cookie: "sessionid=test-session-token" },
      }),
    )
    const payload = (await response.json()) as {
      sessions: Array<{ sessionId: string; recordId?: string | number; createdAt: string }>
    }

    assert.equal(response.status, 200)
    assert.deepEqual(
      payload.sessions.map((session) => session.sessionId),
      ["newer-session", "replaced-session"],
    )
    assert.equal(payload.sessions[1]?.recordId, 3)
    assert.equal(payload.sessions[1]?.createdAt, "2026-07-10T08:00:00.000Z")
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
    restoreEnv("AGENT_API_BASE_URL", originalAgentApiBaseUrl)
  }
})

test("PATCH persists the immutable creation time from generated session ids", async () => {
  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"

  const createdAt = "2026-07-10T08:00:00.000Z"
  const sessionId = `web-${Date.parse(createdAt)}-abcdefg`
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Done",
      createdAt,
      durationMs: 12_340,
      traceMessages: [
        {
          id: "trace-message-1",
          content: "Inspecting the project records.",
          afterStepId: "tool-1",
        },
      ],
      knowledgeSources: [
        {
          title: "生产部署手册",
          description: "发布前请确认数据库迁移。",
          originalContent: "发布前请确认数据库迁移、镜像版本和部署窗口。",
          sourceUrl: "https://oa-kb.example.test/wiki/page-1",
        },
      ],
      status: "completed",
    },
  ]
  const savedRecords: Array<Record<string, unknown>> = []

  globalThis.fetch = async (_input, init) => {
    const savedRecord = JSON.parse(String(init?.body)) as Record<string, unknown>
    savedRecords.push(savedRecord)
    return Response.json({
      data: {
        id: 9,
        record: savedRecord,
        created_at: "2026-07-17T08:00:00.000Z",
        updated_at: "2026-07-17T08:00:00.000Z",
      },
    })
  }

  try {
    const response = await sessionsRoute.PATCH(
      new Request("http://localhost/api/chat/sessions", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({ sessionId, recordId: 9, messages }),
      }),
    )
    const payload = (await response.json()) as { session: { createdAt: string } }

    assert.equal(response.status, 200)
    assert.equal(savedRecords[0]?.createdAt, createdAt)
    assert.deepEqual(savedRecords[0]?.messages, messages)
    assert.equal(payload.session.createdAt, createdAt)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
  }
})

test("PATCH fallback preserves creation time when replacing a legacy OA record", async () => {
  const originalFetch = globalThis.fetch
  const originalOaApiBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"

  const createdAt = "2026-07-10T08:00:00.000Z"
  const methods: string[] = []
  const replacementRecords: Array<Record<string, unknown>> = []

  globalThis.fetch = async (_input, init) => {
    const method = init?.method || "GET"
    methods.push(method)

    if (method === "PATCH") {
      return new Response("Method Not Allowed", { status: 405 })
    }
    if (method === "GET") {
      return Response.json({
        data: {
          id: 9,
          record: { agentSessionId: "legacy-session", title: "Legacy" },
          created_at: createdAt,
          updated_at: "2026-07-12T08:00:00.000Z",
        },
      })
    }
    if (method === "POST") {
      const replacementRecord = JSON.parse(String(init?.body)) as Record<string, unknown>
      replacementRecords.push(replacementRecord)
      return Response.json({
        data: {
          id: 10,
          record: replacementRecord,
          created_at: "2026-07-17T08:00:00.000Z",
          updated_at: "2026-07-17T08:00:00.000Z",
        },
      })
    }

    return Response.json({ data: { record_id: 9 } })
  }

  try {
    const response = await sessionsRoute.PATCH(
      new Request("http://localhost/api/chat/sessions", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({ sessionId: "legacy-session", recordId: 9, messages: [] }),
      }),
    )
    const payload = (await response.json()) as { session: { createdAt: string; recordId: number } }

    assert.equal(response.status, 200)
    assert.deepEqual(methods, ["PATCH", "GET", "POST", "DELETE"])
    assert.equal(replacementRecords[0]?.createdAt, createdAt)
    assert.equal(payload.session.createdAt, createdAt)
    assert.equal(payload.session.recordId, 10)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalOaApiBaseUrl)
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
