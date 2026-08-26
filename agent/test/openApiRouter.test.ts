import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config/config.js";
import {
  buildOpenApiIndex,
  mergeOpenApiIndexes,
} from "../src/infrastructure/oa/openApiIndex.js";
import {
  createOpenApiSemanticRouter,
  routeOpenApiCandidates,
  routeOpenApiRequest,
  routeOpenApiRequestWithFallback,
} from "../src/infrastructure/oa/openApiRouter.js";

describe("OpenAPI semantic router", () => {
  it("uses model-selected business domains and concepts instead of fixed user phrasing", async () => {
    const prompts: string[] = [];
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      {
        task: "RWKV Chat 最近忙些什么",
        conversationMemory: "上一轮已确认 RWKV Chat 是项目 28。",
      },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["project", "progress"],
        });
      },
    );

    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
    assert.ok(candidates.some((candidate) => candidate.path === "/projects/project"));
    assert.ok(candidates.every((candidate) => candidate.method === "GET"));

    assert.match(prompts[0] ?? "", /RWKV Chat 最近忙些什么/);
    assert.match(prompts[0] ?? "", /上一轮已确认 RWKV Chat 是项目 28/);
    assert.match(prompts[0] ?? "", /Github Commit Summaries/);
    assert.doesNotMatch(prompts[0] ?? "", /project-sync-internal|\/internal\//);
  });

  it("sends at most 20 locally ranked operation summaries to the semantic router", async () => {
    const prompts: string[] = [];
    await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createLargeContract()),
      { task: "RWKV Chat 项目最近有什么进展" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["project progress"],
        });
      },
    );

    const operations = readPromptOperations(prompts[0] ?? "");
    assert.equal(operations.length, 20);
    assert.ok(
      operations.some(
        (operation) =>
          operation.operationId ===
          "github_commit_summaries_projects_github_commit_summaries_get",
      ),
    );
    assert.ok(
      operations.every((operation) =>
        Object.keys(operation).every((key) =>
          [
            "operationId",
            "method",
            "path",
            "summary",
            "parameters",
            "requestBodyFields",
          ].includes(key),
        ),
      ),
    );
  });

  it("sends only bounded parameter names instead of complete operation schemas", async () => {
    const prompts: string[] = [];
    const index = buildOpenApiIndex(createContract());
    const operation = index.operations.find(
      (candidate) => candidate.operationId === "projects_projects_project_put",
    );
    assert.ok(operation);
    operation.parameters = [
      { name: "project_id", in: "path", required: true, type: "integer" },
      { name: "status", in: "query", required: false, type: "string" },
      { name: "owner_id", in: "query", required: false, type: "integer" },
      { name: "version", in: "query", required: false, type: "integer" },
      { name: "ignored_parameter", in: "query", required: false, type: "string" },
    ];
    operation.requestBodyFields = [
      "github_urls",
      "project_name",
      "description",
      "status",
      "ignored_body_field",
    ];
    operation.mainResponseFields = ["internal_response_details"];

    await routeOpenApiCandidates(
      createConfig(),
      index,
      { task: "更新项目的 GitHub 仓库地址" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: ["projects_projects_project_put"],
          accessMode: "write",
          searchTerms: ["update project github repository"],
        });
      },
    );

    const selected = readPromptOperations(prompts[0] ?? "").find(
      (candidate) => candidate.operationId === "projects_projects_project_put",
    );
    assert.ok(selected);
    assert.deepEqual(selected.parameters, [
      "project_id",
      "status",
      "owner_id",
      "version",
    ]);
    assert.deepEqual(selected.requestBodyFields, [
      "github_urls",
      "project_name",
      "description",
      "status",
    ]);
    assert.doesNotMatch(
      JSON.stringify(selected),
      /ignored_parameter|ignored_body_field|internal_response_details|"required"|"type"/,
    );
  });

  it("keeps only the most recent 1000 characters of conversation memory", async () => {
    const prompts: string[] = [];
    const recentSummary = "最近确认 RWKV Chat 对应项目 28，用户正在追问项目进展。";
    await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      {
        task: "它现在的进度如何？",
        conversationMemory: `最早需要遗忘的上下文${"旧".repeat(1_500)}${recentSummary}`,
      },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["project progress"],
        });
      },
    );

    const input = readRouterPromptInput(prompts[0] ?? "");
    assert.ok(input.conversationMemory.length <= 1_000);
    assert.ok(input.conversationMemory.endsWith(recentSummary));
    assert.doesNotMatch(input.conversationMemory, /最早需要遗忘的上下文/);
  });

  it("uses recent conversation context to shortlist ambiguous follow-up requests", async () => {
    const prompts: string[] = [];
    await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createLargeContract()),
      {
        task: "它最近怎么样？",
        conversationMemory: "上一轮确认 RWKV Chat 是项目 28，用户希望了解 GitHub 提交摘要。",
      },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["project github commit summaries"],
        });
      },
    );

    const operations = readPromptOperations(prompts[0] ?? "");
    assert.equal(operations.length, 20);
    assert.ok(
      operations.some(
        (operation) =>
          operation.operationId ===
          "github_commit_summaries_projects_github_commit_summaries_get",
      ),
    );
  });

  it("keeps OA and knowledge-base operations in one bounded multi-intent shortlist", async () => {
    const prompts: string[] = [];
    const index = mergeOpenApiIndexes([
      buildOpenApiIndex(createLargeContract()),
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

    await routeOpenApiCandidates(
      createConfig(),
      index,
      { task: "查公司的部署制度说明，并查询 RWKV Chat 项目的最近进展" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          catalogs: ["knowledge_base_read", "oa"],
          tags: ["untagged", "projects"],
          operationIds: [
            "searchKnowledgeBase",
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["deployment policy", "project progress"],
        });
      },
    );

    const operations = readPromptOperations(prompts[0] ?? "");
    assert.equal(operations.length, 20);
    assert.ok(
      operations.some(
        (operation) => operation.operationId === "searchKnowledgeBase",
      ),
    );
    assert.ok(
      operations.some(
        (operation) =>
          operation.operationId ===
          "github_commit_summaries_projects_github_commit_summaries_get",
      ),
    );
  });

  it("preserves explicit project mutation operations in the bounded shortlist", async () => {
    const prompts: string[] = [];
    await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createLargeContract()),
      { task: "更新 RWKV Chat 项目的配置信息" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["projects"],
          operationIds: ["projects_projects_project_put"],
          accessMode: "write",
          searchTerms: ["update project configuration"],
        });
      },
    );

    const operations = readPromptOperations(prompts[0] ?? "");
    assert.equal(operations.length, 20);
    assert.ok(
      operations.some(
        (operation) =>
          operation.operationId === "projects_projects_project_put" &&
          operation.method === "PUT",
      ),
    );
  });

  it("falls back to deterministic candidates when semantic routing is unavailable", async () => {
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "查看项目列表", conversationMemory: null },
      async () => {
        throw new Error("unavailable");
      },
    );

    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((candidate) => !candidate.path.startsWith("/internal/")));
  });

  it("keeps OA and knowledge-base read capabilities when semantic routing fails ambiguously", async () => {
    const result = await routeOpenApiRequest(
      createConfig(),
      mergeOpenApiIndexes([
        buildOpenApiIndex(createContract()),
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
            },
          },
          "knowledge_base_read",
        ),
      ]),
      { task: "怎么连接公司 NAS", conversationMemory: null },
      async () => {
        throw new Error("upstream unavailable");
      },
    );

    assert.deepEqual(result.catalogs, ["oa", "knowledge_base_read"]);
    assert.ok(result.candidates.some((candidate) => candidate.catalog === "oa"));
    assert.ok(
      result.candidates.some(
        (candidate) => candidate.catalog === "knowledge_base_read",
      ),
    );
    assert.deepEqual(result.diagnostics, {
      strategy: "fallback",
      failureReason: "路由模型服务暂时不可用",
    });
  });

  it("keeps clearly structured OA requests scoped to OA after routing fails", async () => {
    const result = await routeOpenApiRequest(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "查看项目列表" },
      async () => {
        throw new Error("upstream unavailable");
      },
    );

    assert.deepEqual(result.catalogs, ["oa"]);
    assert.ok(result.candidates.every((candidate) => candidate.catalog === "oa"));
  });

  it("classifies route failures without exposing raw upstream error details", async () => {
    const cases: Array<[Error, string]> = [
      [
        Object.assign(new Error("request exceeded its deadline"), {
          name: "TimeoutError",
        }),
        "路由模型超时（8 秒）",
      ],
      [new Error("429 too many requests"), "路由模型请求被限流"],
      [new Error("401 unauthorized secret-provider-key"), "路由模型鉴权失败"],
      [new Error("semantic router returned an unusable route"), "路由模型返回结果无效"],
      [new Error("unexpected secret-provider-key"), "路由模型调用异常"],
    ];

    for (const [error, expectedReason] of cases) {
      const result = await routeOpenApiRequest(
        createConfig(),
        buildOpenApiIndex(createContract()),
        { task: "查看项目列表" },
        async () => {
          throw error;
        },
      );

      assert.deepEqual(result.diagnostics, {
        strategy: "fallback",
        failureReason: expectedReason,
      });
      assert.doesNotMatch(JSON.stringify(result.diagnostics), /secret-provider-key/);
    }
  });

  it("treats a missing access mode as a read route instead of discarding semantic operationIds", async () => {
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "RWKV Chat 项目目前进展如何", conversationMemory: null },
      async () =>
        JSON.stringify({
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          searchTerms: ["recent commit summaries"],
        }),
    );

    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
    assert.ok(candidates.every((candidate) => candidate.method === "GET"));
  });

  it("retries an invalid semantic route before falling back", async () => {
    let attempts = 0;
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "最近有什么代码改动", conversationMemory: null },
      async () => {
        attempts += 1;
        return attempts === 1
          ? JSON.stringify({ tags: [], operationIds: [], searchTerms: [] })
          : JSON.stringify({
              tags: ["projects"],
              operationIds: [
                "github_commit_summaries_projects_github_commit_summaries_get",
              ],
              accessMode: "read",
              searchTerms: ["recent code changes"],
            });
      },
    );

    assert.equal(attempts, 2);
    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });

  it("expands an unusable Top 20 route to at most 40 candidates before fallback", async () => {
    const prompts: string[] = [];
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createLargeContract()),
      { task: "RWKV Chat 项目最近有什么进展" },
      async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? JSON.stringify({ tags: [], operationIds: [], searchTerms: [] })
          : JSON.stringify({
              tags: ["projects"],
              operationIds: [
                "github_commit_summaries_projects_github_commit_summaries_get",
              ],
              accessMode: "read",
              searchTerms: ["recent project progress"],
            });
      },
    );

    assert.equal(prompts.length, 2);
    assert.equal(readPromptOperations(prompts[0] ?? "").length, 20);
    assert.equal(readPromptOperations(prompts[1] ?? "").length, 40);
    assert.match(prompts[1] ?? "", /repair attempt/i);
    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });

  it("expands the shortlist when the model selects an operation outside Top 20", async () => {
    const prompts: string[] = [];
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createLargeContract()),
      { task: "查询考勤记录" },
      async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          tags: ["attendance"],
          operationIds: ["attendance_archive_25_get"],
          accessMode: "read",
          searchTerms: ["attendance archive"],
        });
      },
    );

    assert.equal(prompts.length, 2);
    assert.equal(readPromptOperations(prompts[0] ?? "").length, 20);
    assert.equal(readPromptOperations(prompts[1] ?? "").length, 40);
    assert.equal(candidates[0]?.operationId, "attendance_archive_25_get");
  });

  it("keeps public activity endpoints in the progress fallback", async () => {
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "RWKV Chat 项目目前进展如何", conversationMemory: null },
      async () => {
        throw new Error("semantic router unavailable");
      },
    );

    assert.ok(
      candidates.some(
        (candidate) =>
          candidate.operationId ===
          "github_commit_summaries_projects_github_commit_summaries_get",
      ),
    );
  });

  it("runs semantic classification through a lightweight OpenAI-compatible API", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const router = createOpenApiSemanticRouter(
      createConfig(),
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  catalogs: ["oa"],
                  tags: ["projects"],
                  operationIds: [
                    "github_commit_summaries_projects_github_commit_summaries_get",
                  ],
                  accessMode: "read",
                  searchTerms: ["commit summaries"],
                }),
              },
            },
          ],
        });
      },
    );

    const signal = AbortSignal.timeout(1_000);
    const response = await router("route this request", { signal });
    const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;

    assert.equal(requestUrl, "https://models.example.test/v1/chat/completions");
    assert.equal(requestInit?.method, "POST");
    assert.equal(
      new Headers(requestInit?.headers).get("authorization"),
      "Bearer test-key",
    );
    assert.equal(requestInit?.signal, signal);
    assert.equal(body.model, "gpt-5.6-terra");
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.response_format.type, "json_schema");
    assert.match(JSON.stringify(body.response_format), /operationIds/);
    assert.match(response, /commit summaries/);
  });

  it("disables Qwen reasoning so structured routing returns JSON directly", async () => {
    let requestInit: RequestInit | undefined;
    const router = createOpenApiSemanticRouter(
      {
        ...createConfig(),
        modelProvider: "openrouter",
        model: "qwen/qwen3.5-flash-02-23",
        modelProviders: {
          ...createConfig().modelProviders,
          openrouter: {
            name: "OpenRouter",
            apiKey: "router-key",
            baseUrl: "https://openrouter.example/v1",
            envKey: "OPENROUTER_API_KEY",
          },
        },
      },
      async (_input, init) => {
        requestInit = init;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ ok: true }),
              },
            },
          ],
        });
      },
    );

    await router("route this request");

    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    assert.deepEqual(body.reasoning, { effort: "none" });
  });

  it("accepts reasoning-only JSON returned by reasoning-capable router models", async () => {
    const router = createOpenApiSemanticRouter(
      createConfig(),
      async () =>
        Response.json({
          choices: [
            {
              message: {
                content: null,
                reasoning: [
                  "I classified the request.\n```json\n",
                  JSON.stringify({
                    catalogs: ["oa"],
                    tags: ["projects"],
                    operationIds: [
                      "github_commit_summaries_projects_github_commit_summaries_get",
                    ],
                    accessMode: "read",
                    searchTerms: ["project progress"],
                  }),
                  "\n```",
                ].join(""),
              },
            },
          ],
        }),
    );

    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "项目最近进展" },
      router,
    );

    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });

  it("normalizes compatible singular and string route fields", async () => {
    const candidates = await routeOpenApiCandidates(
      createConfig(),
      buildOpenApiIndex(createContract()),
      { task: "项目最近进展" },
      async () =>
        JSON.stringify({
          catalog: "oa",
          tags: "projects",
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: "project progress, recent activity",
        }),
    );

    assert.equal(
      candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });

  it("uses a second semantic model when the selected router returns invalid output", async () => {
    const index = buildOpenApiIndex(createContract());
    const fallback = await routeOpenApiRequestWithFallback(
      createConfig(),
      index,
      { task: "怎么连接公司 NAS" },
      async () => "-1.000000000000000000000000000000000000000000000000000000000000",
      async () =>
        JSON.stringify({
          catalogs: ["oa"],
          tags: ["projects"],
          operationIds: [
            "github_commit_summaries_projects_github_commit_summaries_get",
          ],
          accessMode: "read",
          searchTerms: ["project progress"],
        }),
    );

    assert.deepEqual(fallback.diagnostics, {
      strategy: "semantic",
      usedFallbackModel: true,
    });
    assert.equal(
      fallback.candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });

  it("starts both semantic models concurrently and cancels the slower winner", async () => {
    const index = buildOpenApiIndex(createContract());
    const started: string[] = [];
    let primaryAborted = false;
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const recordStarted = (source: string) => {
      started.push(source);
      if (started.length === 2) {
        resolveBothStarted();
      }
    };
    const route = JSON.stringify({
      catalogs: ["oa"],
      tags: ["projects"],
      operationIds: [
        "github_commit_summaries_projects_github_commit_summaries_get",
      ],
      accessMode: "read",
      searchTerms: ["project progress"],
    });

    const resultPromise = routeOpenApiRequestWithFallback(
      createConfig(),
      index,
      { task: "项目最近进展" },
      async (_prompt, options) => {
        recordStarted("primary");
        await bothStarted;
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            primaryAborted = true;
            reject(new Error("aborted"));
          });
        });
        return route;
      },
      async () => {
        recordStarted("fallback");
        await bothStarted;
        return route;
      },
    );

    const result = await resultPromise;
    assert.deepEqual(started, ["primary", "fallback"]);
    assert.equal(primaryAborted, true);
    assert.equal(result.diagnostics.strategy, "semantic");
    assert.equal(
      result.candidates[0]?.operationId,
      "github_commit_summaries_projects_github_commit_summaries_get",
    );
  });
});

