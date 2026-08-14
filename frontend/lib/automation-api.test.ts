import assert from "node:assert/strict"
import test from "node:test"

import {
  AutomationApiError,
  createAutomationJob,
  deleteAutomationJob,
  deleteAutomationTag,
  getAutomationJob,
  getAutomationModelCatalog,
  getAutomationPromptProfile,
  getAutomationRun,
  getAutomationRunTrace,
  listAutomationJobs,
  listAutomationRuns,
  listAutomationTags,
  triggerAutomationJob,
  updateAutomationTag,
  updateAutomationJob,
  updateAutomationPromptProfile,
} from "./automation-api"

test("triggers today's summary for one OA project through the session BFF", async () => {
  const originalFetch = globalThis.fetch
  let request: { url: string; method: string; body: unknown } | null = null
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")),
    }
    return Response.json({
      code: 202,
      message: "accepted",
      data: { run_id: "run-51", status: "pending", reused: false },
      success: true,
    }, { status: 202 })
  }

  try {
    const result = await triggerAutomationJob(7, {
      project_id: 51,
      summary_scope: "today",
    })
    assert.equal(result.reused, false)
    assert.deepEqual(request, {
      url: "/api/automation/jobs/7/runs",
      method: "POST",
      body: { project_id: 51, summary_scope: "today" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("uses the automation BFF for list and audit requests", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return Response.json({ code: 200, message: "ok", data: { total: 0, items: [] }, success: true })
  }

  try {
    await listAutomationJobs({ name: "日报", enabled: true })
    await getAutomationRun("run/unsafe", "attempts")
    await getAutomationRunTrace("run/unsafe")

    assert.equal(requests[0], "/api/automation/jobs?page=1&size=100&sort=-updated_at&name=%E6%97%A5%E6%8A%A5&enabled=true")
    assert.equal(requests[1], "/api/automation/runs/run%2Funsafe?include=attempts")
    assert.equal(requests[2], "/api/automation/runs/run%2Funsafe/trace-events")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sends create data and optimistic-lock versions through the BFF", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    return Response.json({ code: 200, message: "ok", data: { id: 7 }, success: true })
  }

  const createInput = {
    job_key: "github-project-progress-sync",
    job_type: "github_project_progress_sync" as const,
    name: "项目日报",
    description: "",
    enabled: false,
    timezone: "Asia/Shanghai",
    schedule_type: "cron" as const,
    cron_expression: "0 20 * * 1-5",
    catch_up_policy: "latest" as const,
    overlap_policy: "forbid" as const,
    model_provider: "nexttoken",
    model_id: "gpt-5.6-terra",
    model_parameters: {},
    retry_max_attempts: 3,
    retry_interval_seconds: 300,
    timeout_seconds: 2700,
    retention_days: 90,
    tag_ids: [1],
  }

  try {
    await createAutomationJob(createInput)
    const { job_key: _jobKey, job_type: _jobType, schedule_type: _scheduleType, overlap_policy: _overlapPolicy, ...patch } = createInput
    await updateAutomationJob(7, { ...patch, version: 4 })

    assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
      { url: "/api/automation/jobs", method: "POST" },
      { url: "/api/automation/jobs/7", method: "PATCH" },
    ])
    assert.equal(requests[1]?.body.version, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("supports soft-deleted jobs and complete tag management", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; body?: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined })
    return Response.json({ code: 200, message: "ok", data: { id: 7 }, success: true })
  }

  try {
    await listAutomationJobs({ includeDeleted: true })
    await getAutomationJob(7, { includeDeleted: true })
    await deleteAutomationJob(7, 4)
    await listAutomationTags()
    await updateAutomationTag(3, { name: "GitHub", enabled: false })
    await deleteAutomationTag(3)

    assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
      { url: "/api/automation/jobs?page=1&size=100&sort=-updated_at&include_deleted=true", method: "GET" },
      { url: "/api/automation/jobs/7?include_deleted=true", method: "GET" },
      { url: "/api/automation/jobs/7?version=4", method: "DELETE" },
      { url: "/api/automation/tags?page=1&size=100", method: "GET" },
      { url: "/api/automation/tags/3", method: "PATCH" },
      { url: "/api/automation/tags/3", method: "DELETE" },
    ])
    assert.deepEqual(JSON.parse(requests[4]?.body ?? "{}"), { name: "GitHub", enabled: false })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("loads and updates the shared prompt profile through the BFF", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    })
    return Response.json({
      code: 200,
      message: "ok",
      data: {
        id: 1,
        job_type: "github_project_progress_sync",
        system_prompt: "只处理授权项目",
        required_capabilities: ["github_project_tracking", "rwkvos_system_calls"],
        prompt_version: "sha256:abc",
        enabled: true,
        version: 4,
        created_by: null,
        updated_by: 51,
        created_at: "2026-07-31T08:00:00Z",
        updated_at: "2026-07-31T12:00:00Z",
      },
      success: true,
    })
  }

  try {
    await getAutomationPromptProfile("github_project_progress_sync")
    await updateAutomationPromptProfile("github_project_progress_sync", {
      system_prompt: "只处理授权项目",
      enabled: true,
      version: 3,
    })

    assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
      { url: "/api/automation/prompt-profiles/github_project_progress_sync", method: "GET" },
      { url: "/api/automation/prompt-profiles/github_project_progress_sync", method: "PATCH" },
    ])
    assert.deepEqual(requests[1]?.body, {
      system_prompt: "只处理授权项目",
      enabled: true,
      version: 3,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("forwards every documented run-list filter and pagination field", async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ""
  globalThis.fetch = async (input) => {
    requestUrl = String(input)
    return Response.json({ code: 200, message: "ok", data: { total: 0, items: [] }, success: true })
  }

  try {
    await listAutomationRuns({
      page: 2,
      size: 10,
      jobId: 7,
      tagId: 3,
      status: "failed",
      triggerSource: "manual",
      modelProvider: "nexttoken",
      modelId: "gpt-5.6-terra",
      startedAfter: "2026-07-01T00:00:00.000Z",
      startedBefore: "2026-07-31T23:59:59.000Z",
    })

    assert.equal(requestUrl, "/api/automation/runs?page=2&size=10&sort=-scheduled_at&job_id=7&tag_id=3&status=failed&trigger_source=manual&model_provider=nexttoken&model_id=gpt-5.6-terra&started_after=2026-07-01T00%3A00%3A00.000Z&started_before=2026-07-31T23%3A59%3A59.000Z")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("surfaces OA envelope errors with status and error code", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    code: 409,
    message: "任务版本冲突",
    data: { error_code: "automation_job_version_conflict" },
    success: false,
  }, { status: 409 })

  try {
    await assert.rejects(
      () => listAutomationJobs(),
      (error: unknown) => {
        assert.ok(error instanceof AutomationApiError)
        assert.equal(error.status, 409)
        assert.equal(error.errorCode, "automation_job_version_conflict")
        assert.equal(error.message, "任务版本冲突")
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("deduplicates concurrent identical GET requests", async () => {
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    return Response.json({
      code: 200,
      message: "ok",
      data: { total: 0, items: [] },
      success: true,
    })
  }

  try {
    const [first, second] = await Promise.all([
      listAutomationJobs(),
      listAutomationJobs(),
    ])

    assert.equal(requestCount, 1)
    assert.deepEqual(first, second)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("caches the model catalog for five minutes", async () => {
  const originalFetch = globalThis.fetch
  const originalDateNow = Date.now
  let now = 1_000
  let requestCount = 0
  Date.now = () => now
  globalThis.fetch = async () => {
    requestCount += 1
    return Response.json({
      code: 200,
      message: "ok",
      data: {
        catalog_version: `v${requestCount}`,
        providers: [],
      },
      success: true,
    })
  }

  try {
    const first = await getAutomationModelCatalog()
    now += 299_999
    const cached = await getAutomationModelCatalog()
    now += 2
    const refreshed = await getAutomationModelCatalog()

    assert.equal(requestCount, 2)
    assert.equal(cached, first)
    assert.equal(refreshed.catalog_version, "v2")
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
  }
})

test("removes failed GET requests from the in-flight cache", async () => {
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    if (requestCount === 1) {
      return Response.json({
        code: 503,
        message: "temporary failure",
        success: false,
      }, { status: 503 })
    }
    return Response.json({
      code: 200,
      message: "ok",
      data: { total: 0, items: [] },
      success: true,
    })
  }

  try {
    const first = listAutomationTags({ enabled: true })
    const second = listAutomationTags({ enabled: true })

    await assert.rejects(first, AutomationApiError)
    await assert.rejects(second, AutomationApiError)
    await listAutomationTags({ enabled: true })

    assert.equal(requestCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("never deduplicates mutating requests", async () => {
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    return Response.json({
      code: 200,
      message: "ok",
      data: { id: 3 },
      success: true,
    })
  }

  try {
    await Promise.all([
      deleteAutomationTag(3),
      deleteAutomationTag(3),
    ])

    assert.equal(requestCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
