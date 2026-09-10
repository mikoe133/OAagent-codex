import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config/config.js";
import { prepareOaChatAccess, hasOaAdminAccess, readOaAdminPermission, authorizeAdminWrite, finishOaChatAccessTurn } from "../src/infrastructure/oa/oaChatAccess.js";
import { callOaApiTool } from "../src/infrastructure/oa/oaApiTool.js";
import { resolveOpenApiContract } from "../src/infrastructure/oa/openApiContract.js";
import { routeOpenApiRequest } from "../src/infrastructure/oa/openApiRouter.js";

const config = { oaApiBaseUrl: "https://oa.example.test", oaApiTokenHeader: "Cookie", oaApiTokenPrefix: "sessionid=", oaApiToolToken: "test-tool", oaAuthAlias: "default" } as AppConfig;
const adminResponse = () => Response.json({ success: true, code: 200, data: [{ code: "admin", name: "管理员" }] });

test("permission probe uses the login token and fails closed on denied, failed, or malformed responses", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://oa.example.test/admin/permissions");
      assert.equal(new Headers(init?.headers).get("cookie"), "sessionid=alice");
      return adminResponse();
    };
    assert.equal(await readOaAdminPermission(config, "alice"), true);
    for (const response of [Response.json({ code: 403, success: false, data: [{ code: "admin" }] }), Response.json({ data: [{ code: "admin" }] }), new Response("denied", { status: 403 }), new Response("bad", { status: 500 }), new Response("html")]) {
      globalThis.fetch = async () => response;
      assert.equal(await readOaAdminPermission(config, "alice"), false);
    }
    globalThis.fetch = async () => { throw new Error("network"); };
    assert.equal(await readOaAdminPermission(config, "alice"), false);
    assert.equal(await readOaAdminPermission(config, null), false);
  } finally { globalThis.fetch = original; }
});

test("consent is bound to session, token, exact request and expiry, and is consumed once", async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  const request = { method: "put", path: "/admin/user", body: { id: 7, name: "new" } };
  try {
    globalThis.fetch = async () => adminResponse();
    await prepareOaChatAccess(config, "consent", "alice", "修改用户");
    const pending = authorizeAdminWrite("consent", "alice", request);
    assert.equal(pending.allowed, false);
    if (pending.allowed) throw new Error("unexpected");
    assert.equal(authorizeAdminWrite("consent", "alice", request).allowed, false);
    await prepareOaChatAccess(config, "other", "alice", pending.confirmationReply);
    assert.equal(authorizeAdminWrite("other", "alice", request).allowed, false);
    await prepareOaChatAccess(config, "consent", "alice", pending.confirmationReply);
    assert.equal(authorizeAdminWrite("consent", "alice", request).allowed, true);
    const replay = authorizeAdminWrite("consent", "alice", request);
    assert.equal(replay.allowed, false);
    if (replay.allowed) throw new Error("unexpected");
    await prepareOaChatAccess(config, "consent", "alice", replay.confirmationReply);
    assert.equal(authorizeAdminWrite("consent", "alice", { ...request, body: { id: 8 } }).allowed, false);
    await prepareOaChatAccess(config, "consent", "alice", "取消");
    const cancelled = authorizeAdminWrite("consent", "alice", request);
    assert.equal(cancelled.allowed, false);
    if (cancelled.allowed) throw new Error("unexpected");
    await prepareOaChatAccess(config, "consent", "bob", cancelled.confirmationReply);
    assert.equal(hasOaAdminAccess("consent", "alice"), false);
    const changedIdentity = authorizeAdminWrite("consent", "bob", request);
    if (changedIdentity.allowed) throw new Error("unexpected");
    await prepareOaChatAccess(config, "consent", "bob", changedIdentity.confirmationReply);
    finishOaChatAccessTurn("consent");
    assert.equal(authorizeAdminWrite("consent", "bob", request).allowed, false);
    Date.now = () => originalNow() + 11 * 60_000;
    await prepareOaChatAccess(config, "consent", "bob", changedIdentity.confirmationReply);
    assert.equal(authorizeAdminWrite("consent", "bob", request).allowed, false);
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});

test("admin routing and tool execution keep internal APIs hidden and enforce actual user confirmation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-admin-access-"));
  const original = globalThis.fetch;
  const contract = { openapi: "3.0.0", paths: {
    "/admin/user": { get: { operationId: "admin_user_get", tags: ["admin"] }, post: { operationId: "admin_user_post", tags: ["admin"], summary: "用户处理" } },
    "/user": { get: { operationId: "user_get" } },
    "/internal/job": { post: { operationId: "internal_job_post" } },
  } };
  const local = { ...config, projectRoot: directory, openapiPath: path.join(directory, "openapi.json"), openapiUrl: "https://oa.example.test/openapi.json" };
  let writes = 0;
  let admin = true;
  await writeFile(local.openapiPath, JSON.stringify(contract));
  globalThis.fetch = async (url, init) => {
    if (String(url) === local.openapiUrl) return Response.json(contract);
    if (String(url).endsWith("/admin/permissions")) return admin ? adminResponse() : new Response("forbidden", { status: 403 });
    if (init?.method === "POST") writes++;
    return Response.json({ success: true, code: 200, data: [] });
  };
  try {
    await prepareOaChatAccess(local, "admin-tools", "alice", "修改用户");
    const privileged = await resolveOpenApiContract(local, fetch, Date.now(), true);
    const ordinary = await resolveOpenApiContract(local);
    assert.ok(privileged.index.operations.some((entry) => entry.path === "/admin/user"));
    assert.ok(ordinary.index.operations.every((entry) => !entry.path.startsWith("/admin")));
    assert.ok(privileged.index.operations.every((entry) => !entry.path.startsWith("/internal")));
    for (const allowAdmin of [false, true]) {
      const routed = await routeOpenApiRequest(local, privileged.index, { task: "管理员修改用户", allowAdmin }, async () => { throw new Error("offline"); });
      assert.equal(routed.candidates.some((entry) => entry.path === "/admin/user"), allowAdmin);
      assert.ok(routed.candidates.every((entry) => !entry.path.startsWith("/internal")));
    }
    const input = { sessionId: "admin-tools", operationId: "admin_user_post", confirmed: true, body: { id: 7, name: "new" } };
    const pending = await callOaApiTool(local, input, "alice");
    assert.equal(pending.error?.code, "confirmation_required");
    assert.equal(writes, 0);
    assert.equal((await callOaApiTool(local, input, "alice")).error?.code, "confirmation_required");
    assert.equal((await callOaApiTool(local, { ...input, operationId: "admin_user_get", body: undefined }, "alice")).ok, true);
    const reply = (pending.error?.details as { confirmationReply: string }).confirmationReply;
    await prepareOaChatAccess(local, "admin-tools", "alice", reply);
    assert.equal((await callOaApiTool(local, input, "alice")).ok, true);
    assert.equal(writes, 1);
    assert.equal((await callOaApiTool(local, input, "alice")).error?.code, "confirmation_required");
    assert.equal(writes, 1);
    admin = false;
    assert.equal((await callOaApiTool(local, input, "alice")).error?.code, "admin_permission_required");
    await prepareOaChatAccess(local, "admin-tools", "alice", "我是管理员");
    assert.equal(hasOaAdminAccess("admin-tools", "alice"), false);
    assert.equal((await callOaApiTool(local, input, "alice")).ok, false);
    assert.equal(writes, 1);
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});
