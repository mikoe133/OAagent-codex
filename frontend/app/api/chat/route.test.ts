import assert from "node:assert/strict"
import test from "node:test"

import { POST } from "./route"

test("POST forwards the selected model to the agent service", async () => {
  const originalFetch = globalThis.fetch
  let forwardedBody: unknown = null
  let forwardedAuthorization: string | null = null

  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(String(init?.body || "{}"))
    forwardedAuthorization = new Headers(init?.headers).get("authorization")
    return new Response(
      'event: run.completed\ndata: {"type":"run.completed","result":{"finalResponse":"ok","knowledgeSources":[{"title":"生产部署手册","description":"部署要求","sourceUrl":"https://oa-kb.example.test/wiki/page-1"}]}}\n\n',
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    )
  }

  try {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({
          sessionId: "model-switch-session",
          provider: "openrouter",
          model: "z-ai/glm-5.3",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    const responseText = await response.text()

    assert.deepEqual(forwardedBody, {
      message: "hello",
      provider: "openrouter",
      model: "z-ai/glm-5.3",
    })
    assert.equal(forwardedAuthorization, "Bearer test-session-token")
    assert.match(responseText, /"knowledgeSources"/)
    assert.match(responseText, /https:\/\/oa-kb\.example\.test\/wiki\/page-1/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("POST rejects an unknown provider before calling the agent service", async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    return new Response(null, { status: 500 })
  }

  try {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({
          sessionId: "model-switch-session",
          provider: "unknown",
          model: "z-ai/glm-5.3",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )

    assert.equal(response.status, 400)
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("POST converts an upstream EOF without a terminal run event into run.failed", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      [
        'event: message.delta\ndata: {"type":"message.delta","itemId":"progress","delta":"我继续查询项目。","text":"我继续查询项目。"}\n\n',
        'event: tool.started\ndata: {"type":"tool.started","itemId":"oa-query","toolType":"command_execution","name":"callOaApi","status":"in_progress"}\n\n',
      ].join(""),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    )

  try {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=test-session-token",
        },
        body: JSON.stringify({
          sessionId: "incomplete-stream-session",
          messages: [{ role: "user", content: "查询知识库和项目更新" }],
        }),
      }),
    )
    const responseText = await response.text()

    assert.match(responseText, /event: run\.failed/)
    assert.match(responseText, /stream ended before.*terminal/i)
    assert.doesNotMatch(responseText, /event: run\.completed/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
