import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OaContractError,
  OaRequestError,
  ProjectProgressLeaseLostError,
  ProjectProgressOaClient,
} from "../src/infrastructure/oa/projectProgressOaClient.js";

describe("ProjectProgressOaClient", () => {
  it("decodes every page from the OA project envelope", async () => {
    const requestedPages: string[] = [];
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "production",
        token: "secret",
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer",
      },
      async (input) => {
        const url = new URL(String(input));
        requestedPages.push(url.searchParams.get("page") ?? "");
        const page = Number(url.searchParams.get("page"));
        return Response.json({
          code: 200,
          success: true,
          data: {
            total: 2,
            items: [
              {
                id: page,
                project_name: `project-${page}`,
                status: page === 1 ? "updating" : "maintenance",
                github_urls: [],
              },
            ],
          },
        });
      },
    );

    const projects = await client.listProjects();

    assert.deepEqual(requestedPages, ["1", "2"]);
    assert.deepEqual(projects.map((project) => project.id), [1, 2]);
  });

  it("rejects malformed or unknown project status values", async () => {
    const client = new ProjectProgressOaClient(
      {
        baseUrl: "https://oa.example.test",
        alias: "default",
        token: "secret",
        tokenHeader: "Cookie",
        tokenPrefix: "sessionid=",
      },
      async () => Response.json({ data: { total: 1, items: [{ id: 1, status: "paused" }] } }),
    );

    await assert.rejects(client.listProjects(), OaContractError);
  });

  it("sends only a status field when updating a test project", async () => {
    let request: Request | null = null;
    const client = createClient(async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: { id: 7 } });
    });

    await client.updateProjectStatus(7, "maintenance");

    assert.equal(request?.method, "PATCH");
    assert.equal(
      new URL(request?.url ?? "").pathname,
      "/internal/project-sync/projects/7/status",
    );
    assert.deepEqual(await request?.json(), { status: "maintenance" });
  });

  it("fences project and summary mutations with stable idempotency and versions", async () => {
    const requests: Request[] = [];
    const client = createFencedClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/status")) {
        return Response.json({ data: { id: 7, version: 4 } });
      }
      return Response.json({ data: {
        id: 101,
        project_id: 7,
        summary_date: "2026-07-24",
        summary: "更新后的总结。",
        ai_confidence: 91,
        ai_note: "已更新。",
        version: 3,
      } });
    });

    await client.updateProjectStatus(7, "maintenance", 3);
    await client.updateProjectStatus(7, "maintenance", 3);
    await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
    });
    await client.updateCommitSummary(101, {
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
      expectedVersion: 2,
    });

    const statusBody = await requests[0]!.json() as Record<string, unknown>;
    const repeatedStatusBody = await requests[1]!.json() as Record<string, unknown>;
    const createBody = await requests[2]!.json() as Record<string, unknown>;
    const summaryBody = await requests[3]!.json() as Record<string, unknown>;
    assert.deepEqual(statusBody, {
      status: "maintenance",
      expected_version: 3,
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: statusBody.idempotency_key,
    });
    assert.deepEqual(summaryBody, {
      summary: "更新后的总结。",
      ai_confidence: 91,
      ai_note: "已更新。",
      expected_version: 2,
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: summaryBody.idempotency_key,
    });
    assert.deepEqual(createBody, {
      project_id: 7,
      summary_date: "2026-07-24",
      summary: "更新后的总结。",
      ai_confidence: 91,
      ai_note: "已更新。",
      run_id: "run-01",
      run_mutation_token: "run-mutation-secret",
      fencing_token: 7,
      idempotency_key: createBody.idempotency_key,
    });
    assert.match(String(statusBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(summaryBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(createBody.idempotency_key), /^sha256:[a-f0-9]{64}$/);
    assert.equal(statusBody.idempotency_key, repeatedStatusBody.idempotency_key);
    assert.notEqual(statusBody.idempotency_key, summaryBody.idempotency_key);
  });

  it("queries and creates a project-level daily summary", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json({ data: { total: 0, items: [] } });
      }
      return Response.json({
        data: {
          id: 101,
          project_id: 7,
          summary_date: "2026-07-24",
          summary: "完成登录修复。",
          ai_confidence: 90,
          ai_note: "基于 1 条提交。",
          created_at: 1,
          updated_at: 1,
        },
      });
    });

    assert.deepEqual(await client.listCommitSummaries(7, "2026-07-24"), []);
    const created = await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "完成登录修复。",
      aiConfidence: 90,
      aiNote: "基于 1 条提交。",
    });

    assert.equal(created.id, 101);
    assert.equal(requests[1]?.method, "POST");
    assert.equal(
      new URL(requests[1]?.url ?? "").pathname,
      "/internal/project-sync/github-commit-summaries",
    );
    assert.deepEqual(await requests[1]?.json(), {
      project_id: 7,
      summary_date: "2026-07-24",
      summary: "完成登录修复。",
      ai_confidence: 90,
      ai_note: "基于 1 条提交。",
    });
  });

  it("reads the summary back when a mutation response only contains its id", async () => {
    let calls = 0;
    const client = createClient(async (_input, init) => {
      calls += 1;
      if (init?.method === "POST") {
        return Response.json({ data: { id: 202 } });
      }
      return Response.json({
        data: {
          id: 202,
          project_id: 7,
          summary_date: "2026-07-24",
          summary: "完成回读。",
          ai_confidence: 88,
          ai_note: "",
        },
      });
    });

    const created = await client.createCommitSummary({
      projectId: 7,
      summaryDate: "2026-07-24",
      summary: "完成回读。",
      aiConfidence: 88,
      aiNote: "",
    });

    assert.equal(created.id, 202);
    assert.equal(calls, 2);
  });

  it("reads project details and updates a managed summary", async () => {
    const methods: string[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      if (new URL(request.url).pathname === "/internal/project-sync/projects/7") {
        return Response.json({ data: {
          id: 7,
          project_name: "project-7",
          status: "updating",
          github_urls: [],
          version: 3,
        } });
      }
      return Response.json({ data: {
        id: 101,
        project_id: 7,
        summary_date: "2026-07-24",
        summary: "更新后的总结。",
        ai_confidence: 91,
        ai_note: "已更新。",
        version: 2,
      } });
    });

    assert.equal((await client.getProject(7)).version, 3);
    assert.equal((await client.getCommitSummary(101)).version, 2);
    assert.equal((await client.updateCommitSummary(101, {
      summary: "更新后的总结。",
      aiConfidence: 91,
      aiNote: "已更新。",
    })).id, 101);
    assert.deepEqual(methods, ["GET", "GET", "PATCH"]);
  });

  it("classifies HTTP and malformed JSON failures", async () => {
    await assert.rejects(
      createClient(async () => Response.json({
        code: 503,
        message: "unavailable",
        data: { error_code: "service_unavailable" },
        success: false,
      }, { status: 503 })).listProjects(),
      (error: unknown) =>
        error instanceof OaRequestError &&
        error.status === 503 &&
        error.errorCode === "service_unavailable",
    );
    await assert.rejects(
      createClient(async () => new Response("not-json")).listProjects(),
      OaContractError,
    );
  });

  it("classifies a definitive fencing rejection as lease loss", async () => {
    const client = createFencedClient(async () => Response.json({
      code: 409,
      message: "stale worker",
      data: { error_code: "stale_fencing_token" },
      success: false,
    }, { status: 409 }));

    await assert.rejects(
      client.updateProjectStatus(7, "maintenance", 3),
      (error: unknown) =>
        error instanceof ProjectProgressLeaseLostError &&
        error.status === 409 &&
        error.errorCode === "stale_fencing_token",
    );
  });

  it("rejects unsuccessful envelopes and accepts an empty final page", async () => {
    await assert.rejects(
      createClient(async () => Response.json({ success: false, data: null })).listProjects(),
      /success=false/,
    );
    assert.deepEqual(
      await createClient(async () => Response.json({
        success: true,
        data: { total: 0, items: [] },
      })).listProjects(),
      [],
    );
  });
});

function createClient(fetchImpl: typeof fetch): ProjectProgressOaClient {
  return new ProjectProgressOaClient(
    {
      baseUrl: "https://oa.example.test",
      alias: "default",
      token: "secret",
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer",
    },
    fetchImpl,
  );
}

function createFencedClient(fetchImpl: typeof fetch): ProjectProgressOaClient {
  return new ProjectProgressOaClient(
    {
      baseUrl: "https://oa.example.test",
      alias: "default",
      token: "secret",
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer",
      mutationContext: {
        runId: "run-01",
        runMutationToken: "run-mutation-secret",
        fencingToken: 7,
      },
    },
    fetchImpl,
  );
}
