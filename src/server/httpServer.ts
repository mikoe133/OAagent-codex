import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { AgentService, AgentStreamEvent } from "./agentService.js";
import { callOaApiTool } from "./oaApiTool.js";
import type { SessionStore } from "./sessionStore.js";

const MAX_BODY_BYTES = 128 * 1024;

type JsonObject = Record<string, unknown>;

export function startHttpServer(
  config: AppConfig,
  agentService: AgentService,
  sessionStore: SessionStore,
): void {
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(config, agentService, sessionStore, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  });

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
}

async function routeRequest(
  config: AppConfig,
  agentService: AgentService,
  sessionStore: SessionStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://localhost");

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

  if (!isAuthorized(config, request)) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJsonBody(request);
    const sessionId = stringField(body, "sessionId") || randomUUID();
    validateSessionId(sessionId);
    const oaApiToken = readOaApiTokenFromRequest(config, request);
    if (oaApiToken) {
      await sessionStore.bindOaToken(sessionId, oaApiToken);
    }
    const session = await sessionStore.getOrCreate(sessionId);
    writeJson(response, 201, session);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/sessions") {
    writeJson(response, 200, { sessions: await sessionStore.list() });
    return;
  }

  const messageMatch = url.pathname.match(
    /^\/v1\/sessions\/([^/]+)\/messages$/,
  );
  if (method === "POST" && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1] ?? "");
    validateSessionId(sessionId);
    const body = await readJsonBody(request);
    const message = stringField(body, "message");
    if (!message) {
      writeJson(response, 400, { error: "message 必须是非空字符串" });
      return;
    }

    const result = await agentService.sendMessage({
      sessionId,
      message,
      oaApiToken: readOaApiTokenFromRequest(config, request),
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
    const body = await readJsonBody(request);
    const message = stringField(body, "message");
    if (!message) {
      writeJson(response, 400, { error: "message 必须是非空字符串" });
      return;
    }

    await streamAgentMessage(agentService, request, response, {
      sessionId,
      message,
      oaApiToken: readOaApiTokenFromRequest(config, request),
    });
    return;
  }

  writeJson(response, 404, { error: "not found" });
}

function isAuthorized(config: AppConfig, request: IncomingMessage): boolean {
  if (!config.agentApiToken) {
    return true;
  }
  return request.headers.authorization === `Bearer ${config.agentApiToken}`;
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
    if (isAgentAuthorizationHeader(config, headerName, raw)) {
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

function isAgentAuthorizationHeader(
  config: AppConfig,
  headerName: string,
  value: string,
): boolean {
  return (
    headerName.toLowerCase() === "authorization" &&
    Boolean(config.agentApiToken) &&
    value === `Bearer ${config.agentApiToken}`
  );
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
  input: { sessionId: string; message: string; oaApiToken: string | null },
): Promise<void> {
  const abortController = new AbortController();
  let closed = false;
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
  response.write(": connected\n\n");

  try {
    await agentService.streamMessage(
      input,
      async (event) => writeSseEvent(response, event),
      abortController.signal,
    );
  } catch (error) {
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

function writeSseEvent(
  response: ServerResponse,
  event: AgentStreamEvent,
): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
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
