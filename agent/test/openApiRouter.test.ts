import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config/config.js";
import { buildOpenApiIndex } from "../src/infrastructure/oa/openApiIndex.js";
import {
  createOpenApiSemanticRouter,
  routeOpenApiCandidates,
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

  it("runs semantic classification through a locked-down Codex SDK thread", async () => {
    let threadOptions: Record<string, unknown> | undefined;
    let turnOptions: Record<string, unknown> | undefined;
    const router = createOpenApiSemanticRouter(createConfig(), {
      startThread(options) {
        threadOptions = options as Record<string, unknown>;
        return {
          async run(_prompt, options) {
            turnOptions = options as Record<string, unknown>;
            return {
              finalResponse: JSON.stringify({
                tags: ["projects"],
                operationIds: [
                  "github_commit_summaries_projects_github_commit_summaries_get",
                ],
                accessMode: "read",
                searchTerms: ["commit summaries"],
              }),
            };
          },
        };
      },
    });

    await router("route this request");

    assert.equal(threadOptions?.sandboxMode, "read-only");
    assert.equal(threadOptions?.networkAccessEnabled, false);
    assert.equal(threadOptions?.webSearchMode, "disabled");
    assert.equal(threadOptions?.approvalPolicy, "never");
    assert.equal(threadOptions?.modelReasoningEffort, "low");
    assert.match(JSON.stringify(turnOptions?.outputSchema), /operationIds/);
  });
});

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
