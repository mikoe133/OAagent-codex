import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AgentService,
  AgentStreamEvent,
  SendMessageInput,
} from "../application/agentService.js";
import type { AppConfig } from "../config/config.js";
import {
  MODEL_CATALOG,
  MODEL_CATALOG_VERSION,
  getDefaultModel,
  getModelDisplayName,
  resolveAutomationModelSelection,
  resolveRequestedModel,
  resolveRequestedProvider,
  type ModelProviderId,
} from "../config/modelCatalog.js";
import { callOaApiTool } from "../infrastructure/oa/oaApiTool.js";
import { callKnowledgeBaseApiTool } from "../infrastructure/knowledgebase/knowledgeBaseApiTool.js";
import { recordKnowledgeBaseSourceResult } from "../infrastructure/knowledgebase/knowledgeBaseSources.js";
import { validateOaToken } from "../infrastructure/oa/oaTokenVerifier.js";
import type { SessionStore } from "../infrastructure/persistence/sessionStore.js";
import type { AutomationHttpApplication } from "../automation/http/automationHttpApplication.js";
import {
  chatLatencyMetrics,
  type ChatLatencyMetricsRecorder,
} from "../infrastructure/observability/chatLatency.js";

const MAX_BODY_BYTES = 128 * 1024;

type JsonObject = Record<string, unknown>;

