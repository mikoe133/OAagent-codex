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
  it("loads the read contract and reserves a missing write contract", async () => {
    const contracts = await resolveKnowledgeBaseContracts({
      projectRoot: agentRoot,
      knowledgeBaseReadOpenapiPath: path.join(
        agentRoot,
        "knowledgebaseapi",
        "knowledgebaseapi.yaml",
      ),
      knowledgeBaseWriteOpenapiPath: path.join(
        agentRoot,
        "knowledgebaseapi",
        "knowledgebase-write-api.yaml",
      ),
      knowledgeBaseApiGuidePath: path.join(
        agentRoot,
        "knowledgebaseapi",
        "AGENT_API.md",
      ),
    } as AppConfig);

    assert.deepEqual(
      contracts.read.index.operations.map((operation) => operation.operationId),
      [
        "getKnowledgeBasePage",
        "listKnowledgeBasePageChildren",
        "listKnowledgeBasePages",
        "searchKnowledgeBase",
      ],
    );
    assert.ok(
      contracts.read.index.operations.every(
        (operation) => operation.catalog === "knowledge_base_read",
      ),
    );
    assert.equal(contracts.write, null);
    assert.match(contracts.writePath, /knowledgebase-write-api\.yaml$/);
    assert.match(contracts.guidePath, /AGENT_API\.md$/);
  });
});

describe("multi-catalog OpenAPI routing", () => {
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

  it("does not substitute OA operations when the knowledge write contract is absent", async () => {
    const route = await routeOpenApiRequest(
      createConfig(),
      createCombinedIndex(),
      { task: "把知识库里的生产部署手册更新一下" },
      async () => {
        throw new Error("router unavailable");
      },
    );

    assert.deepEqual(route.catalogs, ["knowledge_base_write"]);
    assert.deepEqual(route.candidates, []);
  });

  it("describes the selected knowledge catalog and controlled helper", () => {
    const config = createConfig();
    const runtime = buildRuntimeContext(config, {
      sessionId: "session-1",
      hasSessionOaApiToken: true,
      hasSessionOaUserId: true,
      selectedApiCatalogs: ["knowledge_base_read"],
      knowledgeBaseWriteContractAvailable: false,
      openApiCandidates: createCombinedIndex().operations.filter(
        (operation) => operation.catalog === "knowledge_base_read",
      ),
    });

    assert.match(runtime, /当前路由接口域: knowledge_base_read/);
    assert.match(runtime, /callKnowledgeBaseApi\.mjs/);
    assert.match(runtime, /X-OA-User-Id.*自动注入/);
    assert.match(runtime, /知识库写接口文档.*尚未提供/);
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
    knowledgeBaseReadOpenapiPath: path.join(
      agentRoot,
      "knowledgebaseapi",
      "knowledgebaseapi.yaml",
    ),
    knowledgeBaseWriteOpenapiPath: path.join(
      agentRoot,
      "knowledgebaseapi",
      "knowledgebase-write-api.yaml",
    ),
    knowledgeBaseApiGuidePath: path.join(
      agentRoot,
      "knowledgebaseapi",
      "AGENT_API.md",
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
  ]);
}
