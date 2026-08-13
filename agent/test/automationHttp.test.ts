import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentService } from "../src/application/agentService.js";
import { createAgentHttpServer } from "../src/api/httpServer.js";
import {
  AutomationHttpApplication,
  type AutomationOperations,
} from "../src/automation/http/automationHttpApplication.js";
import type { AppConfig } from "../src/config/config.js";
import { SessionStore } from "../src/infrastructure/persistence/sessionStore.js";

const PYTHON_SIGNED_SESSION =
  "eyJ1c2VyX2lkIjo0Mn0=.anrC2Q.pEFWxzjfMt0mY3AiF3rdGDgnmrk";

test("routes OA user automation requests with the signed session user_id", async () => {
  const calls: unknown[] = [];
  const operations = {
    async listTags(query: URLSearchParams, userId: number) {
      calls.push({ query: query.toString(), userId });
      return { total: 1, items: [{ id: 1, name: "GitHub" }] };
    },
  } as unknown as AutomationOperations;
  const application = new AutomationHttpApplication(
    {
      sessionSecret: "dummy",
      sessionVerifyMaxAgeSeconds: 0,
      internalToken: "internal-secret",
    },
    operations,
  );
  const fixture = await startFixture(application);

  try {
    const unauthorized = await requestJson(
      fixture.port,
      "GET",
      "/automation-tags?page=2&size=20",
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(unauthorized.body, {
      code: 401,
      message: "未登录或登录态无效",
      data: { error_code: "unauthorized", details: null },
      success: false,
    });

    const response = await requestJson(
      fixture.port,
      "GET",
      "/automation-tags?page=2&size=20",
      { Cookie: `sessionid=${PYTHON_SIGNED_SESSION}` },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      code: 200,
      message: "success",
      data: { total: 1, items: [{ id: 1, name: "GitHub" }] },
      success: true,
    });
    assert.deepEqual(calls, [{ query: "page=2&size=20", userId: 42 }]);
  } finally {
    await fixture.close();
  }
});

test("routes a targeted manual run with the signed session user_id", async () => {
  const calls: unknown[] = [];
  const operations = {
    async triggerJob(jobId: number, input: unknown, userId: number) {
      calls.push({ jobId, input, userId });
      return { run_id: "run-51", status: "pending" };
    },
  } as unknown as AutomationOperations;
  const application = new AutomationHttpApplication(
    {
      sessionSecret: "dummy",
      sessionVerifyMaxAgeSeconds: 0,
      internalToken: "internal-secret",
    },
    operations,
  );
  const fixture = await startFixture(application);

  try {
    const response = await requestJson(
      fixture.port,
      "POST",
      "/automation-jobs/7/runs",
      {
        Cookie: `sessionid=${PYTHON_SIGNED_SESSION}`,
        "Content-Type": "application/json",
      },
      { project_id: 51, summary_scope: "today" },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(calls, [{
      jobId: 7,
      input: { project_id: 51, summary_scope: "today" },
      userId: 42,
    }]);
  } finally {
    await fixture.close();
  }
});

test("routes worker claim requests only with OA_AGENT_AUTOMATION_TOKEN", async () => {
  const operations = {
    async claimRun(input: unknown) {
      return { id: "run-01", input };
    },
  } as unknown as AutomationOperations;
  const application = new AutomationHttpApplication(
    {
      sessionSecret: "dummy",
      sessionVerifyMaxAgeSeconds: 0,
      internalToken: "internal-secret",
    },
    operations,
  );
  const fixture = await startFixture(application);
  const body = {
    worker_instance: "worker-01",
    supported_job_types: ["github_project_progress_sync"],
    lease_seconds: 300,
    claim_request_id: "019fd15d-32c6-7fb2-9afb-68be0996b80f",
  };

  try {
    const unauthorized = await requestJson(
      fixture.port,
      "POST",
      "/internal/automation-job-runs/claim",
      { "Content-Type": "application/json" },
      body,
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(
      (unauthorized.body as { data?: { error_code?: unknown } }).data?.error_code,
      "automation_service_unauthorized",
    );

    const accepted = await requestJson(
      fixture.port,
      "POST",
      "/internal/automation-job-runs/claim",
      {
        Authorization: "Bearer internal-secret",
        "Content-Type": "application/json",
      },
      body,
    );
    assert.equal(accepted.status, 200);
    assert.equal(
      (accepted.body as { data?: { id?: unknown } }).data?.id,
      "run-01",
    );
  } finally {
    await fixture.close();
  }
});

test("returns the OA-compatible 201 envelope when a job is created", async () => {
  const operations = {
    async createJob(input: unknown, userId: number) {
      return { id: 7, input, userId };
    },
  } as unknown as AutomationOperations;
  const application = new AutomationHttpApplication(
    {
      sessionSecret: "dummy",
      sessionVerifyMaxAgeSeconds: 0,
      internalToken: "internal-secret",
    },
    operations,
  );
  const fixture = await startFixture(application);

  try {
    const response = await requestJson(
      fixture.port,
      "POST",
      "/automation-jobs",
      {
        Cookie: `sessionid=${PYTHON_SIGNED_SESSION}`,
        "Content-Type": "application/json",
      },
      { name: "job" },
    );
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      code: 201,
      message: "created",
      data: { id: 7, input: { name: "job" }, userId: 42 },
      success: true,
    });
  } finally {
    await fixture.close();
  }
});

async function startFixture(application: AutomationHttpApplication) {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-http-"));
  const config = {
    automationApiToken: "internal-secret",
  } as AppConfig;
  const server = createAgentHttpServer(
    config,
    {} as AgentService,
    new SessionStore(path.join(directory, "sessions.json")),
    application,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function requestJson(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}
