import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config/config.js";
import { callOaApiTool } from "../src/infrastructure/oa/oaApiTool.js";
import {
  beginOaTurn,
  finishOaTurn,
  resolveOaQueryPolicy,
} from "../src/infrastructure/oa/oaQueryPolicy.js";

test("uses the configured OA alias for operations that declare alias", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-alias-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const requestedUrls: string[] = [];
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === config.openapiUrl) {
      return Response.json(contract);
    }
    requestedUrls.push(url);
    return Response.json({ success: true });
  };

  try {
    const omitted = await callOaApiTool(
      config,
      { operationId: "user_info_get", query: {} },
      "user-token",
    );
    const overridden = await callOaApiTool(
      config,
      {
        operationId: "user_info_get",
        query: { alias: "person-name", page: 2 },
      },
      "user-token",
    );
    const unrelated = await callOaApiTool(
      config,
      { operationId: "status_get", query: {} },
      "user-token",
    );

    assert.equal(omitted.ok, true);
    assert.equal(overridden.ok, true);
    assert.equal(unrelated.ok, true);
    assert.equal(new URL(requestedUrls[0]!).searchParams.get("alias"), "default");
    assert.equal(new URL(requestedUrls[1]!).searchParams.get("alias"), "default");
    assert.equal(new URL(requestedUrls[1]!).searchParams.get("page"), "2");
    assert.equal(new URL(requestedUrls[2]!).searchParams.has("alias"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("filters an exact person before truncation and preserves follow-up for unknown coverage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-person-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "person-lookup-session";
  let oaRequestCount = 0;
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;
  const users = Array.from({ length: 45 }, (_, index) => ({
    id: index + 1,
    full_name: index === 40 ? "薛屹阳" : `测试用户${index + 1}`,
    email: `user${index + 1}@example.test`,
  }));

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({ success: true, data: users });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("薛屹阳的个人信息"));

  try {
    const first = await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_get", query: {} },
      "user-token",
    );
    const second = await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_get", query: { page: 2 } },
      "user-token",
    );

    assert.equal(first.ok, true);
    assert.deepEqual(first.data, {
      success: true,
      data: [users[40]],
    });
    assert.equal(first.warnings, undefined);
    assert.equal(first.coverage?.status, "unknown");
    assert.equal(second.ok, true);
    assert.equal(oaRequestCount, 2);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("focuses an exact Latin username and stops unrelated OA calls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-latin-person-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "latin-person-lookup-session";
  let oaRequestCount = 0;
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;
  const users = Array.from({ length: 30 }, (_, index) => ({
    user_id: index + 1,
    username: index === 24 ? "Ryan" : `User ${index + 1}`,
    full_name: index === 24 ? "罗鑫" : `测试用户${index + 1}`,
    wx_name: index === 24 ? "Ryan" : "",
    email: index === 24 ? "luoxin@example.test" : `user${index + 1}@example.test`,
    department: index % 2 === 0 ? "产品部" : "研发部",
    employee_title: index === 24 ? "全栈" : "工程师",
    intro: "x".repeat(1000),
  }));

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({ code: 200, message: "ok", data: users });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("Ryan 是谁"));

  try {
    const found = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "user_info_user_user_list_get",
        query: { is_active: true },
      },
      "user-token",
    );
    const blocked = await callOaApiTool(
      config,
      { sessionId, operationId: "status_get" },
      "user-token",
    );

    assert.equal(found.ok, true);
    assert.equal(found.responseId, undefined);
    assert.deepEqual(found.identityMatch, {
      query: "Ryan",
      status: "matched",
      scannedCandidates: 30,
      matched: 1,
      matchedBy: [{ itemIndex: 0, fields: ["username", "wx_name"] }],
    });
    assert.deepEqual(found.data, {
      code: 200,
      message: "ok",
      data: [users[24]],
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "oa_call_budget_exceeded");
    assert.equal(oaRequestCount, 1);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspects thirty rich records instead of inlining the full collection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-thirty-rich-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "thirty-rich-records-session";
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;
  const users = Array.from({ length: 30 }, (_, index) => ({
    user_id: index + 1,
    username: `User ${index + 1}`,
    full_name: `测试用户${index + 1}`,
    intro: "x".repeat(1000),
  }));

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    return Response.json({ code: 200, message: "ok", data: users });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查询在职用户列表"));

  try {
    const inspection = await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_user_user_list_get" },
      "user-token",
    );

    assert.equal(inspection.ok, true);
    assert.equal(typeof inspection.responseId, "string");
    assert.equal((inspection.data as { mode?: unknown }).mode, "inspect");
    assert.doesNotMatch(JSON.stringify(inspection), /"intro":"x{500}/);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspects a large response before running complete local analysis", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-user-list-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "progressive-user-list-session";
  let oaRequestCount = 0;
  const users = Array.from({ length: 45 }, (_, index) => ({
    id: index + 1,
    full_name: index === 40 ? "罗奇龙" : `测试用户${index + 1}`,
    wx_name: index === 40 ? "罗奇奇" : "",
    email: `user${index + 1}@example.test`,
    department: index % 2 === 0 ? "研发部" : "产品部",
  }));
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({ success: true, data: users });
  };
  beginOaTurn(sessionId, { mode: "single_step", exactPersonName: null });

  try {
    const inspection = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "user_info_user_user_list_get",
        query: {},
      },
      "user-token",
    );
    const responseId = inspection.responseId;

    assert.equal(inspection.ok, true);
    assert.equal(typeof responseId, "string");
    assert.equal(inspection.coverage?.status, "complete");
    assert.equal((inspection.data as { mode?: unknown }).mode, "inspect");
    assert.doesNotMatch(JSON.stringify(inspection), /罗奇龙/);
    assert.match(JSON.stringify(inspection), /"path":"\$\.data"/);
    assert.match(JSON.stringify(inspection), /"length":45/);
    assert.match(JSON.stringify(inspection), /"full_name"/);

    const found = await callOaApiTool(
      config,
      {
        sessionId,
        responseId,
        action: "find",
        responsePath: "$.data",
        conditions: { full_name: "罗奇龙" },
        fields: ["id", "full_name", "department"],
      },
      "user-token",
    );
    assert.equal(found.ok, true);
    assert.equal(found.coverage?.status, "complete");
    assert.deepEqual(found.data, {
      action: "find",
      path: "$.data",
      scanned: 45,
      matched: 1,
      returned: 1,
      items: [{ id: 41, full_name: "罗奇龙", department: "研发部" }],
      matchedBy: [{ itemIndex: 0, fields: ["full_name"] }],
    });

    const foundByAlias = await callOaApiTool(
      config,
      {
        sessionId,
        responseId,
        action: "find",
        responsePath: "$.data",
        conditions: {
          $or: [
            { full_name: "罗奇奇" },
            { username: "罗奇奇" },
            { wx_name: "罗奇奇" },
          ],
        },
        fields: ["id", "full_name", "wx_name"],
      },
      "user-token",
    );
    assert.equal(foundByAlias.ok, true);
    assert.equal(foundByAlias.coverage?.status, "complete");
    assert.deepEqual(foundByAlias.data, {
      action: "find",
      path: "$.data",
      scanned: 45,
      matched: 1,
      returned: 1,
      items: [{ id: 41, full_name: "罗奇龙", wx_name: "罗奇奇" }],
      matchedBy: [{ itemIndex: 0, fields: ["wx_name"] }],
    });

    const grouped = await callOaApiTool(
      config,
      {
        sessionId,
        responseId,
        action: "group_count",
        responsePath: "$.data",
        groupBy: "department",
      },
      "user-token",
    );
    assert.equal(grouped.ok, true);
    assert.deepEqual(grouped.data, {
      action: "group_count",
      path: "$.data",
      scanned: 45,
      groups: [
        { value: "研发部", count: 23 },
        { value: "产品部", count: 22 },
      ],
    });

    const chunk = await callOaApiTool(
      config,
      {
        sessionId,
        responseId,
        action: "read",
        responsePath: "$.data",
        offset: 30,
        limit: 15,
        fields: ["id", "full_name"],
      },
      "user-token",
    );

    assert.equal(chunk.ok, true);
    assert.equal(chunk.coverage?.status, "complete");
    assert.equal((chunk.data as { returned?: unknown }).returned, 15);
    assert.equal((chunk.data as { nextOffset?: unknown }).nextOffset, null);
    assert.match(JSON.stringify(chunk), /罗奇龙/);

    const boundedRoot = await callOaApiTool(
      config,
      {
        sessionId,
        responseId,
        action: "read",
        responsePath: "$",
      },
      "user-token",
    );
    assert.equal(boundedRoot.ok, true);
    assert.equal(boundedRoot.coverage?.status, "complete");
    assert.match(boundedRoot.warnings?.join("\n") ?? "", /分析结果.*缩小/);
    assert.doesNotMatch(JSON.stringify(boundedRoot.data), /罗奇龙/);
    const blocked = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "status_get",
      },
      "user-token",
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "oa_call_budget_exceeded");
    assert.equal(oaRequestCount, 1);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores complex categorized responses progressively and searches nested Chinese paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-nested-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "nested-progressive-session";
  let oaRequestCount = 0;
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;
  const categorizedUsers = createCategorizedUsers();

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({ success: true, code: 200, message: "ok", data: categorizedUsers });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查找罗奇龙的技能"));

  try {
    const inspection = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "user_info_user_user_list_get",
        query: {},
      },
      "user-token",
    );

    assert.equal(inspection.ok, true);
    assert.equal(typeof inspection.responseId, "string");
    assert.equal(inspection.coverage?.status, "complete");
    assert.equal((inspection.data as { mode?: unknown }).mode, "inspect");
    assert.equal(oaRequestCount, 1);

    const found = await callOaApiTool(
      config,
      {
        sessionId,
        responseId: inspection.responseId,
        action: "find",
        responsePath: "$.data.综合",
        conditions: { "skills.skill_name": "技术文档" },
        fields: ["user_id", "full_name", "skills.skill_name"],
      },
      "user-token",
    );

    assert.equal(found.ok, true);
    assert.equal(found.coverage?.status, "complete");
    assert.deepEqual(found.data, {
      action: "find",
      path: "$.data.综合",
      scanned: 8,
      matched: 1,
      returned: 1,
      items: [
        {
          user_id: 16,
          full_name: "罗奇龙",
          "skills.skill_name": ["装机", "技术文档"],
        },
      ],
      matchedBy: [{ itemIndex: 0, fields: ["skills.skill_name"] }],
    });
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps local analysis partial when the source response has more pages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-partial-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "progressive-partial-session";
  const users = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    full_name: `测试用户${index + 1}`,
  }));
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    return Response.json({ success: true, total: 60, has_next: true, data: users });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查询用户列表中是否有罗奇龙"));

  try {
    const inspection = await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_get", query: { page: 1 } },
      "user-token",
    );
    const found = await callOaApiTool(
      config,
      {
        sessionId,
        responseId: inspection.responseId,
        action: "find",
        responsePath: "$.data",
        conditions: { full_name: "罗奇龙" },
      },
      "user-token",
    );

    assert.equal(inspection.coverage?.status, "partial");
    assert.equal(inspection.coverage?.knownTotal, 60);
    assert.equal(found.coverage?.status, "partial");
    assert.equal((found.data as { matched?: unknown }).matched, 0);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("expires progressive response handles when the turn finishes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-expired-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "progressive-expired-session";
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    return Response.json({
      success: true,
      data: Array.from({ length: 31 }, (_, index) => ({ id: index + 1 })),
    });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查询用户列表"));

  try {
    const inspection = await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_get", query: { page: 1 } },
      "user-token",
    );
    finishOaTurn(sessionId);
    beginOaTurn(sessionId, resolveOaQueryPolicy("继续读取"));
    const expired = await callOaApiTool(
      config,
      {
        sessionId,
        responseId: inspection.responseId,
        action: "read",
        responsePath: "$.data",
      },
      "user-token",
    );

    assert.equal(expired.ok, false);
    assert.equal(expired.error?.code, "response_not_found");
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates concurrent equivalent OA requests within one turn only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-dedup-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "dedup-session";
  let oaRequestCount = 0;
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({ success: true, data: [{ id: 1, full_name: "王强" }] });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查询用户列表"));

  try {
    const [first, second] = await Promise.all([
      callOaApiTool(
        config,
        {
          sessionId,
          operationId: "user_info_get",
          query: { page: 2, alias: "first-alias" },
        },
        "user-token",
      ),
      callOaApiTool(
        config,
        {
          sessionId,
          operationId: "user_info_get",
          query: { alias: "second-alias", page: "2" },
        },
        "user-token",
      ),
    ]);

    assert.deepEqual(second, first);
    assert.equal(oaRequestCount, 1);

    finishOaTurn(sessionId);
    beginOaTurn(sessionId, resolveOaQueryPolicy("查询用户列表"));
    await callOaApiTool(
      config,
      { sessionId, operationId: "user_info_get", query: { page: 2 } },
      "user-token",
    );
    assert.equal(oaRequestCount, 2);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses equivalent OA requests after the first call completes within one turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-api-tool-reuse-"));
  const originalFetch = globalThis.fetch;
  const contract = createContract();
  const openapiPath = path.join(directory, "openapi.json");
  const sessionId = "reuse-session";
  let oaRequestCount = 0;
  const config = {
    projectRoot: directory,
    openapiPath,
    openapiUrl: "https://oa.example.test/openapi.json",
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaApiTokenHeader: "Cookie",
    oaApiTokenPrefix: "sessionid=",
    oaApiToolToken: "internal-tool-token",
  } as AppConfig;

  await writeFile(openapiPath, JSON.stringify(contract), "utf8");
  globalThis.fetch = async (input) => {
    if (String(input) === config.openapiUrl) {
      return Response.json(contract);
    }
    oaRequestCount += 1;
    return Response.json({
      success: true,
      data: [{ id: 1, full_name: "罗奇龙" }],
    });
  };
  beginOaTurn(sessionId, resolveOaQueryPolicy("查询用户列表"));

  try {
    const first = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "user_info_get",
        query: { page: 2, alias: "ignored-alias" },
      },
      "user-token",
    );
    const second = await callOaApiTool(
      config,
      {
        sessionId,
        operationId: "user_info_get",
        query: { alias: "another-alias", page: "2" },
      },
      "user-token",
    );

    assert.deepEqual(second, first);
    assert.equal(oaRequestCount, 1);
  } finally {
    finishOaTurn(sessionId);
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

function createContract() {
  return {
    openapi: "3.1.0",
    info: { title: "OA", version: "1.0.0" },
    paths: {
      "/user/user": {
        get: {
          operationId: "user_info_get",
          parameters: [
            {
              name: "alias",
              in: "query",
              required: false,
              schema: { type: "string", default: "default" },
            },
            {
              name: "page",
              in: "query",
              required: false,
              schema: { type: "integer" },
            },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/user/user-list": {
        get: {
          operationId: "user_info_user_user_list_get",
          parameters: [
            {
              name: "alias",
              in: "query",
              required: false,
              schema: { type: "string", default: "default" },
            },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/status": {
        get: {
          operationId: "status_get",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function createCategorizedUsers() {
  const makeUser = (
    userId: number,
    fullName: string,
    skillNames: string[] = [],
  ) => ({
    user_id: userId,
    full_name: fullName,
    username: fullName,
    skills: skillNames.map((skill_name, index) => ({
      skill_id: userId * 10 + index + 1,
      skill_name,
      description: `${skill_name} 说明`,
    })),
  });

  return {
    综合: [
      makeUser(16, "罗奇龙", ["装机", "技术文档"]),
      ...Array.from({ length: 7 }, (_, index) =>
        makeUser(index + 1, `综合用户${index + 1}`),
      ),
    ],
    产品: Array.from({ length: 8 }, (_, index) =>
      makeUser(100 + index, `产品用户${index + 1}`),
    ),
    算法: Array.from({ length: 8 }, (_, index) =>
      makeUser(200 + index, `算法用户${index + 1}`),
    ),
    管理: Array.from({ length: 8 }, (_, index) =>
      makeUser(300 + index, `管理用户${index + 1}`),
    ),
  };
}
