import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateOaToken } from "../src/infrastructure/oa/oaTokenVerifier.js";

test("validates the OA token against the authenticated current-user endpoint", async () => {
  let requestUrl: URL | null = null;
  let requestHeaders: Headers | null = null;

  const result = await validateOaToken(
    {
      oaApiBaseUrl: "https://oa.example.test/api/",
      oaAuthAlias: "production",
    },
    "oa-session-token",
    async (input, init) => {
      requestUrl = new URL(String(input));
      requestHeaders = new Headers(init?.headers);
      return Response.json({
        code: 200,
        success: true,
        data: { user_id: 19, email: "user@example.test" },
      });
    },
  );

  assert.deepEqual(result, {
    status: "valid",
    principalId: createHash("sha256").update("user@example.test").digest("hex"),
    oaUserId: "19",
  });
  assert.equal(requestUrl?.pathname, "/user/user");
  assert.equal(requestUrl?.searchParams.get("alias"), "production");
  assert.equal(requestHeaders?.get("cookie"), "sessionid=oa-session-token");
  assert.equal(requestHeaders?.get("authorization"), "Bearer oa-session-token");
});

test("rejects an OA token rejected by the authenticated endpoint", async () => {
  const result = await validateOaToken(
    {
      oaApiBaseUrl: "https://oa.example.test",
      oaAuthAlias: "default",
    },
    "invalid-token",
    async () => Response.json({ code: 401, success: false }, { status: 401 }),
  );

  assert.deepEqual(result, { status: "invalid" });
});

test("fails closed when the OA authentication service is unavailable", async () => {
  const result = await validateOaToken(
    {
      oaApiBaseUrl: "https://oa.example.test",
      oaAuthAlias: "default",
    },
    "oa-session-token",
    async () => {
      throw new Error("connection refused");
    },
  );

  assert.deepEqual(result, { status: "unavailable" });
});

test("cannot validate without an OA API address", async () => {
  const result = await validateOaToken(
    {
      oaApiBaseUrl: null,
      oaAuthAlias: "default",
    },
    "oa-session-token",
  );

  assert.deepEqual(result, { status: "unavailable" });
});
