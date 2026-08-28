import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { ModelProviderConfig } from "../../config/config.js";
import type { ModelProviderId } from "../../config/modelCatalog.js";
import type { ProjectProgressConfig } from "../../config/projectProgressConfig.js";

const RELAY_HOST = "127.0.0.1";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 1_000;
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 30_000;
const RATE_LIMIT_JITTER_RATIO = 0.25;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type ModelProviders = Partial<Record<ModelProviderId, ModelProviderConfig>>;

type ProviderRequestState = {
  admissionTail: Promise<void>;
  consecutiveRateLimits: number;
  cooldownUntil: number;
  nextAdmissionAt: number;
};

export type ModelRelayOptions = {
  minRequestIntervalMs?: number;
  rateLimitBaseDelayMs?: number;
  rateLimitMaxDelayMs?: number;
  random?: () => number;
};

type ResolvedModelRelayOptions = {
  minRequestIntervalMs: number;
  rateLimitBaseDelayMs: number;
  rateLimitMaxDelayMs: number;
  random: () => number;
};

export type ModelRelay = {
  baseUrl: string;
  close(): Promise<void>;
};

export type ProjectProgressModelRelay = {
  model: ProjectProgressConfig["model"];
  close(): Promise<void>;
};

export async function startModelRelay(
  providers: ModelProviders,
  options: ModelRelayOptions = {},
): Promise<ModelRelay> {
  const server = createModelRelayServer(providers, options);
  await listen(server);
  server.unref();
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${RELAY_HOST}:${address.port}`,
    close: () => closeServer(server),
  };
}

export async function startProjectProgressModelRelay(
  model: ProjectProgressConfig["model"],
): Promise<ProjectProgressModelRelay> {
  const providerConfig: ModelProviderConfig = {
    name: model.provider,
    apiKey: model.apiKey,
    baseUrl: model.apiBaseUrl,
    envKey: model.provider === "nexttoken"
      ? "NEXTTOKEN_API_KEY"
      : "OPENROUTER_API_KEY",
  };
  const relay = await startModelRelay({ [model.provider]: providerConfig });
  return {
    model: {
      ...model,
      apiBaseUrl: `${relay.baseUrl}/${model.provider}/v1`,
    },
    close: relay.close,
  };
}

export function createModelRelayServer(
  providers: ModelProviders,
  options: ModelRelayOptions = {},
): Server {
  const resolvedOptions = resolveModelRelayOptions(options);
  const providerStates = new Map<ModelProviderId, ProviderRequestState>();
  const server = createServer((request, response) => {
    proxyModelRequest(
      providers,
      providerStates,
      resolvedOptions,
      request,
      response,
    );
  });

  // Responses streams can legitimately run for minutes without receiving a chunk.
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

function proxyModelRequest(
  providers: ModelProviders,
  providerStates: Map<ModelProviderId, ProviderRequestState>,
  options: ResolvedModelRelayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const requestUrl = new URL(request.url || "/", "http://model-relay.local");
  const route = requestUrl.pathname.match(
    /^\/(nexttoken|openrouter)\/v1(?=\/|$)(.*)$/,
  );
  if (!route) {
    writeJson(response, 404, { error: "not found" });
    return;
  }

  const providerId = route[1] as ModelProviderId;
  const provider = providers[providerId];
  if (!provider) {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  if (!credentialsMatch(request.headers.authorization, provider.apiKey)) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  const providerState = getProviderRequestState(providerStates, providerId);

  const suffix = route[2] || "";
  const upstreamUrl = new URL(
    `${provider.baseUrl.replace(/\/+$/, "")}${suffix}${requestUrl.search}`,
  );
  let upstreamRequest: ClientRequest | null = null;
  let responseFinished = false;
  response.on("finish", () => {
    responseFinished = true;
  });
  response.on("close", () => {
    if (!responseFinished && upstreamRequest) {
      upstreamRequest.destroy();
    }
  });
  let requestAborted = false;
  request.on("aborted", () => {
    requestAborted = true;
    upstreamRequest?.destroy();
  });

  const startUpstream = (body: Buffer): void => {
    if (requestAborted) {
      return;
    }
    const requestUpstream =
      upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamHeaders = copyHeaders(request.headers, body?.byteLength);
    upstreamRequest = requestUpstream(
      upstreamUrl,
      {
        method: request.method,
        headers: upstreamHeaders,
        ...(upstreamUrl.protocol === "https:"
          ? { ALPNProtocols: ["http/1.1"] }
          : {}),
      },
      (upstreamResponse) => {
        forwardUpstreamResponse(
          providerId,
          providerState,
          options,
          upstreamResponse,
          response,
        );
      },
    );

    upstreamRequest.on("socket", (socket) => {
      socket.setKeepAlive(true, 15_000);
      socket.setNoDelay(true);
    });
    upstreamRequest.on("error", (error) => failRelay(response, error));
    upstreamRequest.end(body);
  };

  collectRequestBody(request)
    .then((body) =>
      waitForProviderAdmission(
        providerState,
        options,
        request,
        () => requestAborted,
      ).then(() =>
        startUpstream(
          providerId === "openrouter"
            ? normalizeOpenRouterRequestBody(body)
            : body,
        )
      )
    )
    .catch((error: unknown) => {
      if (!requestAborted) {
        failRelay(response, error);
      }
    });
}

function forwardUpstreamResponse(
  providerId: ModelProviderId,
  state: ProviderRequestState,
  options: ResolvedModelRelayOptions,
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
): void {
  const statusCode = upstreamResponse.statusCode ?? 502;
  if (statusCode !== 429) {
    state.consecutiveRateLimits = 0;
    response.writeHead(statusCode, upstreamResponse.statusMessage, {
      ...copyHeaders(upstreamResponse.headers),
      "x-accel-buffering": "no",
    });
    upstreamResponse.on("error", (error) => failRelay(response, error));
    upstreamResponse.pipe(response);
    return;
  }

  collectResponseBody(upstreamResponse)
    .then((body) => {
      const rateLimitError = parseRateLimitError(body);
      const retryable = isRetryableRateLimit(rateLimitError);
      const headers = copyHeaders(upstreamResponse.headers);
      const responseStatusCode = retryable ? statusCode : 402;
      let retryAfterSeconds: number | null = null;

      if (retryable) {
        state.consecutiveRateLimits += 1;
        const retryDelayMs = resolveRetryDelayMs(
          upstreamResponse.headers["retry-after"],
          state.consecutiveRateLimits,
          options,
        );
        state.cooldownUntil = Math.max(
          state.cooldownUntil,
          Date.now() + retryDelayMs,
        );
        retryAfterSeconds = Math.max(1, Math.ceil(retryDelayMs / 1_000));
        headers["retry-after"] = String(retryAfterSeconds);
      } else {
        state.consecutiveRateLimits = 0;
      }

      logRateLimit(
        providerId,
        upstreamResponse.headers,
        rateLimitError,
        retryAfterSeconds,
      );
      response.writeHead(responseStatusCode, upstreamResponse.statusMessage, {
        ...headers,
        "x-accel-buffering": "no",
      });
      response.end(body);
    })
    .catch((error: unknown) => failRelay(response, error));
}

function getProviderRequestState(
  states: Map<ModelProviderId, ProviderRequestState>,
  providerId: ModelProviderId,
): ProviderRequestState {
  const existing = states.get(providerId);
  if (existing) {
    return existing;
  }
  const state: ProviderRequestState = {
    admissionTail: Promise.resolve(),
    consecutiveRateLimits: 0,
    cooldownUntil: 0,
    nextAdmissionAt: 0,
  };
  states.set(providerId, state);
  return state;
}

function waitForProviderAdmission(
  state: ProviderRequestState,
  options: ResolvedModelRelayOptions,
  request: IncomingMessage,
  isAborted: () => boolean,
): Promise<void> {
  const admission = state.admissionTail
    .catch(() => undefined)
    .then(async () => {
      if (isAborted()) {
        throw new Error("model relay request aborted");
      }
      const readyAt = Math.max(
        Date.now(),
        state.cooldownUntil,
        state.nextAdmissionAt,
      );
      await waitForDelay(readyAt - Date.now(), request, isAborted);
      state.nextAdmissionAt = Date.now() + options.minRequestIntervalMs;
    });
  state.admissionTail = admission.catch(() => undefined);
  return admission;
}

function waitForDelay(
  delayMs: number,
  request: IncomingMessage,
  isAborted: () => boolean,
): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      request.off("aborted", onAborted);
      if (isAborted()) {
        reject(new Error("model relay request aborted"));
        return;
      }
      resolve();
    }, delayMs);
    const onAborted = () => {
      clearTimeout(timer);
      reject(new Error("model relay request aborted"));
    };
    request.once("aborted", onAborted);
  });
}

function resolveRetryDelayMs(
  retryAfter: string | string[] | undefined,
  consecutiveRateLimits: number,
  options: ResolvedModelRelayOptions,
): number {
  const upstreamDelayMs = parseRetryAfterMs(retryAfter);
  if (upstreamDelayMs !== null) {
    return upstreamDelayMs;
  }
  const exponentialDelayMs = Math.min(
    options.rateLimitMaxDelayMs,
    options.rateLimitBaseDelayMs * 2 ** Math.max(0, consecutiveRateLimits - 1),
  );
  return Math.ceil(
    exponentialDelayMs * (1 + options.random() * RATE_LIMIT_JITTER_RATIO),
  );
}

function parseRetryAfterMs(
  value: string | string[] | undefined,
): number | null {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized) {
    return null;
  }
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

function collectResponseBody(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_ERROR_RESPONSE_BYTES) {
        reject(new Error("model relay rate-limit response is too large"));
        response.destroy();
        return;
      }
      chunks.push(buffer);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

type RateLimitError = {
  code: string | null;
  type: string | null;
  message: string | null;
};

function parseRateLimitError(body: Buffer): RateLimitError {
  try {
    const payload = JSON.parse(body.toString("utf8")) as unknown;
    if (!isRecord(payload)) {
      return { code: null, type: null, message: null };
    }
    const error = isRecord(payload.error) ? payload.error : payload;
    return {
      code: stringValue(error.code),
      type: stringValue(error.type),
      message: stringValue(error.message),
    };
  } catch {
    return { code: null, type: null, message: null };
  }
}

function isRetryableRateLimit(error: RateLimitError): boolean {
  const details = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`;
  return !/(?:credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|insufficient_quota|usage limit|spend limit|credit balance|quota)/i.test(
    details,
  );
}

