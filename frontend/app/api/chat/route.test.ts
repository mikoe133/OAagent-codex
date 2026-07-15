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
      'event: run.completed\ndata: {"type":"run.completed","result":{"finalResponse":"ok"}}\n\n',
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
          model: "openai/gpt-5.4-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    await response.text()

    assert.deepEqual(forwardedBody, {
      message: "hello",
      model: "openai/gpt-5.4-mini",
    })
    assert.equal(forwardedAuthorization, "Bearer test-session-token")
  } finally {
    globalThis.fetch = originalFetch
  }
})
