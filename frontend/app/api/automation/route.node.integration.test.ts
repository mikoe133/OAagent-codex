import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { AutomationService } from "../../../../agent/src/automation/application/automationService"
import { AutomationHttpApplication } from "../../../../agent/src/automation/http/automationHttpApplication"
import { createAutomationDatabase } from "../../../../agent/src/automation/persistence/database"
import { runAutomationMigrations } from "../../../../agent/src/automation/persistence/migrations"
import { DELETE, GET, PATCH, POST } from "./[...segments]/route"

const databaseUrl = process.env.AUTOMATION_NODE_TEST_DATABASE_URL
const signedSession =
  "eyJ1c2VyX2lkIjo0Mn0=.anrC2Q.pEFWxzjfMt0mY3AiF3rdGDgnmrk"

test(
  "proxies the complete automation management workflow to the Node service",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    const url = new URL(databaseUrl!)
    assert.match(url.pathname, /_automation_test$/)
    const repoRoot = new URL("../../../..", import.meta.url).pathname
    await runAutomationMigrations(url, repoRoot)
    const database = createAutomationDatabase(url)
    await database.db
      .updateTable("automation_job_runs")
      .set({
        status: "cancelled",
        finished_at: new Date(),
        lease_token_digest: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("status", "in", ["pending", "claimed", "running"])
      .execute()
    const service = new AutomationService(database, {
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      modelProviders: {
        nexttoken: {
          name: "Nexttoken",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "NEXTTOKEN_API_KEY",
        },
        openrouter: {
          name: "OpenRouter",
          apiKey: "test",
          baseUrl: "https://example.test/v1",
          envKey: "OPENROUTER_API_KEY",
        },
      },
      scheduleGraceSeconds: 120,
      manualTriggerLimit: 3,
      manualTriggerWindowSeconds: 300,
    })
    const application = new AutomationHttpApplication(
      {
        sessionSecret: "dummy",
        sessionVerifyMaxAgeSeconds: 0,
        internalToken: "integration-token",
      },
      service,
    )
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      )
      if (!(await application.handle(request, response, requestUrl))) {
        response.writeHead(404).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const backendBaseUrl = `http://127.0.0.1:${address.port}`
    const restore = configureEnvironment(backendBaseUrl)
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

    try {
      const models = await call(GET, ["models"])
      assert.equal(models.status, 200)
      assert.ok((await envelope(models)).data.providers.length > 0)

      const prompt = await call(GET, [
        "prompt-profiles",
        "github_project_progress_sync",
      ])
      assert.equal(prompt.status, 200)
      const promptData = (await envelope(prompt)).data
      const promptReplay = await call(
        PATCH,
        ["prompt-profiles", "github_project_progress_sync"],
        undefined,
        {
          system_prompt: promptData.system_prompt,
          enabled: promptData.enabled,
          version: promptData.version,
        },
      )
      assert.equal(promptReplay.status, 200)

      const tagCreated = await call(POST, ["tags"], undefined, {
        name: `frontend-${suffix}`,
        color: "#123456",
        description: "integration",
        enabled: true,
      })
      assert.equal(tagCreated.status, 201)
      const tagId = (await envelope(tagCreated)).data.id as number
      assert.equal((await call(GET, ["tags"], "enabled=true")).status, 200)
      assert.equal(
        (await call(PATCH, ["tags", String(tagId)], undefined, {
          description: "updated",
        })).status,
        200,
      )

      const disposableTag = await call(POST, ["tags"], undefined, {
        name: `disposable-${suffix}`,
        enabled: false,
      })
      assert.equal(
        (await call(DELETE, ["tags", String((await envelope(disposableTag)).data.id)])).status,
        200,
      )

      const created = await call(POST, ["jobs"], undefined, {
        job_key: `frontend-${suffix}`,
        job_type: "github_project_progress_sync",
        name: "Frontend integration job",
        description: "",
        enabled: true,
        timezone: "Asia/Shanghai",
        schedule_type: "cron",
        cron_expression: "0 20 * * 1-5",
        catch_up_policy: "latest",
        overlap_policy: "forbid",
        model_provider: "nexttoken",
        model_id: "gpt-5.6-terra",
        model_parameters: {},
        retry_max_attempts: 3,
        retry_interval_seconds: 0,
        timeout_seconds: 600,
        retention_days: 90,
        tag_ids: [tagId],
      })
      assert.equal(created.status, 201)
      const job = (await envelope(created)).data
      const jobId = job.id as number
      assert.equal((await call(GET, ["jobs"], `tag_id=${tagId}`)).status, 200)
      assert.equal((await call(GET, ["jobs", String(jobId)])).status, 200)

      const patched = await call(PATCH, ["jobs", String(jobId)], undefined, {
        version: job.version,
        description: "patched through frontend",
      })
      assert.equal(patched.status, 200)
      const stalePatch = await call(PATCH, ["jobs", String(jobId)], undefined, {
        version: job.version,
        description: "stale update",
      })
      assert.equal(stalePatch.status, 409)
      assert.equal((await envelope(stalePatch)).data.error_code, "automation_job_version_conflict")
      assert.equal(
        (await call(POST, ["jobs", String(jobId), "validate"])).status,
        200,
      )

      const triggered = await call(POST, ["jobs", String(jobId), "runs"])
      assert.equal(triggered.status, 202)
      const runId = (await envelope(triggered)).data.run_id as string
      const activeJob = (await envelope(
        await call(GET, ["jobs", String(jobId)]),
      )).data
      const activeDelete = await call(
        DELETE,
        ["jobs", String(jobId)],
        `version=${activeJob.version}`,
      )
      assert.equal(activeDelete.status, 409)
      assert.equal((await envelope(activeDelete)).data.error_code, "job_has_active_run")
      const overlap = await call(POST, ["jobs", String(jobId), "runs"])
      assert.equal(overlap.status, 202)
      const overlapData = (await envelope(overlap)).data
      assert.equal(overlapData.run_id, runId)
      assert.equal(overlapData.reused, true)
      const claim = await internalCall(
        backendBaseUrl,
        "/internal/automation-job-runs/claim",
        "POST",
        {
          worker_instance: "frontend-integration-worker",
          supported_job_types: ["github_project_progress_sync"],
          lease_seconds: 300,
        },
      )
      assert.equal(claim.status, 200)
      const claimData = (await envelope(claim)).data
      assert.equal(claimData.run_id, runId)
      const lease = {
        worker_instance: "frontend-integration-worker",
        lease_token: claimData.lease_token,
      }
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}/heartbeat`,
          "POST",
          { ...lease, lease_seconds: 300 },
        )).status,
        200,
      )
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}`,
          "PATCH",
          { ...lease, status: "running", retry_recommended: false },
        )).status,
        200,
      )
      const projectResult = await internalCall(
        backendBaseUrl,
        `/internal/automation-job-runs/${runId}/projects/901`,
        "PUT",
        {
          ...lease,
          project_name_snapshot: "Frontend project",
          status_before: "active",
          status_after: "active",
          outcome: "no_commits",
          repository_count: 1,
          commit_count: 0,
          source_digest: "integration-source",
          warnings: [],
          mutations_applied: false,
        },
      )
      assert.equal(projectResult.status, 200)
      const runProjectId = (await envelope(projectResult)).data.run_project_id
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}/ai-interactions`,
          "POST",
          {
            ...lease,
            run_project_id: runProjectId,
            interaction_key: "frontend-project-summary",
            provider: "nexttoken",
            model: "gpt-5.6-terra",
            prompt_version: claimData.prompt_profile.prompt_version,
            system_prompt_snapshot: claimData.prompt_profile.system_prompt,
            request_payload_sanitized: {},
            response_payload_sanitized: {},
            limitations: [],
            fallback_used: false,
            status: "succeeded",
          },
        )).status,
        201,
      )
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}/trace-events`,
          "POST",
          {
            ...lease,
            event_key: "frontend-project",
            sequence: 1,
            phase: "project",
            status: "succeeded",
            title: "Frontend project",
            metadata_sanitized: {},
            occurred_at: new Date().toISOString(),
          },
        )).status,
        200,
      )
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}`,
          "PATCH",
          {
            ...lease,
            status: "succeeded",
            mutations_applied: false,
            retry_recommended: false,
          },
        )).status,
        200,
      )
      const terminalHeartbeat = await internalCall(
        backendBaseUrl,
        `/internal/automation-job-runs/${runId}/heartbeat`,
        "POST",
        { ...lease, lease_seconds: 300 },
      )
      assert.equal(terminalHeartbeat.status, 409)
      assert.equal(
        (await internalCall(
          backendBaseUrl,
          `/internal/automation-job-runs/${runId}`,
          "PATCH",
          {
            ...lease,
            status: "succeeded",
            mutations_applied: false,
            retry_recommended: false,
          },
        )).status,
        200,
      )
      assert.equal((await call(GET, ["runs"], `job_id=${jobId}`)).status, 200)
      assert.equal(
        (await call(GET, ["runs", runId], "include=projects%2Cai_interactions%2Cattempts")).status,
        200,
      )
      const trace = await call(GET, ["runs", runId, "trace-events"])
      assert.equal(trace.status, 200)
      assert.equal((await envelope(trace)).data.total, 1)
      const terminalCancel = await call(POST, ["runs", runId, "cancel"])
      assert.equal(terminalCancel.status, 409)

      const secondTrigger = await call(POST, ["jobs", String(jobId), "runs"])
      assert.equal(secondTrigger.status, 202)
      const secondRunId = (await envelope(secondTrigger)).data.run_id as string
      assert.equal((await call(POST, ["runs", secondRunId, "cancel"])).status, 200)

      const current = (await envelope(
        await call(GET, ["jobs", String(jobId)]),
      )).data
      const deleted = await call(
        DELETE,
        ["jobs", String(jobId)],
        `version=${current.version}`,
      )
      assert.equal(deleted.status, 200)
      assert.equal((await envelope(deleted)).data.deleted, true)
      assert.equal(
        (await call(GET, ["jobs", String(jobId)], "include_deleted=true")).status,
        200,
      )
    } finally {
      restore()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await database.close()
    }
  },
)

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ segments: string[] }> },
) => Promise<Response>

async function call(
  handler: RouteHandler,
  segments: string[],
  query?: string,
  body?: unknown,
): Promise<Response> {
  return handler(
    new Request(
      `http://frontend.test/api/automation/${segments.join("/")}${query ? `?${query}` : ""}`,
      {
        method: handler === GET ? "GET" : handler === POST ? "POST" : handler === PATCH ? "PATCH" : "DELETE",
        headers: {
          cookie: `sessionid=${encodeURIComponent(signedSession)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
    { params: Promise.resolve({ segments }) },
  )
}

async function envelope(response: Response): Promise<{ data: any }> {
  return response.json() as Promise<{ data: any }>
}

function internalCall(
  baseUrl: string,
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer integration-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function configureEnvironment(baseUrl: string): () => void {
  const originalBaseUrl = process.env.AUTOMATION_API_BASE_URL
  const originalAlias = process.env.OA_AUTH_ALIAS
  process.env.AUTOMATION_API_BASE_URL = baseUrl
  process.env.OA_AUTH_ALIAS = "frontend-integration"
  return () => {
    restoreEnv("AUTOMATION_API_BASE_URL", originalBaseUrl)
    restoreEnv("OA_AUTH_ALIAS", originalAlias)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