function logRateLimit(
  providerId: ModelProviderId,
  headers: IncomingHttpHeaders,
  error: RateLimitError,
  retryAfterSeconds: number | null,
): void {
  const requestId = firstHeaderValue(headers["x-request-id"] ?? headers["cf-ray"]);
  console.error(
    `[model-relay] ${JSON.stringify({
      event: "model.rate_limited",
      provider: providerId,
      code: error.code,
      type: error.type,
      retryable: retryAfterSeconds !== null,
      retryAfterSeconds,
      requestId,
    })}`,
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveModelRelayOptions(
  options: ModelRelayOptions,
): ResolvedModelRelayOptions {
  const resolved = {
    minRequestIntervalMs:
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    rateLimitBaseDelayMs:
      options.rateLimitBaseDelayMs ?? DEFAULT_RATE_LIMIT_BASE_DELAY_MS,
    rateLimitMaxDelayMs:
      options.rateLimitMaxDelayMs ?? DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
    random: options.random ?? Math.random,
  };
  if (
    !Number.isFinite(resolved.minRequestIntervalMs) ||
    resolved.minRequestIntervalMs < 0 ||
    !Number.isFinite(resolved.rateLimitBaseDelayMs) ||
    resolved.rateLimitBaseDelayMs < 1 ||
    !Number.isFinite(resolved.rateLimitMaxDelayMs) ||
    resolved.rateLimitMaxDelayMs < resolved.rateLimitBaseDelayMs
  ) {
    throw new Error("model relay rate-limit options are invalid");
  }
  return resolved;
}

function credentialsMatch(
  authorization: string | undefined,
  apiKey: string,
): boolean {
  const actual = Buffer.from(authorization || "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function copyHeaders(
  headers: IncomingHttpHeaders,
  bodyLength?: number,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      name !== "host" &&
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    ) {
      result[name] = value;
    }
  }
  if (bodyLength !== undefined) {
    delete result["content-length"];
    delete result["transfer-encoding"];
    result["content-length"] = bodyLength;
  }
  return result;
}

function collectRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function normalizeOpenRouterRequestBody(body: Buffer): Buffer {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return body;
  }
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    return body;
  }
  const tools = payload.tools.filter(
    (tool) => !isRecord(tool) || tool.type !== "custom",
  );
  if (tools.length === payload.tools.length) {
    return body;
  }
  return Buffer.from(JSON.stringify({ ...payload, tools }), "utf8");
}

function failRelay(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : new Error(message));
    return;
  }
  writeJson(response, 502, {
    error: `model relay upstream request failed: ${message}`,
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, RELAY_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