export function startHttpServer(
  config: AppConfig,
  agentService: AgentService,
  sessionStore: SessionStore,
  automationHttp?: AutomationHttpApplication,
): Server {
  const server = createAgentHttpServer(
    config,
    agentService,
    sessionStore,
    automationHttp,
  );

  server.listen(config.serverPort, config.serverHost, () => {
    console.error(
      `[server] listening on http://${config.serverHost}:${config.serverPort}`,
    );
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[server] ${config.serverHost}:${config.serverPort} 已被占用,请停止旧服务或设置 PORT 使用其他端口。`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

export function createAgentHttpServer(
  config: AppConfig,
  agentService: AgentService,
  sessionStore: SessionStore,
  automationHttp?: AutomationHttpApplication,
  latencyMetrics: ChatLatencyMetricsRecorder = chatLatencyMetrics,
) {
  return createServer(async (request, response) => {
    try {
      await routeRequest(
        config,
        agentService,
        sessionStore,
        request,
        response,
        automationHttp,
        latencyMetrics,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  });
}

async function routeRequest(
  config: AppConfig,
  agentService: AgentService,
  sessionStore: SessionStore,
  request: IncomingMessage,
  response: ServerResponse,
  automationHttp?: AutomationHttpApplication,
  latencyMetrics: ChatLatencyMetricsRecorder = chatLatencyMetrics,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://localhost");
  const latency = isChatMessagePath(method, url.pathname)
    ? latencyMetrics.start({ requestId: randomUUID() })
    : undefined;
  if (latency) {
    response.once("finish", () => {
      latency.finish({
        status: response.statusCode >= 400 ? "failed" : "completed",
        ...(response.statusCode >= 400
          ? { errorCode: `http_${response.statusCode}` }
          : {}),
      });
    });
    response.once("close", () => {
      if (!response.writableFinished) {
        latency.finish({ status: "aborted", errorCode: "client_disconnected" });
      }
    });
  }

  if (method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (method === "POST" && url.pathname === "/__internal/call-oa-api") {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    if (
      request.headers.authorization !== `Bearer ${config.oaApiToolToken}`
    ) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    const sessionId = stringField(body, "sessionId");
    if (sessionId && !isValidSessionId(sessionId)) {
      writeJson(response, 200, {
        ok: false,
        error: {
          code: "invalid_session_id",
          message: "sessionId 格式非法。",
        },
      });
      return;
    }
    const sessionOaApiToken = sessionId
      ? sessionStore.getOaToken(sessionId)
      : null;
    writeJson(
      response,
      200,
      await callOaApiTool(config, body, sessionOaApiToken),
    );
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/__internal/call-knowledge-base-api"
  ) {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${config.oaApiToolToken}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    const sessionId = stringField(body, "sessionId");
    if (!sessionId || !isValidSessionId(sessionId)) {
      writeJson(response, 200, {
        ok: false,
        error: {
          code: "invalid_session_id",
          message: "知识库调用必须提供合法 sessionId。",
        },
      });
      return;
    }
    const result = await callKnowledgeBaseApiTool(
      config,
      body,
      sessionStore.getOaUserId(sessionId),
    );
    recordKnowledgeBaseSourceResult(sessionId, result);
    writeJson(response, 200, result);
    return;
  }

  if (automationHttp && (await automationHttp.handle(request, response, url))) {
    return;
  }

  if (
    url.pathname.startsWith("/internal/v1/models") ||
    url.pathname.startsWith("/v1/automation/")
  ) {
    await handleAutomationApi(config, request, response, method, url.pathname);
    return;
  }

  if (!url.pathname.startsWith("/v1/")) {
    writeJson(response, 404, { error: "not found" });
    return;
  }

  const finishAuth = latency?.startStage("auth");
  const oaApiToken = readOaApiTokenFromRequest(config, request);
  if (!oaApiToken) {
    finishAuth?.();
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  const tokenValidation = await validateOaToken(config, oaApiToken);
  finishAuth?.();
  if (tokenValidation.status === "invalid") {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (tokenValidation.status === "unavailable") {
    writeJson(response, 503, { error: "OA authentication service unavailable" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    writeJson(response, 200, {
      provider: config.modelProvider,
      models: [...MODEL_CATALOG[config.modelProvider]],
      providers: MODEL_CATALOG,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJsonBody(request);
    const sessionId = stringField(body, "sessionId") || randomUUID();
    validateSessionId(sessionId);
    if (
      !(await sessionStore.bindOaToken(
        sessionId,
        oaApiToken,
        tokenValidation.principalId,
        tokenValidation.oaUserId,
      ))
    ) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    const session = await sessionStore.getOrCreate(sessionId);
    writeJson(response, 201, session);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/sessions") {
    writeJson(response, 200, {
      sessions: await sessionStore.listForOwner(tokenValidation.principalId),
    });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    validateSessionId(sessionId);
    writeJson(response, 200, {
      deleted: await sessionStore.removeForOwner(
        sessionId,
        tokenValidation.principalId,
      ),
      sessionId,
    });
    return;
  }

  const messageMatch = url.pathname.match(
    /^\/v1\/sessions\/([^/]+)\/messages$/,
  );
  if (method === "POST" && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1] ?? "");
    validateSessionId(sessionId);
    if (
      !(await sessionStore.bindOaToken(
        sessionId,
        oaApiToken,
        tokenValidation.principalId,
        tokenValidation.oaUserId,
      ))
    ) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    const body = await readJsonBody(request);
    const message = stringField(body, "message");
    if (!message) {
      writeJson(response, 400, { error: "message 必须是非空字符串" });
      return;
    }
    const selection = resolveMessageSelection(config, body, response);
    if (!selection) {
      return;
    }

    const result = await agentService.sendMessage({
      sessionId,
      message,
      provider: selection.provider,
      model: selection.model,
      oaApiToken,
      oaUserId: tokenValidation.oaUserId,
      latency,
    });
    latency?.finish({
      status: "completed",
      provider: result.provider,
      model: result.model,
    });
    writeJson(response, 200, result);
    return;
  }

  const streamMessageMatch = url.pathname.match(
    /^\/v1\/sessions\/([^/]+)\/messages\/stream$/,
  );
  if (method === "POST" && streamMessageMatch) {
    const sessionId = decodeURIComponent(streamMessageMatch[1] ?? "");
    validateSessionId(sessionId);
    if (
      !(await sessionStore.bindOaToken(
        sessionId,
        oaApiToken,
        tokenValidation.principalId,
        tokenValidation.oaUserId,
      ))
    ) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    const body = await readJsonBody(request);
    const message = stringField(body, "message");
    if (!message) {
      writeJson(response, 400, { error: "message 必须是非空字符串" });
      return;
    }
    const selection = resolveMessageSelection(config, body, response);
    if (!selection) {
      return;
    }

    await streamAgentMessage(agentService, request, response, {
      sessionId,
      message,
      provider: selection.provider,
      model: selection.model,
      oaApiToken,
      oaUserId: tokenValidation.oaUserId,
      latency,
    });
    return;
  }

  writeJson(response, 404, { error: "not found" });
}

async function handleAutomationApi(
  config: AppConfig,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  pathname: string,
): Promise<void> {
  if (!config.automationApiToken) {
    writeJson(response, 503, { error: "automation API is not configured" });
    return;
  }
  if (!hasAutomationAuthorization(request, config.automationApiToken)) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (
    method === "GET" &&
    (pathname === "/internal/v1/models" || pathname === "/v1/automation/models")
  ) {
    writeJson(response, 200, {
      data: {
        catalog_version: MODEL_CATALOG_VERSION,
        providers: Object.entries(MODEL_CATALOG).map(([provider, models]) => ({
          provider,
          display_name: config.modelProviders[provider as ModelProviderId].name,
          models: models.map((model) => ({
            model_id: model,
            display_name: getModelDisplayName(model),
            enabled: true,
            supports_structured_output: true,
            is_default: model === getDefaultModel(provider as ModelProviderId),
          })),
        })),
      },
    });
    return;
  }

  if (
    method === "POST" &&
    (
      pathname === "/internal/v1/models/validate" ||
      pathname === "/v1/automation/models/validate"
    )
  ) {
    if (!isJsonRequest(request)) {
      writeJson(response, 415, {
        code: "invalid_request",
        error: "Content-Type 必须是 application/json",
      });
      return;
    }
    let body: JsonObject;
    try {
      body = await readJsonBody(request);
    } catch {
      writeJson(response, 400, {
        code: "invalid_request",
        error: "请求体必须是合法 JSON object",
      });
      return;
    }
    const modelProvider = stringField(body, "provider") ||
      stringField(body, "model_provider");
    const modelId = stringField(body, "model_id");
    if (!modelProvider || !modelId) {
      writeJson(response, 422, {
        data: {
          valid: false,
          catalog_version: MODEL_CATALOG_VERSION,
        },
      });
      return;
    }
    try {
      resolveAutomationModelSelection(
        {
          modelProvider,
          modelId,
          modelParameters: {},
        },
        {
          modelProvider: config.modelProvider,
          modelId: config.model,
        },
      );
      writeJson(response, 200, {
        data: {
          valid: true,
          catalog_version: MODEL_CATALOG_VERSION,
        },
      });
    } catch {
      writeJson(response, 200, {
        data: {
          valid: false,
          catalog_version: MODEL_CATALOG_VERSION,
        },
      });
    }
    return;
  }

  writeJson(response, 404, { error: "not found" });
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = headerValue(request, "content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasAutomationAuthorization(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const authorization = headerValue(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const receivedToken = authorization.slice("Bearer ".length).trim();
  if (!receivedToken) {
    return false;
  }
  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function readOaApiTokenFromRequest(
  config: AppConfig,
  request: IncomingMessage,
): string | null {
  const configuredHeader = config.oaUserTokenHeader;
  const candidates = uniqueHeaderNames([
    configuredHeader,
    "x-oa-api-token",
    "cookie",
  ]);

  for (const headerName of candidates) {
    const raw = headerValue(request, headerName);
    if (!raw) {
      continue;
    }
    const prefixes =
      headerName.toLowerCase() === "cookie"
        ? uniqueStrings([config.oaUserTokenPrefix, "sessionid="])
        : [config.oaUserTokenPrefix];
    for (const prefix of prefixes) {
      const token = parseIncomingOaToken(headerName, raw, prefix);
      if (token) {
        return token;
      }
    }
  }

  return null;
}

function uniqueHeaderNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function headerValue(
  request: IncomingMessage,
  headerName: string,
): string | null {
  const value = request.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find((item) => item.trim())?.trim() ?? null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseIncomingOaToken(
  headerName: string,
  rawValue: string,
  prefix: string,
): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (headerName.toLowerCase() === "cookie") {
    return prefix.endsWith("=")
      ? parseCookieValue(value, prefix.slice(0, -1))
      : null;
  }

  if (!prefix) {
    return value;
  }

  const lowerValue = value.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (prefix.endsWith("=") && lowerValue.startsWith(lowerPrefix)) {
    const token = value.slice(prefix.length).trim();
    return token || null;
  }

  const prefixWithSpace = `${prefix} `;
  if (lowerValue.startsWith(prefixWithSpace.toLowerCase())) {
    const token = value.slice(prefixWithSpace.length).trim();
    return token || null;
  }

  if (headerName.toLowerCase() === "authorization") {
    return null;
  }

  return value;
}

function parseCookieValue(cookieHeader: string, cookieName: string): string | null {
  if (!cookieName) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === cookieName) {
      const cookieValue = valueParts.join("=").trim();
      return cookieValue || null;
    }
  }
  return null;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("请求体过大");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求体必须是 JSON object");
  }
  return parsed as JsonObject;
}

function stringField(body: JsonObject, field: string): string | null {
  const value = body[field];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveMessageSelection(
  config: AppConfig,
  body: JsonObject,
  response: ServerResponse,
): { provider: ModelProviderId; model: string } | null {
  const rawProvider = body.provider;
  if (rawProvider !== undefined && typeof rawProvider !== "string") {
    writeJson(response, 400, { error: "provider 必须是字符串" });
    return null;
  }
  const rawModel = body.model;
  if (rawModel !== undefined && typeof rawModel !== "string") {
    writeJson(response, 400, { error: "model 必须是字符串" });
    return null;
  }

  try {
    const provider = resolveRequestedProvider(rawProvider, config.modelProvider);
    const fallbackModel =
      provider === config.modelProvider ? config.model : getDefaultModel(provider);
    return {
      provider,
      model: resolveRequestedModel(provider, rawModel, fallbackModel),
    };
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function validateSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      "sessionId 只能包含字母、数字、下划线、点、冒号和连字符,长度 1-120。",
    );
  }
}

function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(sessionId);
}

async function streamAgentMessage(
  agentService: AgentService,
  request: IncomingMessage,
  response: ServerResponse,
  input: SendMessageInput,
): Promise<void> {
  const abortController = new AbortController();
  let closed = false;
  response.socket?.setNoDelay(true);
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": keep-alive\n\n");
    }
  }, 15_000);

  response.on("close", () => {
    closed = true;
    abortController.abort();
  });

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.write(": connected\n\n");
  input.latency?.mark("stream_connected");

  try {
    await agentService.streamMessage(
      input,
      async (event) => writeSseEvent(response, event),
      abortController.signal,
    );
    input.latency?.finish({
      status: "completed",
      provider: input.provider ?? undefined,
      model: input.model ?? undefined,
    });
  } catch (error) {
    input.latency?.finish({
      status: abortController.signal.aborted ? "aborted" : "failed",
      provider: input.provider ?? undefined,
      model: input.model ?? undefined,
      errorCode: abortController.signal.aborted
        ? "client_disconnected"
        : "agent_failed",
    });
    if (!closed && !response.writableEnded) {
      const message = error instanceof Error ? error.message : String(error);
      writeSseEvent(response, {
        type: "run.failed",
        sessionId: input.sessionId,
        error: message,
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed && !response.writableEnded) {
      response.end();
    }
  }
}

function isChatMessagePath(method: string, pathname: string): boolean {
  return method === "POST" &&
    /^\/v1\/sessions\/[^/]+\/messages(?:\/stream)?$/.test(pathname);
}

function writeSseEvent(
  response: ServerResponse,
  event: AgentStreamEvent,
): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: JsonObject,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}
