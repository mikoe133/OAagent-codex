import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AppConfig } from "../src/config/config.js";
import { callKnowledgeBaseApiTool } from "../src/infrastructure/knowledgebase/knowledgeBaseApiTool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("controlled knowledge base API tool", () => {
  it("injects the service token and current OA user id for reads", async () => {
    const config = await createFixture();
    let requestUrl: URL | null = null;
    let requestHeaders: Headers | null = null;

    const result = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "生产部署", limit: 20 },
      },
      "19",
      async (input, init) => {
        requestUrl = new URL(String(input));
        requestHeaders = new Headers(init?.headers);
        return Response.json({ data: [], nextCursor: null, requestId: "req-1" });
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.operationId, "searchKnowledgeBase");
    assert.equal(requestUrl?.pathname, "/api/agent/v1/search");
    assert.equal(requestUrl?.searchParams.get("q"), "生产部署");
    assert.equal(requestHeaders?.get("authorization"), "Bearer kb-service-secret");
    assert.equal(requestHeaders?.get("x-oa-user-id"), "19");
    assert.doesNotMatch(JSON.stringify(result), /kb-service-secret/);
  });

  it("requires confirmation for every write-contract operation", async () => {
    const config = await createFixture(true);
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return Response.json({ data: { id: "page-1" }, requestId: "req-2" });
    };

    const blocked = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "createKnowledgeBasePage",
        body: { title: "新页面" },
      },
      "19",
      fetchImpl,
    );

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "confirmation_required");
    assert.equal(requests, 0);

    const confirmed = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "createKnowledgeBasePage",
        body: { title: "新页面" },
        confirmed: true,
      },
      "19",
      fetchImpl,
    );

    assert.equal(confirmed.ok, true);
    assert.equal(requests, 1);
  });

  it("fails closed when the session has no stable OA user id", async () => {
    const config = await createFixture();
    const result = await callKnowledgeBaseApiTool(
      config,
      { operationId: "searchKnowledgeBase", query: { q: "部署" } },
      null,
      async () => {
        throw new Error("must not execute");
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "knowledge_base_user_required");
  });
});

async function createFixture(withWriteContract = false): Promise<AppConfig> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "oa-kb-tool-test-"));
  temporaryDirectories.push(projectRoot);
  const directory = path.join(projectRoot, "knowledgebaseapi");
  const readPath = path.join(directory, "knowledgebaseapi.yaml");
  const writePath = path.join(directory, "knowledgebase-write-api.yaml");
  const guidePath = path.join(directory, "AGENT_API.md");
  await mkdir(directory, { recursive: true });
  await writeFile(readPath, readContract(), "utf8");
  await writeFile(guidePath, "# test guide\n", "utf8");
  if (withWriteContract) {
    await writeFile(writePath, writeContract(), "utf8");
  }

  return {
    projectRoot,
    knowledgeBaseApiBaseUrl: "https://kb.example.test/api/agent/v1",
    knowledgeBaseApiToken: "kb-service-secret",
    knowledgeBaseReadOpenapiPath: readPath,
    knowledgeBaseWriteOpenapiPath: writePath,
    knowledgeBaseApiGuidePath: guidePath,
    oaApiToolToken: "internal-tool-secret",
  } as AppConfig;
}

function readContract(): string {
  return `openapi: 3.1.0
paths:
  /search:
    get:
      operationId: searchKnowledgeBase
      parameters:
        - name: X-OA-User-Id
          in: header
          required: true
          schema: { type: string }
        - name: q
          in: query
          required: true
          schema: { type: string }
      responses:
        '200': { description: ok }
`;
}

function writeContract(): string {
  return `openapi: 3.1.0
paths:
  /pages:
    post:
      operationId: createKnowledgeBasePage
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
      responses:
        '200': { description: ok }
`;
}
