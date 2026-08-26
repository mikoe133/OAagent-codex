import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AgentService,
  SendMessageInput,
} from "../src/application/agentService.js";
import { createAgentHttpServer } from "../src/api/httpServer.js";
import type { AppConfig } from "../src/config/config.js";
import {
  beginKnowledgeBaseSourceTurn,
  finishKnowledgeBaseSourceTurn,
} from "../src/infrastructure/knowledgebase/knowledgeBaseSources.js";
import {
  ChatLatencyMetricsRecorder,
  type ChatLatencyRecord,
} from "../src/infrastructure/observability/chatLatency.js";
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
          "z-ai/glm-5.3",
          "moonshotai/kimi-k3",
          "deepseek/deepseek-v4-pro",
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

test("protects the OA automation model catalog with a dedicated token", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-automation-auth-"));
  const config = {
    automationApiToken: "automation-secret",
    modelProvider: "nexttoken",
    model: "gpt-5.6-terra",
    modelProviders: {
      nexttoken: { name: "Nexttoken" },
      openrouter: { name: "OpenRouter" },
    },
  } as AppConfig;
  const server = createAgentHttpServer(
    config,
    {} as AgentService,
    new SessionStore(path.join(directory, "sessions.json")),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const missing = await requestAutomationJson(
      address.port,
      "GET",
      "/internal/v1/models",
    );
    assert.equal(missing.status, 401);

    const catalog = await requestAutomationJson(
      address.port,
      "GET",
      "/internal/v1/models",
      "automation-secret",
    );
    assert.equal(catalog.status, 200);
    assert.doesNotMatch(JSON.stringify(catalog.body), /apiKey|secret/);
    assert.equal(
      typeof (catalog.body as { data?: { catalog_version?: unknown } }).data
        ?.catalog_version,
      "string",
    );
    assert.ok(
      Array.isArray(
        (catalog.body as { data?: { providers?: unknown } }).data?.providers,
      ),
    );

    const valid = await requestAutomationJson(
      address.port,
      "POST",
      "/internal/v1/models/validate",
      "automation-secret",
      {
        provider: "openrouter",
        model_id: "moonshotai/kimi-k3",
      },
    );
    assert.equal(valid.status, 200);
    assert.equal(
      (valid.body as { data?: { valid?: unknown } }).data?.valid,
      true,
    );
    assert.equal(
      typeof (valid.body as { data?: { catalog_version?: unknown } }).data
        ?.catalog_version,
      "string",
    );

    const invalid = await requestAutomationJson(
      address.port,
      "POST",
      "/internal/v1/models/validate",
      "automation-secret",
      {
        provider: "openrouter",
        model_id: "gpt-5.6-terra",
      },
    );
    assert.equal(invalid.status, 200);
    assert.equal(
      (invalid.body as { data?: { valid?: unknown } }).data?.valid,
      false,
    );

    const wrongContentType = await requestAutomationJson(
      address.port,
      "POST",
      "/internal/v1/models/validate",
      "automation-secret",
    );
    assert.equal(wrongContentType.status, 415);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the validated page login userid for knowledge-base headers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-kb-user-"));
  const originalFetch = globalThis.fetch;
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const config = {
    projectRoot,
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaUserTokenHeader: "Authorization",
    oaUserTokenPrefix: "Bearer",
    oaApiToolToken: "internal-tool-token",
    knowledgeBaseApiBaseUrl: "https://oa-kb.example.test/api/agent/v1",
    knowledgeBaseApiToken: "knowledge-service-token",
    knowledgeBaseOpenapiPath: path.join(
      projectRoot,
      "knowledgebaseapi",
      "knowledgebaseapi.yaml",
    ),
  } as AppConfig;
  const sessionStore = new SessionStore(path.join(directory, "sessions.json"));
  const server = createAgentHttpServer(config, {} as AgentService, sessionStore);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let knowledgeRequestHeaders: Headers | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://oa.example.test") {
      return Response.json({
        code: 200,
        success: true,
        data: { id: 73, email: "current-user@example.test" },
      });
    }
    knowledgeRequestHeaders = new Headers(init?.headers);
    return Response.json({ data: [], nextCursor: null, requestId: "request-1" });
  };

  try {
    const created = await requestAutomationJson(
      address.port,
      "POST",
      "/v1/sessions",
      "page-login-token",
      { sessionId: "current-page-session" },
    );
    assert.equal(created.status, 201);

    const response = await requestAutomationJson(
      address.port,
      "POST",
      "/__internal/call-knowledge-base-api",
      "internal-tool-token",
      {
        sessionId: "current-page-session",
        operationId: "searchKnowledgeBase",
        query: { q: "部署" },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(
      knowledgeRequestHeaders?.get("authorization"),
      "Bearer knowledge-service-token",
    );
    assert.equal(knowledgeRequestHeaders?.get("x-oa-user-id"), "73");
    assert.equal(knowledgeRequestHeaders?.get("agent_api_token"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("registers controlled knowledge API sources for the active session turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-kb-source-"));
  const originalFetch = globalThis.fetch;
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const config = {
    projectRoot,
    oaApiToolToken: "internal-tool-token",
    knowledgeBaseApiBaseUrl: "https://oa-kb.example.test/api/agent/v1",
    knowledgeBaseApiToken: "knowledge-service-token",
    knowledgeBaseOpenapiPath: path.join(
      projectRoot,
      "knowledgebaseapi",
      "knowledgebaseapi.yaml",
    ),
  } as AppConfig;
  const sessionStore = new SessionStore(path.join(directory, "sessions.json"));
  await sessionStore.bindOaToken(
    "kb-source-session",
    "oa-session-token",
    undefined,
    "19",
  );
  const server = createAgentHttpServer(config, {} as AgentService, sessionStore);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  beginKnowledgeBaseSourceTurn("kb-source-session");
  let knowledgeRequestHeaders: Headers | null = null;
  globalThis.fetch = async (_input, init) => {
    knowledgeRequestHeaders = new Headers(init?.headers);
    return Response.json({
      data: [
        {
          title: "生产部署手册",
          excerpt: "发布前请确认数据库迁移。",
          sourceUrl: "https://oa-kb.example.test/wiki/page-1",
        },
      ],
      nextCursor: null,
      requestId: "request-1",
    });
  };

  try {
    const response = await requestAutomationJson(
      address.port,
      "POST",
      "/__internal/call-knowledge-base-api",
      "internal-tool-token",
      {
        sessionId: "kb-source-session",
        operationId: "searchKnowledgeBase",
        query: { q: "部署" },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(
      knowledgeRequestHeaders?.get("authorization"),
      "Bearer knowledge-service-token",
    );
    assert.equal(knowledgeRequestHeaders?.get("x-oa-user-id"), "19");
    assert.equal(knowledgeRequestHeaders?.get("agent_api_token"), null);
    assert.deepEqual(finishKnowledgeBaseSourceTurn("kb-source-session"), [
      {
        title: "生产部署手册",
        description: "发布前请确认数据库迁移。",
        originalContent: "发布前请确认数据库迁移。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ]);
  } finally {
    finishKnowledgeBaseSourceTurn("kb-source-session");
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("records authenticated streaming chat latency without logging request secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-chat-latency-"));
  const originalFetch = globalThis.fetch;
  let now = 0;
  const records: ChatLatencyRecord[] = [];
  const latencyMetrics = new ChatLatencyMetricsRecorder({
    now: () => now,
    wallNow: () => new Date(0),
    logger: (record) => records.push(record),
  });
  const config = {
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaUserTokenHeader: "Authorization",
    oaUserTokenPrefix: "Bearer",
    modelProvider: "nexttoken",
    model: "gpt-5.6-terra",
  } as AppConfig;
  const agentService = {
    async streamMessage(
      input: { latency?: { mark: (name: string) => void } },
      emit: (event: unknown) => Promise<void>,
    ) {
      assert.ok(input.latency);
      input.latency.mark("codex_invoked");
      await emit({ type: "run.started", sessionId: "latency-session" });
      await emit({
        type: "run.completed",
        sessionId: "latency-session",
        result: {
          sessionId: "latency-session",
          threadId: "thread-1",
          provider: "nexttoken",
          model: "gpt-5.6-terra",
          finalResponse: "ok",
          executedCommands: [],
          knowledgeSources: [],
          summary: null,
        },
        usage: null,
      });
    },
  } as unknown as AgentService;
  const server = createAgentHttpServer(
    config,
    agentService,
    new SessionStore(path.join(directory, "sessions.json")),
    undefined,
    latencyMetrics,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  globalThis.fetch = async () => {
    now = 7;
    return Response.json({
      code: 200,
      success: true,
      data: { id: 19, email: "latency@example.test" },
    });
  };

  try {
    const response = await requestStream(
      address.port,
      "/v1/sessions/latency-session/messages/stream",
      "secret-page-token",
      { message: "hello", provider: "nexttoken", model: "gpt-5.6-terra" },
    );

    assert.equal(response.status, 200);
    assert.match(response.body, /event: run\.completed/);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
    assert.equal(records[0]?.provider, "nexttoken");
    assert.equal(records[0]?.model, "gpt-5.6-terra");
    assert.equal(records[0]?.durationsMs.auth, 7);
    assert.equal(records[0]?.milestonesMs.stream_connected, 7);
    assert.doesNotMatch(JSON.stringify(records[0]), /secret-page-token|hello/);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("forwards only approved router models regardless of developer mode", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-router-model-"));
  const originalFetch = globalThis.fetch;
  const inputs: SendMessageInput[] = [];
  const config = {
    oaApiBaseUrl: "https://oa.example.test",
    oaAuthAlias: "default",
    oaUserTokenHeader: "Authorization",
    oaUserTokenPrefix: "Bearer",
    modelProvider: "nexttoken",
    model: "gpt-5.6-terra",
  } as AppConfig;
  const agentService = {
    async streamMessage(
      input: SendMessageInput,
      emit: (event: unknown) => Promise<void>,
    ) {
      inputs.push(input);
      await emit({
        type: "run.completed",
        sessionId: input.sessionId,
        result: {
          sessionId: input.sessionId,
          threadId: "thread-1",
          provider: input.provider,
          model: input.model,
          finalResponse: "ok",
          executedCommands: [],
          knowledgeSources: [],
          summary: null,
        },
        usage: null,
      });
    },
  } as unknown as AgentService;
  const server = createAgentHttpServer(
    config,
    agentService,
    new SessionStore(path.join(directory, "sessions.json")),
    undefined,
    new ChatLatencyMetricsRecorder({ logger: () => undefined }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  globalThis.fetch = async () =>
    Response.json({
      code: 200,
      success: true,
      data: { id: 19, email: "developer@example.test" },
    });

  try {
    const accepted = await requestStream(
      address.port,
      "/v1/sessions/developer-session/messages/stream",
      "valid-token",
      {
        message: "hello",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
        developerMode: true,
        routerModel: "qwen/qwen3.5-flash-02-23",
      },
    );

    assert.equal(accepted.status, 200);
    assert.equal(inputs[0]?.provider, "nexttoken");
    assert.equal(inputs[0]?.model, "gpt-5.6-terra");
    assert.equal(inputs[0]?.developerMode, true);
    assert.equal(inputs[0]?.routerModel, "qwen/qwen3.5-flash-02-23");

    const acceptedWithoutDeveloperMode = await requestStream(
      address.port,
      "/v1/sessions/developer-session/messages/stream",
      "valid-token",
      {
        message: "hello",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
        developerMode: false,
        routerModel: "deepseek/deepseek-v4-flash",
      },
    );

    assert.equal(acceptedWithoutDeveloperMode.status, 200);
    assert.equal(inputs[1]?.developerMode, undefined);
    assert.equal(inputs[1]?.routerModel, "deepseek/deepseek-v4-flash");

    const rejected = await requestStream(
      address.port,
      "/v1/sessions/developer-session/messages/stream",
      "valid-token",
      {
        message: "hello",
        developerMode: true,
        routerModel: "z-ai/glm-5.3",
      },
    );

    assert.equal(rejected.status, 400);
    assert.match(rejected.body, /路由模型/);

    const rejectedWithoutDeveloperMode = await requestStream(
      address.port,
      "/v1/sessions/developer-session/messages/stream",
      "valid-token",
      {
        message: "hello",
        developerMode: false,
        routerModel: "z-ai/glm-5.3",
      },
    );

    assert.equal(rejectedWithoutDeveloperMode.status, 400);
    assert.match(rejectedWithoutDeveloperMode.body, /路由模型/);
    assert.equal(inputs.length, 2);
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

function requestAutomationJson(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  token?: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
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
    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

function requestStream(
  port: number,
  pathname: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
