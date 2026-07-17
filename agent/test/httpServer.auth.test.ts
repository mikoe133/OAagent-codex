import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentService } from "../src/application/agentService.js";
import { createAgentHttpServer } from "../src/api/httpServer.js";
import type { AppConfig } from "../src/config/config.js";
import { SessionStore } from "../src/infrastructure/persistence/sessionStore.js";

test("protects public agent routes with a validated OA token", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-http-auth-"));
  const originalFetch = globalThis.fetch;
  const config = {
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaUserTokenHeader: "Authorization",
    oaUserTokenPrefix: "Bearer",
    oaApiToolToken: "internal-tool-token",
    modelProvider: "nexttoken",
  } as AppConfig;
  const agentService = {} as AgentService;
  const sessionStore = new SessionStore(path.join(directory, "sessions.json"));
  const server = createAgentHttpServer(config, agentService, sessionStore);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const missing = await requestJson(address.port, "/v1/models");
    assert.equal(missing.status, 401);

    globalThis.fetch = async () =>
      Response.json({ code: 401, success: false }, { status: 401 });
    const invalid = await requestJson(address.port, "/v1/models", "invalid-token");
    assert.equal(invalid.status, 401);

    globalThis.fetch = async () =>
      Response.json({
        code: 200,
        success: true,
        data: { email: "user@example.test" },
      });
    const valid = await requestJson(address.port, "/v1/models", "valid-token");
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, {
      provider: "nexttoken",
      models: [
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ],
      providers: {
        nexttoken: [
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.5",
          "gpt-5.6-luna",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
        ],
        openrouter: [
          "z-ai/glm-5.2",
          "moonshotai/kimi-k3",
          "openai/gpt-5.5",
          "openai/gpt-5.4",
        ],
      },
    });

    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    const unavailable = await requestJson(address.port, "/v1/models", "valid-token");
    assert.equal(unavailable.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

function requestJson(
  port: number,
  pathname: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
