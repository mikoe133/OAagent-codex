import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRuntimeContext } from "../src/application/runCodexAgent.js";
import type { AppConfig } from "../src/config/config.js";
import { resolveKnowledgeBaseContracts } from "../src/infrastructure/knowledgebase/knowledgeBaseContract.js";
import {
  buildOpenApiIndex,
  mergeOpenApiIndexes,
} from "../src/infrastructure/oa/openApiIndex.js";
import { routeOpenApiRequest } from "../src/infrastructure/oa/openApiRouter.js";

const agentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("knowledge base contracts", () => {
  it("splits the unified contract into read and write catalogs", async () => {
    const contracts = await resolveKnowledgeBaseContracts({
      projectRoot: agentRoot,
      knowledgeBaseOpenapiPath: path.join(
        agentRoot,
        "knowledgebaseapi",
        "knowledgebaseapi.yaml",
      ),
    } as AppConfig);

    assert.ok(
      contracts.read.index.operations.some(
        (operation) => operation.operationId === "searchKnowledgeBase",
      ),
    );
    assert.ok(
      contracts.read.index.operations.every(
        (operation) =>
          operation.catalog === "knowledge_base_read" &&
          operation.method === "GET",
      ),
    );
    assert.ok(contracts.write);
    assert.ok(
      contracts.write.index.operations.some(
        (operation) => operation.operationId === "createKnowledgeBaseNode",
      ),
    );
    assert.ok(
      contracts.write.index.operations.every(
        (operation) =>
          operation.catalog === "knowledge_base_write" &&
          operation.method !== "GET",
      ),
    );
    assert.equal(contracts.read.path, contracts.write.path);
  });
});

describe("multi-catalog OpenAPI routing", () => {
  it("keeps both knowledge-base and OA candidates for a mixed multi-question request", async () => {
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      {
        task: "请告诉我公司的制度说明，并查询我的周报记录。",
      },
      async () =>
        JSON.stringify({
          catalogs: ["knowledge_base_read", "oa"],
          tags: ["untagged", "weekly_report"],
          operationIds: [
            "searchKnowledgeBase",
            "getKnowledgeBasePage",
            "listWeeklyReports",
          ],
          accessMode: "read",
          searchTerms: ["company policy", "weekly reports"],
        }),
    );

    assert.deepEqual(route.catalogs, ["knowledge_base_read", "oa"]);
    assert.ok(
      route.candidates.some(
        (candidate) => candidate.catalog === "knowledge_base_read",
      ),
    );
    assert.ok(
      route.candidates.some((candidate) => candidate.catalog === "oa"),
    );
  });

  it("routes document-content questions to knowledge base operations", async () => {
    const prompts: string[] = [];
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      { task: "生产部署手册里对数据库迁移有什么要求？" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          catalogs: ["knowledge_base_read"],
          tags: ["untagged"],
          operationIds: ["searchKnowledgeBase", "getKnowledgeBasePage"],
          accessMode: "read",
          searchTerms: ["production deployment database migration"],
        });
      },
    );

    assert.deepEqual(route.catalogs, ["knowledge_base_read"]);
    assert.equal(route.candidates[0]?.operationId, "searchKnowledgeBase");
    assert.ok(
      route.candidates.every(
        (candidate) => candidate.catalog === "knowledge_base_read",
      ),
    );
    assert.match(prompts[0] ?? "", /knowledge_base_read/);
    assert.match(prompts[0] ?? "", /structured OA records/i);
    assert.match(prompts[0] ?? "", /internal document content/i);
  });

  it("keeps employee profile lookups on structured OA APIs", async () => {
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      { task: "查一下王小明的员工资料和邮箱" },
      async () =>
        JSON.stringify({
          catalogs: ["oa"],
          tags: ["user"],
          operationIds: ["getOaUserList"],
          accessMode: "read",
          searchTerms: ["employee profile email"],
        }),
    );

    assert.deepEqual(route.catalogs, ["oa"]);
    assert.ok(route.candidates.every((candidate) => candidate.catalog === "oa"));
  });

  it("prefers the flat project list when looking up a named project's updates", async () => {
    const projectIndex = buildOpenApiIndex(
      {
        openapi: "3.1.0",
        paths: {
          "/projects/list-by-project": {
            get: {
              operationId: "projects_list_projects_list_by_project_get",
              summary: "Projects List",
              tags: ["projects"],
              responses: { "200": { description: "ok" } },
            },
          },
          "/projects/list-by-person": {
            get: {
              operationId: "projects_list_projects_list_by_person_get",
              summary: "Projects List",
              tags: ["projects"],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      "oa",
    );
    const route = await routeOpenApiRequest(
      createConfig(),
      projectIndex,
      { task: "RWKV Chat 项目目前有什么更新吗？" },
      async () =>
        JSON.stringify({
          catalogs: ["oa"],
          tags: ["projects"],
          operationIds: ["projects_list_projects_list_by_person_get"],
          accessMode: "read",
          searchTerms: ["project updates"],
        }),
    );

    assert.equal(
      route.candidates[0]?.operationId,
      "projects_list_projects_list_by_project_get",
    );
  });

  it("falls back to knowledge base search when semantic routing is unavailable", async () => {
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      { task: "公司的报销制度文档怎么规定？" },
      async () => {
        throw new Error("router unavailable");
      },
    );

    assert.deepEqual(route.catalogs, ["knowledge_base_read"]);
    assert.equal(route.candidates[0]?.operationId, "searchKnowledgeBase");
    assert.ok(
      route.candidates.every(
        (candidate) => candidate.catalog === "knowledge_base_read",
      ),
    );
  });

  it("routes knowledge mutations to unified-contract write operations", async () => {
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      { task: "把知识库里的生产部署手册更新一下" },
      async () => {
        throw new Error("router unavailable");
      },
    );

    assert.deepEqual(route.catalogs, ["knowledge_base_write"]);
    assert.equal(route.candidates[0]?.operationId, "createKnowledgeBaseNode");
    assert.ok(
      route.candidates.every(
        (candidate) => candidate.catalog === "knowledge_base_write",
      ),
    );
  });

  it("describes the selected knowledge catalog and controlled helper", () => {
    const config = createConfig();
    const runtime = buildRuntimeContext(config, {
      sessionId: "session-1",
      hasSessionOaApiToken: true,
      hasSessionOaUserId: true,
      selectedApiCatalogs: ["knowledge_base_read"],
      knowledgeBaseWriteContractAvailable: true,
      openApiCandidates: createCombinedIndex().operations.filter(
        (operation) => operation.catalog === "knowledge_base_read",
      ),
    });

    assert.match(runtime, /当前路由接口域: knowledge_base_read/);
    assert.match(runtime, /callKnowledgeBaseApi\.mjs/);
    assert.match(runtime, /Authorization.*X-OA-User-Id.*自动注入/);
    assert.match(runtime, /Idempotency-Key.*自动生成/);
    assert.match(runtime, /知识库读写接口文档.*knowledgebaseapi\.yaml/);
    assert.match(runtime, /完整核心短语/);
    assert.match(runtime, /服务端按语义长度动态补查/);
    assert.match(runtime, /多个知识库子问题.*分别/);
    assert.match(runtime, /总上限 3 次/);
    assert.doesNotMatch(runtime, /AGENT_API\.md/);
    assert.doesNotMatch(runtime, /知识库写接口文档.*尚未提供/);
    assert.match(runtime, /写操作.*用户确认/);
    assert.doesNotMatch(runtime, /知识库.*callOaApi\.mjs/);
  });
});

