import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildOpenApiIndex,
  resolveOpenApiIndex,
  selectOpenApiCandidates,
} from "../src/infrastructure/oa/openApiIndex.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("OpenAPI operation index", () => {
  it("extracts operation metadata, parameters, response fields, and permissions", () => {
    const index = buildOpenApiIndex(createContract());
    const userList = index.operations.find(
      (operation) => operation.operationId === "user_info_user_user_list_get",
    );
    const taggedAdmin = index.operations.find(
      (operation) => operation.operationId === "staff_directory_admin_get",
    );

    assert.ok(userList);
    assert.equal(userList.method, "GET");
    assert.equal(userList.path, "/user/user-list");
    assert.equal(userList.summary, "User Info");
    assert.deepEqual(userList.tags, ["user"]);
    assert.equal(userList.permissionLevel, "user");
    assert.deepEqual(userList.parameters, [
      { name: "is_active", in: "query", required: false, type: "boolean" },
    ]);
    assert.ok(userList.mainResponseFields.includes("data[].full_name"));
    assert.ok(userList.mainResponseFields.includes("data[].email"));
    assert.equal(taggedAdmin?.permissionLevel, "admin");
  });

  it("caches the generated index by OpenAPI content hash", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "oa-openapi-index-test-"));
    temporaryDirectories.push(projectRoot);
    const contract = createContract();

    const first = await resolveOpenApiIndex(projectRoot, contract);
    const second = await resolveOpenApiIndex(projectRoot, contract);
    const persisted = JSON.parse(
      await readFile(path.join(projectRoot, ".context", "openapi-index.json"), "utf8"),
    );

    assert.deepEqual(second, first);
    assert.equal(persisted.documentHash, first.documentHash);
    assert.equal(persisted.operations.length, first.operations.length);

    const changedContract = createContract();
    changedContract.paths["/department/list"] = {
      get: {
        operationId: "department_list_get",
        summary: "Department List",
        tags: ["department"],
        responses: { "200": { description: "ok" } },
      },
    };
    const changed = await resolveOpenApiIndex(projectRoot, changedContract);
    const changedPersisted = JSON.parse(
      await readFile(path.join(projectRoot, ".context", "openapi-index.json"), "utf8"),
    );

    assert.notEqual(changed.documentHash, first.documentHash);
    assert.equal(changedPersisted.documentHash, changed.documentHash);
    assert.equal(changed.operations.length, first.operations.length + 1);
  });

  it("returns only the five most relevant candidates and prefers ordinary access", () => {
    const index = buildOpenApiIndex(createContract());
    const candidates = selectOpenApiCandidates(index, "薛屹阳的个人信息");

    assert.equal(candidates.length, 5);
    assert.equal(candidates[0]?.operationId, "user_info_user_user_list_get");
    assert.notEqual(candidates[0]?.permissionLevel, "admin");
  });

  it("ranks the requested business resource above adjacent maintenance endpoints", () => {
    const index = buildOpenApiIndex(createContract());
    const statistics = selectOpenApiCandidates(
      index,
      "统计各部门本月周报趋势",
    );
    const write = selectOpenApiCandidates(index, "修改第 101 周周报");

    assert.match(statistics[0]?.path ?? "", /^\/weekly-report\//);
    assert.equal(write[0]?.operationId, "weekly_report_report_post");
  });

  it("prioritizes the company project list for project inventory and repository queries", () => {
    const index = buildOpenApiIndex(createProjectContract());

    for (const task of [
      "查看公司项目列表",
      "当前公司有哪些项目",
      "哪些项目有 GitHub 仓库地址",
    ]) {
      assert.equal(
        selectOpenApiCandidates(index, task)[0]?.operationId,
        "projects_list_projects_list_by_project_get",
        task,
      );
    }
    assert.notEqual(
      selectOpenApiCandidates(index, "查询项目 GitHub 提交摘要")[0]?.operationId,
      "projects_list_projects_list_by_project_get",
    );
  });

  it("indexes project and GitHub repository fields from the bundled project list schema", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi/openapi.json", import.meta.url), "utf8"),
    ) as unknown;
    const projectList = buildOpenApiIndex(contract).operations.find(
      (operation) =>
        operation.operationId === "projects_list_projects_list_by_project_get",
    );

    assert.ok(projectList);
    assert.ok(projectList.mainResponseFields.includes("data.items[].id"));
    assert.ok(projectList.mainResponseFields.includes("data.items[].project_name"));
    assert.ok(projectList.mainResponseFields.includes("data.items[].status"));
    assert.ok(projectList.mainResponseFields.includes("data.items[].github_urls"));
  });

  it("handles referenced metadata, public operations, and candidate bounds", () => {
    const referenced = buildOpenApiIndex({
      openapi: "3.1.0",
      components: {
        parameters: {
          Query: {
            name: "query",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/public/search": {
          get: {
            operationId: "public_search_get",
            security: [],
            parameters: [{ $ref: "#/components/parameters/Query" }],
            responses: {
              default: {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          properties: { result: { type: "string" } },
                        },
                        { type: "null" },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/ignored": null,
        "/missing-operation-id": { get: { responses: {} } },
      },
    });
    const operation = referenced.operations[0];
    const mainIndex = buildOpenApiIndex(createContract());

    assert.equal(operation?.permissionLevel, "public");
    assert.deepEqual(operation?.parameters, [
      { name: "query", in: "query", required: true, type: "string" },
    ]);
    assert.ok(operation?.mainResponseFields.includes("result"));
    assert.equal(selectOpenApiCandidates(mainIndex, "用户信息", 1).length, 3);
    assert.equal(selectOpenApiCandidates(mainIndex, "用户信息", 10).length, 5);
    assert.equal(
      selectOpenApiCandidates(mainIndex, "管理员用户列表")[0]?.permissionLevel,
      "admin",
    );
  });

  it("regenerates an invalid persisted cache", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "oa-openapi-index-invalid-"));
    temporaryDirectories.push(projectRoot);
    const cacheDirectory = path.join(projectRoot, ".context");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(path.join(cacheDirectory, "openapi-index.json"), "{invalid", "utf8");

    const resolved = await resolveOpenApiIndex(projectRoot, createContract());

    assert.ok(resolved.operations.length > 0);
    assert.equal(
      JSON.parse(
        await readFile(path.join(cacheDirectory, "openapi-index.json"), "utf8"),
      ).documentHash,
      resolved.documentHash,
    );
  });
});