type RouterPromptOperation = {
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  parameters?: string[];
  requestBodyFields?: string[];
};

type RouterPromptInput = {
  conversationMemory: string;
  operationGroups: Array<{ operations: RouterPromptOperation[] }>;
};

function readRouterPromptInput(prompt: string): RouterPromptInput {
  const match = prompt.match(/<router_input>\n([\s\S]*?)\n<\/router_input>/);
  assert.ok(match?.[1], "expected a structured semantic routing prompt");
  return JSON.parse(match[1]) as RouterPromptInput;
}

function readPromptOperations(prompt: string): RouterPromptOperation[] {
  return readRouterPromptInput(prompt).operationGroups.flatMap(
    (group) => group.operations,
  );
}

function createConfig(): AppConfig {
  return {
    modelProvider: "nexttoken",
    model: "gpt-5.6-terra",
    modelRelayBaseUrl: null,
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

function createLargeContract() {
  const contract = createContract();
  const paths: Record<string, unknown> = { ...contract.paths };

  for (let index = 0; index < 60; index += 1) {
    const suffix = String(index).padStart(2, "0");
    paths[`/attendance/archive-${suffix}`] = {
      get: {
        operationId: `attendance_archive_${suffix}_get`,
        summary: `Attendance archive ${suffix}`,
        tags: index === 0 ? ["attendance", "archive"] : ["attendance"],
        responses: { "200": { description: "ok" } },
      },
    };
  }

  return { ...contract, paths };
}

function createContract() {
  const response = { "200": { description: "ok" } };
  return {
    openapi: "3.1.0",
    paths: {
      "/projects/list-by-project": {
        get: {
          operationId: "projects_list_projects_list_by_project_get",
          summary: "Projects List",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/project": {
        get: {
          operationId: "projects_projects_project_get",
          summary: "Projects",
          tags: ["projects"],
          responses: response,
        },
        put: {
          operationId: "projects_projects_project_put",
          summary: "Projects",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/github-commit-summaries": {
        get: {
          operationId: "github_commit_summaries_projects_github_commit_summaries_get",
          summary: "Github Commit Summaries",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/project-milestones/{project_id}": {
        get: {
          operationId: "project_milestones_projects_project_milestones__project_id__get",
          summary: "Project Milestones",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/list-by-person": {
        get: {
          operationId: "projects_list_projects_list_by_person_get",
          summary: "Projects List",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/user-issue": {
        get: {
          operationId: "projects_projects_user_issue_get",
          summary: "Projects",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/issue-actions": {
        get: {
          operationId: "issue_actions_projects_issue_actions_get",
          summary: "Issue Actions",
          tags: ["projects"],
          responses: response,
        },
      },
      "/weekly-report/report-list": {
        get: {
          operationId: "weekly_report_list_get",
          summary: "Weekly Report List",
          tags: ["weekly_report"],
          responses: response,
        },
      },
      "/internal/project-sync/github-commit-summaries": {
        get: {
          operationId: "project_sync_commit_summaries_internal_get",
          summary: "Project Sync Commit Summaries",
          tags: ["project-sync-internal"],
          responses: response,
        },
      },
    },
  };
}
