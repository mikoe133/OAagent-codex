import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildRuntimeContext } from "../src/application/runCodexAgent.js";
import type { AppConfig } from "../src/config/config.js";
import {
  OPENAPI_CONTRACT_CACHE_TTL_MS,
  resolveOpenApiContract,
} from "../src/infrastructure/oa/openApiContract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resolveOpenApiContract", () => {
  it("caches a resolved contract for the configured thirty-minute window", async () => {
    const fixture = await createFixture();
    let now = 1_000;
    let remoteFetches = 0;
    const fetchImpl = async () => {
      remoteFetches += 1;
      return Response.json(createContract(`cached_operation_${remoteFetches}`));
    };

    const first = await resolveOpenApiContract(fixture.config, fetchImpl, now);
    now += OPENAPI_CONTRACT_CACHE_TTL_MS - 1;
    const second = await resolveOpenApiContract(fixture.config, fetchImpl, now);
    now += 1;
    const refreshed = await resolveOpenApiContract(fixture.config, fetchImpl, now);

    assert.equal(OPENAPI_CONTRACT_CACHE_TTL_MS, 30 * 60 * 1000);
    assert.equal(second.document, first.document);
    assert.equal(second.index.documentHash, first.index.documentHash);
    assert.equal(remoteFetches, 2);
    assert.notEqual(refreshed.document, first.document);
    assert.equal(
      refreshed.index.operations[0]?.operationId,
      "cached_operation_2",
    );
  });

  it("uses and materializes the remote contract when it is available", async () => {
    const fixture = await createFixture();
    const remoteContract = createContract("remote_operation");

    const resolved = await resolveOpenApiContract(
      fixture.config,
      async () => Response.json(remoteContract),
    );

    assert.equal(resolved.source, "remote");
    assert.deepEqual(resolved.document, remoteContract);
    assert.notEqual(resolved.path, fixture.fallbackPath);
    assert.deepEqual(
      JSON.parse(await readFile(resolved.path, "utf8")),
      remoteContract,
    );
    assert.equal(resolved.index.operations[0]?.operationId, "remote_operation");
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(fixture.config.projectRoot, ".context", "openapi-index.json"),
          "utf8",
        ),
      ).documentHash,
      resolved.index.documentHash,
    );
  });

  it("uses the local contract when the remote request fails", async () => {
    const fixture = await createFixture();

    const resolved = await resolveOpenApiContract(fixture.config, async () => {
      throw new Error("network unavailable");
    });

    assert.equal(resolved.source, "local");
    assert.notEqual(resolved.path, fixture.fallbackPath);
    assert.deepEqual(resolved.document, fixture.localContract);
    assert.deepEqual(
      JSON.parse(await readFile(resolved.path, "utf8")),
      resolved.document,
    );
  });

  it("uses the local contract when the remote response is not successful", async () => {
    const fixture = await createFixture();

    const resolved = await resolveOpenApiContract(
      fixture.config,
      async () => new Response("unavailable", { status: 503 }),
    );

    assert.equal(resolved.source, "local");
    assert.match(resolved.fallbackReason ?? "", /HTTP 503/);
  });

  it("uses the local contract when the remote response is not valid OpenAPI JSON", async () => {
    const fixture = await createFixture();

    const resolved = await resolveOpenApiContract(
      fixture.config,
      async () => new Response("{\"message\":\"not an OpenAPI document\"}"),
    );

    assert.equal(resolved.source, "local");
    assert.deepEqual(resolved.document, fixture.localContract);
  });

  it("fails when neither the remote nor local contract is valid", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.fallbackPath, "not json", "utf8");

    await assert.rejects(
      resolveOpenApiContract(fixture.config, async () => {
        throw new Error("network unavailable");
      }),
      /本地 OpenAPI 文件 .* 不是合法 JSON/,
    );
  });
});

