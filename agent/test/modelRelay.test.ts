import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";

import type { AppConfig, ModelProviderConfig } from "../src/config/config.js";
import type { ProjectProgressConfig } from "../src/config/projectProgressConfig.js";
import { resolveCodexModelBaseUrl } from "../src/infrastructure/codex/codexClient.js";
import {
  startModelRelay,
  startProjectProgressModelRelay,
} from "../src/infrastructure/codex/modelRelay.js";

const nexttoken: ModelProviderConfig = {
  name: "Nexttoken",
  apiKey: "nexttoken-secret",
  baseUrl: "http://127.0.0.1:1/v1",
  envKey: "NEXTTOKEN_API_KEY",
};

const openrouter: ModelProviderConfig = {
  name: "OpenRouter",
  apiKey: "openrouter-secret",
  baseUrl: "http://127.0.0.1:2/api/v1",
  envKey: "OPENROUTER_API_KEY",
};

test("streams the Responses API through an HTTP/1.1 upstream connection", async (t) => {
  let receivedBody = "";
  const upstream = createServer(async (request, response) => {
    assert.equal(request.httpVersion, "1.1");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses?trace=1");
    assert.equal(request.headers.authorization, "Bearer nexttoken-secret");
    assert.equal(request.headers["x-request-id"], "relay-test");

    for await (const chunk of request) {
      receivedBody += Buffer.from(chunk).toString("utf8");
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "x-upstream-http-version": request.httpVersion,
    });
    response.write("event: response.output_text.delta\n");
    response.write('data: {"delta":"hello"}\n\n');
    setImmediate(() => response.end("event: response.completed\ndata: {}\n\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const relay = await startModelRelay({
    nexttoken: {
      ...nexttoken,
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    openrouter,
  });
  t.after(() => relay.close());

  const result = await requestRelay(
    `${relay.baseUrl}/nexttoken/v1/responses?trace=1`,
    "Bearer nexttoken-secret",
    '{"model":"gpt-5.5","stream":true}',
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(result.headers["x-upstream-http-version"], "1.1");
  assert.equal(receivedBody, '{"model":"gpt-5.5","stream":true}');
  assert.equal(
    result.body,
    'event: response.output_text.delta\ndata: {"delta":"hello"}\n\n' +
      "event: response.completed\ndata: {}\n\n",
  );
});

test("routes a project progress OpenRouter Agent through the HTTP/1.1 relay", async (t) => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.httpVersion, "1.1");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/responses");
    assert.equal(request.headers.authorization, "Bearer openrouter-secret");
    for await (const _chunk of request) {
      // Drain the request before returning the synthetic Responses stream.
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: response.completed\ndata: {}\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const relay = await startProjectProgressModelRelay({
    provider: "openrouter",
    apiBaseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
    apiKey: "openrouter-secret",
    model: "z-ai/glm-5.3",
    parameters: {},
  } satisfies ProjectProgressConfig["model"]);
  t.after(() => relay.close());

  assert.match(
    relay.model.apiBaseUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/openrouter\/v1$/,
  );
  const result = await requestRelay(
    `${relay.model.apiBaseUrl}/responses`,
    "Bearer openrouter-secret",
    "{}",
  );
  assert.equal(result.status, 200);

  const unavailableProvider = await requestRelay(
    `${relay.model.apiBaseUrl.replace("/openrouter/", "/nexttoken/")}/responses`,
    "Bearer openrouter-secret",
    "{}",
  );
  assert.equal(unavailableProvider.status, 404);
});

test("removes Responses custom tools before forwarding to OpenRouter", async (t) => {
  let receivedPayload: Record<string, unknown> | null = null;
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += Buffer.from(chunk).toString("utf8");
    }
    receivedPayload = JSON.parse(body) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const relay = await startModelRelay({
    openrouter: {
      ...openrouter,
      baseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
    },
  });
  t.after(() => relay.close());

  const result = await requestRelay(
    `${relay.baseUrl}/openrouter/v1/responses`,
    "Bearer openrouter-secret",
    JSON.stringify({
      model: "z-ai/glm-5.3",
      tools: [
        { type: "function", name: "exec_command" },
        { type: "custom", name: "apply_patch" },
      ],
    }),
  );

  assert.equal(result.status, 200);
  assert.deepEqual(receivedPayload?.tools, [
    { type: "function", name: "exec_command" },
  ]);
});

test("rejects an invalid provider credential without contacting upstream", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const relay = await startModelRelay({
    nexttoken: {
      ...nexttoken,
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    openrouter,
  });
  t.after(() => relay.close());

  const result = await requestRelay(
    `${relay.baseUrl}/nexttoken/v1/responses`,
    "Bearer wrong-secret",
    "{}",
  );

  assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "unauthorized" });
  assert.equal(upstreamRequests, 0);
});

test("returns a diagnostic 502 when the HTTP/1.1 upstream is unavailable", async (t) => {
  const unavailableUpstream = createServer();
  const unavailablePort = await listen(unavailableUpstream);
  await close(unavailableUpstream);

  const relay = await startModelRelay({
    nexttoken: {
      ...nexttoken,
      baseUrl: `https://127.0.0.1:${unavailablePort}/v1`,
    },
    openrouter,
  });
  t.after(() => relay.close());

  const result = await requestRelay(
    `${relay.baseUrl}/nexttoken/v1/responses`,
    "Bearer nexttoken-secret",
    "{}",
  );

  assert.equal(result.status, 502);
  assert.match(
    String((JSON.parse(result.body) as { error?: unknown }).error),
    /^model relay upstream request failed:/,
  );
});

test("does not expose paths outside provider-specific v1 routes", async (t) => {
  const relay = await startModelRelay({ nexttoken, openrouter });
  t.after(() => relay.close());

  const result = await requestRelay(
    `${relay.baseUrl}/health`,
    "Bearer nexttoken-secret",
    "{}",
  );

  assert.equal(result.status, 404);
  assert.deepEqual(JSON.parse(result.body), { error: "not found" });
});

test("builds provider-specific Codex base URLs when the relay is active", () => {
  const config = {
    modelRelayBaseUrl: "http://127.0.0.1:43123",
    modelProviders: { nexttoken, openrouter },
  } as AppConfig;

  assert.equal(
    resolveCodexModelBaseUrl(config, "nexttoken"),
    "http://127.0.0.1:43123/nexttoken/v1",
  );
  assert.equal(
    resolveCodexModelBaseUrl(config, "openrouter"),
    "http://127.0.0.1:43123/openrouter/v1",
  );
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestRelay(
  url: string,
  authorization: string,
  body: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-request-id": "relay-test",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