function createConfig(): AppConfig {
  return {
    projectRoot: agentRoot,
    modelProvider: "nexttoken",
    model: "gpt-5.6-terra",
    modelRelayBaseUrl: null,
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    openapiPath: path.join(agentRoot, "openapi", "openapi.json"),
    knowledgeBaseApiBaseUrl: "https://kb.example.test/api/agent/v1",
    knowledgeBaseApiToken: "knowledge-service-token",
    knowledgeBaseOpenapiPath: path.join(
      agentRoot,
      "knowledgebaseapi",
      "knowledgebaseapi.yaml",
    ),
    modelProviders: {
      nexttoken: {
        name: "Nexttoken",
        apiKey: "test-key",
        baseUrl: "https://models.example.test/v1",
        envKey: "NEXTTOKEN_API_KEY",
      },
    },
  } as AppConfig;
}

function createCombinedIndex() {
  return mergeOpenApiIndexes([
    buildOpenApiIndex(
      {
        openapi: "3.1.0",
        paths: {
          "/user/user-list": {
            get: {
              operationId: "getOaUserList",
              summary: "Employee profiles",
              tags: ["user"],
              responses: { "200": { description: "ok" } },
            },
          },
          "/weekly-report/report-list": {
            get: {
              operationId: "listWeeklyReports",
              summary: "Weekly report list",
              tags: ["weekly_report"],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      "oa",
    ),
    buildOpenApiIndex(
      {
        openapi: "3.1.0",
        paths: {
          "/search": {
            get: {
              operationId: "searchKnowledgeBase",
              summary: "搜索当前用户可见页面",
              responses: { "200": { description: "ok" } },
            },
          },
          "/pages/{id}": {
            get: {
              operationId: "getKnowledgeBasePage",
              summary: "读取页面正文",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      "knowledge_base_read",
    ),
    buildOpenApiIndex(
      {
        openapi: "3.1.0",
        paths: {
          "/pages": {
            post: {
              operationId: "createKnowledgeBaseNode",
              summary: "创建空页面或目录",
              responses: { "201": { description: "created" } },
            },
          },
        },
      },
      "knowledge_base_write",
    ),
  ]);
}
