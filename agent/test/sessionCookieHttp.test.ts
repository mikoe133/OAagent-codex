import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentHttpServer } from "../src/api/httpServer.js";
import { AutomationHttpApplication, type AutomationOperations } from "../src/automation/http/automationHttpApplication.js";
import type { AgentService } from "../src/application/agentService.js";
import type { AppConfig } from "../src/config/config.js";
import { SessionStore } from "../src/infrastructure/persistence/sessionStore.js";
import { createSignedOaSession } from "./helpers/oaSessionFixture.js";

test("chat and automation normalize encoded and quoted session cookies consistently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-cookie-http-"));
  const originalFetch = globalThis.fetch;
  const forwarded: string[] = [];
  const authenticatedUsers: number[] = [];
  const application = new AutomationHttpApplication({
    sessionSecret: "dummy", sessionVerifyMaxAgeSeconds: 0, internalToken: "internal-test-token",
  }, {
    async listTags(_query: URLSearchParams, userId: number) {
      authenticatedUsers.push(userId);
      return { items: [], total: 0 };
    },
  } as unknown as AutomationOperations);
  const server = createAgentHttpServer({
    oaApiBaseUrl: "https://oa.example.test", oaAuthAlias: "default",
    oaUserTokenHeader: "Authorization", oaUserTokenPrefix: "Bearer", modelProvider: "nexttoken",
  } as AppConfig, {} as AgentService, new SessionStore(path.join(directory, "sessions.json")), application);
  globalThis.fetch = async (_url, options) => {
    forwarded.push(new Headers(options?.headers).get("cookie") ?? "");
    return Response.json({ code: 200, success: true, data: { email: "audit@example.test", user_id: 42 } });
  };
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const get = (pathname: string, cookie: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path: pathname, headers: { Cookie: cookie } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });

  try {
    for (const compressed of [false, true]) {
      const token = createSignedOaSession({ user_id: 42 }, compressed);
      for (const value of [token, encodeURIComponent(token), `"${encodeURIComponent(token)}"`]) {
        const cookie = `unrelated=1; sessionid=${value}; other=a=b`;
        assert.equal(await get("/v1/models", cookie), 200);
        assert.equal(forwarded.at(-1), `sessionid=${token}`, "OA must receive the original session token");
        assert.equal(await get("/automation-tags", cookie), 200);
        assert.equal(authenticatedUsers.at(-1), 42);
      }
    }

    const beforeInvalid = forwarded.length;
    for (const value of ["", '""', "broken%ZZ", '"unclosed', "bad%0D%0Aheader"]) {
      assert.equal(await get("/v1/models", `sessionid=${value}`), 401);
      assert.equal(await get("/automation-tags", `sessionid=${value}`), 401);
    }
    assert.equal(forwarded.length, beforeInvalid, "invalid cookies must not be sent to OA");

    const token = "literal%3D-token==+";
    assert.equal(await get("/v1/models", `sessionid=${encodeURIComponent(token)}`), 200);
    assert.equal(forwarded.at(-1), `sessionid=${token}`, "decode percent escapes exactly once");
    const doubleEncoded = encodeURIComponent(encodeURIComponent(createSignedOaSession({ user_id: 42 })));
    assert.equal(await get("/automation-tags", `sessionid=${doubleEncoded}`), 401);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
