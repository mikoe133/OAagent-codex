import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config/config.js";
import { callOaApiTool } from "../src/infrastructure/oa/oaApiTool.js";

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
      "/status": {
        get: {
          operationId: "status_get",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}
