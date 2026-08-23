import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AppConfig } from "../src/config/config.js";
import {
  callKnowledgeBaseApiTool,
  type KnowledgeBaseApiToolInput,
} from "../src/infrastructure/knowledgebase/knowledgeBaseApiTool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("controlled knowledge base API tool", () => {
  it("injects bearer authorization and the current OA user id for reads", async () => {
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
    assert.equal(
      requestHeaders?.get("authorization"),
      "Bearer kb-service-secret",
    );
    assert.equal(requestHeaders?.get("x-oa-user-id"), "19");
    assert.equal(requestHeaders?.get("agent_api_token"), null);
    assert.equal(requestHeaders?.get("idempotency-key"), null);
    assert.doesNotMatch(JSON.stringify(result), /kb-service-secret/);
  });

  it("removes generic expansion words from knowledge-base search queries", async () => {
    const config = await createFixture();
    let requestUrl: URL | null = null;

    const result = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "宽带 配置", limit: 10 },
      },
      "19",
      async (input) => {
        requestUrl = new URL(String(input));
        return Response.json({ data: [], nextCursor: null, requestId: "req-2" });
      },
    );

    assert.equal(result.ok, true);
    assert.equal(requestUrl?.searchParams.get("q"), "宽带");
    assert.equal(requestUrl?.searchParams.get("limit"), "10");
  });

  it("progressively searches core terms when the full phrase is not relevant", async () => {
    const config = await createFixture();
    const queries: string[] = [];
    const result = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "发票 抬头", limit: 10 },
      },
      "19",
      async (input) => {
        const url = new URL(String(input));
        const query = url.searchParams.get("q") ?? "";
        queries.push(query);
        if (query === "发票 抬头") {
          return Response.json({
            data: [
              {
                id: "page-generic",
                title: "发票开具规范",
                excerpt: "发票开具的一般规范。",
                sourceUrl: "https://oa-kb.example.test/wiki/generic",
              },
            ],
            nextCursor: null,
            requestId: "req-3a",
          });
        }
        if (query === "发票") {
          return Response.json({
            data: [
              {
                id: "page-invoice",
                title: "公司发票抬头信息",
                excerpt: "公司发票抬头、税号和开户地址。",
                sourceUrl: "https://oa-kb.example.test/wiki/invoice",
              },
              {
                id: "page-generic",
                title: "发票开具规范",
                excerpt: "发票开具的一般规范。",
                sourceUrl: "https://oa-kb.example.test/wiki/generic",
              },
            ],
            nextCursor: null,
            requestId: "req-3b",
          });
        }
        throw new Error(`unexpected search query: ${query}`);
      },
    );

    assert.deepEqual(queries, ["发票 抬头", "发票"]);
    assert.equal(result.ok, true);
    assert.deepEqual(
      (result.data as { data: Array<{ id: string }> }).data.map(
        (item) => item.id,
      ),
      ["page-invoice", "page-generic"],
    );
    assert.equal(
      (result.data as { nextCursor: string | null }).nextCursor,
      null,
    );
  });

  it("uses two queries for a two-term semantic phrase", async () => {
    const config = await createFixture();
    const queries: string[] = [];
    await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "发票 抬头", limit: 10 },
      },
      "19",
      async (input) => {
        queries.push(new URL(String(input)).searchParams.get("q") ?? "");
        return Response.json({ data: [], nextCursor: null, requestId: "req-2-term" });
      },
    );

    assert.deepEqual(queries, ["发票 抬头", "发票"]);
  });

  it("uses a phrase fallback before the head term for longer semantics", async () => {
    const config = await createFixture();
    const queries: string[] = [];
    await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "部署 生产 环境", limit: 10 },
      },
      "19",
      async (input) => {
        queries.push(new URL(String(input)).searchParams.get("q") ?? "");
        return Response.json({ data: [], nextCursor: null, requestId: "req-long-term" });
      },
    );

    assert.deepEqual(queries, ["部署 生产 环境", "部署 生产", "部署"]);
  });

  it("does not fan out when the first search has a relevant result", async () => {
    const config = await createFixture();
    let requests = 0;
    const result = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "宽带 配置", limit: 10 },
      },
      "19",
      async (input) => {
        requests += 1;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("q"), "宽带");
        return Response.json({
          data: [
            {
              id: "page-broadband",
              title: "公司宽带基础信息",
              excerpt: "公司宽带配置和线路信息。",
              sourceUrl: "https://oa-kb.example.test/wiki/broadband",
            },
          ],
          nextCursor: "cursor-1",
          requestId: "req-4",
        });
      },
    );

    assert.equal(requests, 1);
    assert.equal(result.ok, true);
    assert.equal(
      (result.data as { nextCursor: string | null }).nextCursor,
      "cursor-1",
    );
  });

  it("strips contextual and generic suffixes from compact Chinese queries", async () => {
    const config = await createFixture();
    let requestUrl: URL | null = null;
    await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "公司宽带配置", limit: 10 },
      },
      "19",
      async (input) => {
        requestUrl = new URL(String(input));
        return Response.json({
          data: [
            {
              id: "page-broadband-compact",
              title: "公司宽带基础信息",
              excerpt: "宽带配置。",
              sourceUrl: "https://oa-kb.example.test/wiki/broadband-compact",
            },
          ],
          nextCursor: null,
          requestId: "req-compact",
        });
      },
    );

    assert.equal(requestUrl?.searchParams.get("q"), "宽带");
  });

  it("keeps cursor pagination on one query instead of mixing cursors", async () => {
    const config = await createFixture();
    let requests = 0;
    await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "发票 抬头", cursor: "cursor-2", limit: 10 },
      },
      "19",
      async (input) => {
        requests += 1;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("q"), "发票 抬头");
        assert.equal(url.searchParams.get("cursor"), "cursor-2");
        return Response.json({ data: [], nextCursor: null, requestId: "req-5" });
      },
    );

    assert.equal(requests, 1);
  });

  it("normalizes Unicode line separators in page content", async () => {
    const config = await createFixture();
    const result = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "getKnowledgeBasePage",
        pathParams: { id: "page-invoice" },
      },
      "19",
      async () =>
        Response.json({
          title: "发票抬头",
          content: "第一行\u2028第二行\u2029第三行",
          sourceUrl: "https://oa-kb.example.test/wiki/page-invoice",
        }),
    );

    assert.equal(result.ok, true);
    assert.equal(
      (result.data as { content: string }).content,
      "第一行\n第二行\n第三行",
    );
  });

  it("rejects agent attempts to supply or override controlled headers", async () => {
    const config = await createFixture();
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return Response.json({ data: [] });
    };

    const directAuthorization = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "部署" },
        authorization: "Bearer agent-value",
      } as KnowledgeBaseApiToolInput,
      "19",
      fetchImpl,
    );
    const queryOverride = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "部署", "x-oa-user-id": "999" },
      },
      "19",
      fetchImpl,
    );

    const idempotencyOverride = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "searchKnowledgeBase",
        query: { q: "部署", "Idempotency-Key": "agent-value" },
      },
      "19",
      fetchImpl,
    );

    assert.equal(
      directAuthorization.error?.code,
      "controlled_headers_not_allowed",
    );
    assert.equal(queryOverride.error?.code, "controlled_headers_not_allowed");
    assert.equal(
      idempotencyOverride.error?.code,
      "controlled_headers_not_allowed",
    );
    assert.equal(requests, 0);
  });

  it("classifies unified-contract mutations as writes and injects idempotency", async () => {
    const config = await createFixture(true);
    let requests = 0;
    let requestHeaders: Headers | null = null;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      requestHeaders = new Headers(init?.headers);
      return Response.json({ data: { id: "page-1" }, requestId: "req-2" });
    };

    const blocked = await callKnowledgeBaseApiTool(
      config,
      {
        operationId: "createKnowledgeBaseNode",
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
        operationId: "createKnowledgeBaseNode",
        body: { title: "新页面" },
        confirmed: true,
      },
      "19",
      fetchImpl,
    );

    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.catalog, "knowledge_base_write");
    assert.equal(requests, 1);
    assert.equal(
      requestHeaders?.get("authorization"),
      "Bearer kb-service-secret",
    );
    assert.equal(requestHeaders?.get("x-oa-user-id"), "19");
    assert.equal(requestHeaders?.get("agent_api_token"), null);
    assert.match(
      requestHeaders?.get("idempotency-key") ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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
  await mkdir(directory, { recursive: true });
  await writeFile(readPath, readContract(withWriteContract), "utf8");

  return {
    projectRoot,
    knowledgeBaseApiBaseUrl: "https://kb.example.test/api/agent/v1",
    knowledgeBaseApiToken: "kb-service-secret",
    knowledgeBaseOpenapiPath: readPath,
    oaApiToolToken: "internal-tool-secret",
  } as AppConfig;
}

function readContract(withWriteOperations: boolean): string {
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
  /pages/{id}:
    get:
      operationId: getKnowledgeBasePage
      parameters:
        - name: X-OA-User-Id
          in: header
          required: true
          schema: { type: string }
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: ok }
  /pages:
${withWriteOperations ? `
    post:
      operationId: createKnowledgeBaseNode
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string }
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
` : ""}
`;
}
