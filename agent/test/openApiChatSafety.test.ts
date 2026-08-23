import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AppConfig } from "../src/config/config.js";
import { callOaApiTool } from "../src/infrastructure/oa/oaApiTool.js";
import { isChatOpenApiOperationAllowed } from "../src/infrastructure/oa/openApiChatPolicy.js";
import { resolveOpenApiContract } from "../src/infrastructure/oa/openApiContract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("chat OpenAPI safety", () => {
  it("does not hide an ordinary operation for an incidental admin substring", () => {
    assert.equal(
      isChatOpenApiOperationAllowed("/domains", {
        operationId: "domain_info_get",
        tags: ["nonadmin"],
      }),
      true,
    );
    assert.equal(
      isChatOpenApiOperationAllowed("/internalization-guides", {
        operationId: "internalization_guides_get",
        tags: ["internationalization"],
      }),
      true,
    );
  });

  it("hides internal service operations from chat", () => {
    assert.equal(
      isChatOpenApiOperationAllowed("/internal/project-sync/projects", {
        operationId: "project_sync_projects_get",
        tags: ["projects"],
      }),
      false,
    );
    assert.equal(
      isChatOpenApiOperationAllowed("/project-sync/projects", {
        operationId: "project_sync_projects_get",
        tags: ["project-sync-internal"],
      }),
      false,
    );
  });

  it("materializes and indexes a contract without administrator operations", async () => {
    const fixture = await createFixture();
    const resolved = await resolveOpenApiContract(
      fixture.config,
      async () => Response.json(fixture.contract),
    );
    const document = resolved.document as {
      paths: Record<string, Record<string, unknown>>;
    };
    const materialized = JSON.parse(await readFile(resolved.path, "utf8")) as {
      paths: Record<string, Record<string, unknown>>;
    };

    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/mixed",
      "/user/user-list",
    ]);
    assert.equal("delete" in document.paths["/mixed"]!, false);
    assert.deepEqual(document.paths["/mixed"]!.parameters, []);
    assert.deepEqual(materialized, document);
    assert.equal("/admin/user-list" in fixture.contract.paths, true);
    assert.deepEqual(
      resolved.index.operations.map((operation) => operation.operationId).sort(),
      ["mixed_read_get", "user_info_user_user_list_get"],
    );
    assert.doesNotMatch(await readFile(resolved.path, "utf8"), /admin_user|tags"\s*:\s*\[\s*"admin"/i);
  });

  it("filters the local fallback before exposing its path to chat", async () => {
    const fixture = await createFixture();
    const resolved = await resolveOpenApiContract(fixture.config, async () => {
      throw new Error("remote unavailable");
    });

    assert.equal(resolved.source, "local");
    assert.notEqual(resolved.path, fixture.openapiPath);
    assert.equal(
      "/admin/user-list" in (resolved.document as { paths: Record<string, unknown> }).paths,
      false,
    );
  });

  it("rejects direct administrator calls without sending an OA request", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    let oaRequestCount = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === fixture.config.openapiUrl) {
        return Response.json(fixture.contract);
      }
      oaRequestCount += 1;
      return Response.json({ success: true });
    };

    try {
      const byOperationId = await callOaApiTool(
        fixture.config,
        { operationId: "user_list_admin_user_list_get", query: {} },
        "user-session-token",
      );
      const byMethodAndPath = await callOaApiTool(
        fixture.config,
        { method: "GET", path: "/admin/user-list", query: {} },
        "user-session-token",
      );
      const taggedAdmin = await callOaApiTool(
        fixture.config,
        { operationId: "staff_directory_get", query: {} },
        "user-session-token",
      );
      const operationIdAdmin = await callOaApiTool(
        fixture.config,
        { operationId: "role_admin_list_get", query: {} },
        "user-session-token",
      );
      const internalService = await callOaApiTool(
        fixture.config,
        {
          operationId: "project_sync_projects_internal_get",
          query: {},
        },
        "user-session-token",
      );
      const allowed = await callOaApiTool(
        fixture.config,
        { operationId: "user_info_user_user_list_get", query: {} },
        "user-session-token",
      );

      assert.equal(byOperationId.ok, false);
      assert.equal(byOperationId.error?.code, "operation_not_found");
      assert.equal(byMethodAndPath.ok, false);
      assert.equal(byMethodAndPath.error?.code, "operation_not_found");
      assert.equal(taggedAdmin.ok, false);
      assert.equal(taggedAdmin.error?.code, "operation_not_found");
      assert.equal(operationIdAdmin.ok, false);
      assert.equal(operationIdAdmin.error?.code, "operation_not_found");
      assert.equal(internalService.ok, false);
      assert.equal(internalService.error?.code, "operation_not_found");
      assert.equal(allowed.ok, true);
      assert.equal(oaRequestCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function createFixture(): Promise<{
  config: AppConfig;
  contract: ReturnType<typeof createContract>;
  openapiPath: string;
}> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "oa-chat-openapi-test-"));
  temporaryDirectories.push(projectRoot);
  const openapiPath = path.join(projectRoot, "openapi", "openapi.json");
  const contract = createContract();
  await mkdir(path.dirname(openapiPath), { recursive: true });
  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  return {
    contract,
    openapiPath,
    config: {
      projectRoot,
      openapiPath,
      openapiUrl: "https://oa.example.test/openapi.json",
      oaApiBaseUrl: "https://oa.example.test",
      oaAuthAlias: "default",
      oaApiTokenHeader: "Cookie",
      oaApiTokenPrefix: "sessionid=",
      oaApiToolToken: "internal-tool-token",
    } as AppConfig,
  };
}

function createContract() {
  return {
    openapi: "3.1.0",
    info: { title: "OA", version: "1.0.0" },
    paths: {
      "/user/user-list": {
        get: {
          operationId: "user_info_user_user_list_get",
          tags: ["user"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/admin/user-list": {
        get: {
          operationId: "user_list_admin_user_list_get",
          tags: ["admin"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/staff-directory": {
        get: {
          operationId: "staff_directory_get",
          tags: ["admin"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/security/roles": {
        get: {
          operationId: "role_admin_list_get",
          tags: ["security"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/weekly-report/admin-report-list": {
        get: {
          operationId: "weekly_admin_report_list_get",
          tags: ["weekly-report"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/internal/project-sync/projects": {
        get: {
          operationId: "project_sync_projects_internal_get",
          tags: ["project-sync-internal"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/project-sync/projects": {
        get: {
          operationId: "project_sync_projects_get",
          tags: ["project-sync-internal"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/mixed": {
        parameters: [],
        get: {
          operationId: "mixed_read_get",
          tags: ["user"],
          responses: { "200": { description: "ok" } },
        },
        delete: {
          operationId: "mixed_admin_delete",
          tags: ["admin"],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}