describe("buildRuntimeContext", () => {
  it("provides compact candidates and permits at most one exact schema read", () => {
    const config = {
      projectRoot: "/tmp/agent",
      openapiPath: "/tmp/agent/.context/openapi/remote.json",
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      oaApiBaseUrl: null,
    } as AppConfig;

    const runtimeContext = buildRuntimeContext(config, {
      openApiCandidates: [
        {
          operationId: "user_info_user_user_list_get",
          method: "GET",
          path: "/user/user-list",
          summary: "User Info",
          tags: ["user"],
          permissionLevel: "user",
          parameters: [
            { name: "is_active", in: "query", required: false, type: "boolean" },
          ],
          requestBodyFields: [],
          mainResponseFields: ["data[].full_name"],
        },
      ],
    });

    assert.match(runtimeContext, /候选接口索引/);
    assert.match(runtimeContext, /user_info_user_user_list_get/);
    assert.match(runtimeContext, /读取完整 schema/);
    assert.match(runtimeContext, /候选接口.*未包含.*用户意图/);
    assert.match(runtimeContext, /候选以外的完整 OpenAPI/);
    assert.match(runtimeContext, /不得因候选接口未命中就直接断言接口不存在/);
    assert.match(runtimeContext, /mode=inspect/);
    assert.match(runtimeContext, /responseId/);
    assert.match(runtimeContext, /find、filter、count、group_count 或 read/);
    assert.match(runtimeContext, /coverage=complete/);
    assert.match(runtimeContext, /partial 或 unknown.*不得断言不存在/);
    assert.match(runtimeContext, /full_name.*username.*wx_name.*qq_name.*email.*alias/);
    assert.match(runtimeContext, /身份字段.*精确命中.*有效身份命中/);
    assert.match(runtimeContext, /当前问题所需信息.*立即结束工具调用/);
    assert.match(runtimeContext, /不得扩展到.*薪资.*聊天.*文件/);
    assert.doesNotMatch(runtimeContext, /先用 .*确认 operationId/);
    assert.doesNotMatch(runtimeContext, /grep|sed/);
  });

  it("describes dynamic single-step upgrades without restricting complex turns", () => {
    const config = {
      projectRoot: "/tmp/agent",
      openapiPath: "/tmp/agent/.context/openapi/remote.json",
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      oaApiBaseUrl: null,
    } as AppConfig;

    const singleStep = buildRuntimeContext(config, {
      oaQueryPolicy: { mode: "single_step", exactPersonName: "薛屹阳" },
    });
    const multiStep = buildRuntimeContext(config, {
      oaQueryPolicy: { mode: "multi_step", exactPersonName: null },
    });
    const unknown = buildRuntimeContext(config, {
      oaQueryPolicy: { mode: "unknown", exactPersonName: null },
    });

    assert.match(singleStep, /目标数据完整时最多调用一次 OA API/);
    assert.match(singleStep, /最多读取一次选定 operation 的精确 schema/);
    assert.match(singleStep, /自动把本 turn 升级为多步/);
    assert.match(multiStep, /保留自主多步能力/);
    assert.match(multiStep, /每个 operation 最多读取一次/);
    assert.match(unknown, /不设置单次调用硬限制/);
  });

  it("reinjects batch recovery guidance when resuming an existing conversation", () => {
    const config = {
      projectRoot: "/tmp/agent",
      openapiPath: "/tmp/agent/.context/openapi/remote.json",
      modelProvider: "nexttoken",
      model: "gpt-5.6-terra",
      oaApiBaseUrl: "https://oa.example.test",
      oaAuthAlias: "default",
    } as AppConfig;

    const runtimeContext = buildRuntimeContext(config, {
      oaQueryPolicy: { mode: "multi_step", exactPersonName: null },
      hasSessionOaApiToken: true,
    });

    assert.match(runtimeContext, /批量写操作.*单条失败.*继续处理其余/);
    assert.match(runtimeContext, /历史或归档.*不是.*不可更新/);
    assert.match(runtimeContext, /GitHub.*github_urls.*项目更新接口/);
  });
});

async function createFixture(): Promise<{
  config: AppConfig;
  fallbackPath: string;
  localContract: ReturnType<typeof createContract>;
}> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "oa-openapi-test-"));
  temporaryDirectories.push(projectRoot);
  const fallbackPath = path.join(projectRoot, "openapi", "openapi.json");
  const localContract = createContract("local_operation");
  await mkdir(path.dirname(fallbackPath), { recursive: true });
  await writeFile(fallbackPath, JSON.stringify(localContract), "utf8");

  return {
    fallbackPath,
    localContract,
    config: {
      projectRoot,
      openapiPath: fallbackPath,
      openapiUrl: "https://example.test/openapi_json",
    } as AppConfig,
  };
}

function createContract(operationId: string) {
  return {
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/test": {
        get: {
          operationId,
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}
