import assert from "node:assert/strict"
import test from "node:test"

import { DELETE, GET, PATCH, POST } from "./[...segments]/route"

test("proxies the task list to the OA management API with the HttpOnly session", async () => {
  const restore = configureEnvironment()
  const originalFetch = globalThis.fetch
  let upstreamUrl = ""
  let upstreamHeaders = new Headers()
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input)
    upstreamHeaders = new Headers(init?.headers)
    return Response.json({ code: 200, message: "ok", data: { total: 0, items: [] }, success: true })
  }

  try {
    const response = await GET(
      new Request("http://localhost/api/automation/jobs?page=2", {
        headers: { cookie: "sessionid=oa-session-token" },
      }),
      context("jobs"),
    )

    assert.equal(response.status, 200)
    assert.equal(upstreamUrl, "https://automation.example.test/automation-jobs?page=2&alias=frontend-test")
    assert.equal(upstreamHeaders.get("authorization"), "Bearer oa-session-token")
    assert.equal(upstreamHeaders.get("cookie"), "sessionid=oa-session-token")
    assert.equal(response.headers.get("cache-control"), "no-store")
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("maps job actions and forwards JSON without changing the OA response", async () => {
  const restore = configureEnvironment()
  const originalFetch = globalThis.fetch
  let upstreamUrl = ""
  let method = ""
  let body = ""
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input)
    method = init?.method ?? ""
    body = String(init?.body ?? "")
    return Response.json(
      { code: 202, message: "accepted", data: { run_id: "run-1", status: "pending" }, success: true },
      { status: 202 },
    )
  }

  try {
    const requestBody = JSON.stringify({ enabled: true, version: 3 })
    const response = await POST(
      new Request("http://localhost/api/automation/jobs/42/runs", {
        method: "POST",
        headers: { cookie: "sessionid=oa-session-token", "content-type": "application/json" },
        body: requestBody,
      }),
      context("jobs", "42", "runs"),
    )

    assert.equal(upstreamUrl, "https://automation.example.test/automation-jobs/42/runs?alias=frontend-test")
    assert.equal(method, "POST")
    assert.equal(body, requestBody)
    assert.equal(response.status, 202)
    assert.equal((await response.json()).data.run_id, "run-1")
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("proxies prompt profiles with the OA session cookie and no Authorization header", async () => {
  const restore = configureEnvironment()
  const originalFetch = globalThis.fetch
  let upstreamUrl = ""
  let upstreamHeaders = new Headers()
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input)
    upstreamHeaders = new Headers(init?.headers)
    return Response.json({ code: 200, message: "ok", data: { version: 3 }, success: true })
  }

  try {
    const response = await GET(
      new Request("http://localhost/api/automation/prompt-profiles/github_project_progress_sync", {
        headers: { cookie: "sessionid=oa-session-token" },
      }),
      context("prompt-profiles", "github_project_progress_sync"),
    )

    assert.equal(response.status, 200)
    assert.equal(upstreamUrl, "https://automation.example.test/automation-prompt-profiles/github_project_progress_sync?alias=frontend-test")
    assert.equal(upstreamHeaders.get("cookie"), "sessionid=oa-session-token")
    assert.equal(upstreamHeaders.get("authorization"), null)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("whitelists every documented OA automation management endpoint", async () => {
  const restore = configureEnvironment()
  const originalFetch = globalThis.fetch
  const upstreamRequests: Array<{ method: string; url: string }> = []
  globalThis.fetch = async (input, init) => {
    upstreamRequests.push({ method: init?.method ?? "GET", url: String(input) })
    return Response.json({ code: 200, message: "ok", data: {}, success: true })
  }

  const cases: Array<{
    method: "GET" | "POST" | "PATCH" | "DELETE"
    segments: string[]
    query?: string
    expected: string
  }> = [
    { method: "GET", segments: ["models"], expected: "/automation-models" },
    { method: "GET", segments: ["prompt-profiles", "github_project_progress_sync"], expected: "/automation-prompt-profiles/github_project_progress_sync" },
    { method: "PATCH", segments: ["prompt-profiles", "github_project_progress_sync"], expected: "/automation-prompt-profiles/github_project_progress_sync" },
    { method: "GET", segments: ["tags"], expected: "/automation-tags" },
    { method: "POST", segments: ["tags"], expected: "/automation-tags" },
    { method: "PATCH", segments: ["tags", "9"], expected: "/automation-tags/9" },
    { method: "DELETE", segments: ["tags", "9"], expected: "/automation-tags/9" },
    { method: "GET", segments: ["jobs"], query: "include_deleted=true", expected: "/automation-jobs?include_deleted=true" },
    { method: "POST", segments: ["jobs"], expected: "/automation-jobs" },
    { method: "GET", segments: ["jobs", "7"], query: "include_deleted=true", expected: "/automation-jobs/7?include_deleted=true" },
    { method: "PATCH", segments: ["jobs", "7"], expected: "/automation-jobs/7" },
    { method: "DELETE", segments: ["jobs", "7"], query: "version=4", expected: "/automation-jobs/7?version=4" },
    { method: "POST", segments: ["jobs", "7", "validate"], expected: "/automation-jobs/7/validate" },
    { method: "POST", segments: ["jobs", "7", "runs"], expected: "/automation-jobs/7/runs" },
    { method: "GET", segments: ["runs"], query: "status=failed", expected: "/automation-job-runs?status=failed" },
    { method: "GET", segments: ["runs", "run-id"], query: "include=attempts", expected: "/automation-job-runs/run-id?include=attempts" },
    { method: "GET", segments: ["runs", "run-id", "trace-events"], expected: "/automation-job-runs/run-id/trace-events" },
    { method: "POST", segments: ["runs", "run-id", "cancel"], expected: "/automation-job-runs/run-id/cancel" },
  ]

  try {
    for (const item of cases) {
      const query = item.query ? `?${item.query}` : ""
      const init = item.method === "POST" || item.method === "PATCH"
        ? { method: item.method, headers: { cookie: "sessionid=oa-session-token" }, body: "{}" }
        : { method: item.method, headers: { cookie: "sessionid=oa-session-token" } }
      const request = new Request(`http://localhost/api/automation/${item.segments.join("/")}${query}`, init)
      const handler = item.method === "GET" ? GET : item.method === "POST" ? POST : item.method === "PATCH" ? PATCH : DELETE
      const response = await handler(request, context(...item.segments))
      assert.equal(response.status, 200, `${item.method} ${item.segments.join("/")}`)
    }

    assert.deepEqual(upstreamRequests, cases.map((item) => ({
      method: item.method,
      url: `https://automation.example.test${item.expected}${item.expected.includes("?") ? "&" : "?"}alias=frontend-test`,
    })))
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("rejects missing sessions and non-whitelisted routes before contacting OA", async () => {
  let fetchCalled = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalled = true
    return Response.json({})
  }

  try {
    const unauthenticated = await GET(
      new Request("http://localhost/api/automation/jobs"),
      context("jobs"),
    )
    const unknown = await PATCH(
      new Request("http://localhost/api/automation/jobs/not-a-number", {
        method: "PATCH",
        headers: { cookie: "sessionid=oa-session-token" },
      }),
      context("jobs", "not-a-number"),
    )

    assert.equal(unauthenticated.status, 401)
    assert.equal(unknown.status, 404)
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("falls back to the OA API base url while the Node automation service is not configured", async () => {
  const originalAutomationBaseUrl = process.env.AUTOMATION_API_BASE_URL
  const originalBaseUrl = process.env.OA_API_BASE_URL
  const originalAlias = process.env.OA_AUTH_ALIAS
  process.env.AUTOMATION_API_BASE_URL = ""
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.OA_AUTH_ALIAS = "frontend-test"
  const originalFetch = globalThis.fetch
  let upstreamUrl = ""
  globalThis.fetch = async (input) => {
    upstreamUrl = String(input)
    return Response.json({ code: 200, message: "ok", data: {}, success: true })
  }

  try {
    const response = await GET(
      new Request("http://localhost/api/automation/models", {
        headers: { cookie: "sessionid=oa-session-token" },
      }),
      context("models"),
    )

    assert.equal(response.status, 200)
    assert.equal(upstreamUrl, "https://oa.example.test/automation-models?alias=frontend-test")
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("AUTOMATION_API_BASE_URL", originalAutomationBaseUrl)
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
    restoreEnv("OA_AUTH_ALIAS", originalAlias)
  }
})

function context(...segments: string[]) {
  return { params: Promise.resolve({ segments }) }
}

function configureEnvironment(): () => void {
  const originalAutomationBaseUrl = process.env.AUTOMATION_API_BASE_URL
  const originalBaseUrl = process.env.OA_API_BASE_URL
  const originalAlias = process.env.OA_AUTH_ALIAS
  process.env.AUTOMATION_API_BASE_URL = "https://automation.example.test"
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  process.env.OA_AUTH_ALIAS = "frontend-test"
  return () => {
    restoreEnv("AUTOMATION_API_BASE_URL", originalAutomationBaseUrl)
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
    restoreEnv("OA_AUTH_ALIAS", originalAlias)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