function createContract() {
  return {
    openapi: "3.1.0",
    info: { title: "OA", version: "1.0.0" },
    components: {
      schemas: {
        User: {
          type: "object",
          properties: {
            full_name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    },
    paths: {
      "/user/user-list": {
        get: {
          operationId: "user_info_user_user_list_get",
          summary: "User Info",
          tags: ["user"],
          parameters: [
            {
              name: "is_active",
              in: "query",
              required: false,
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/User" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/admin/user-list": {
        get: {
          operationId: "user_list_admin_user_list_get",
          summary: "User List",
          tags: ["admin"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/staff-directory": {
        get: {
          operationId: "staff_directory_admin_get",
          summary: "Staff Directory",
          tags: ["admin"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/weekly-report/list": {
        get: {
          operationId: "weekly_report_list_get",
          summary: "Weekly Report List",
          tags: ["weekly-report"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/weekly-report/report": {
        post: {
          operationId: "weekly_report_report_post",
          summary: "Weekly Report",
          tags: ["weekly-report"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/weekly-report/days/holiday": {
        put: {
          operationId: "update_weekly_report_days_holiday_put",
          summary: "Update Weekly Report Days Holiday",
          tags: ["weekly-report"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/project/stats": {
        get: {
          operationId: "project_stats_get",
          summary: "Project Statistics",
          tags: ["project"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/leave/list": {
        get: {
          operationId: "leave_list_get",
          summary: "Leave List",
          tags: ["leave"],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function createProjectContract() {
  const response = { "200": { description: "ok" } };
  return {
    openapi: "3.1.0",
    info: { title: "OA", version: "1.0.0" },
    paths: {
      "/projects/list-by-project": {
        get: {
          operationId: "projects_list_projects_list_by_project_get",
          summary: "Projects List",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/github-commit-summaries": {
        get: {
          operationId:
            "github_commit_summaries_projects_github_commit_summaries_get",
          summary: "Github Commit Summaries",
          tags: ["projects"],
          responses: response,
        },
      },
      "/projects/github-commit-summary": {
        get: {
          operationId: "github_commit_summary_projects_github_commit_summary_get",
          summary: "Github Commit Summary",
          tags: ["projects"],
          responses: response,
        },
        post: {
          operationId:
            "create_github_commit_summary_projects_github_commit_summary_post",
          summary: "Create Github Commit Summary",
          tags: ["projects"],
          responses: response,
        },
        put: {
          operationId:
            "update_github_commit_summary_projects_github_commit_summary_put",
          summary: "Update Github Commit Summary",
          tags: ["projects"],
          responses: response,
        },
        delete: {
          operationId:
            "delete_github_commit_summary_projects_github_commit_summary_delete",
          summary: "Delete Github Commit Summary",
          tags: ["projects"],
          responses: response,
        },
      },
    },
  };
}
