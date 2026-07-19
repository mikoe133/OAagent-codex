import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
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

const RELAY_HOST = "127.0.0.1";
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

type ModelProviders = Record<ModelProviderId, ModelProviderConfig>;

export type ModelRelay = {
  baseUrl: string;
  close(): Promise<void>;
};

export async function startModelRelay(
  providers: ModelProviders,
): Promise<ModelRelay> {
  const server = createModelRelayServer(providers);
  await listen(server);
  server.unref();
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${RELAY_HOST}:${address.port}`,
    close: () => closeServer(server),
  };
}

export function createModelRelayServer(providers: ModelProviders): Server {
  const server = createServer((request, response) => {
    proxyModelRequest(providers, request, response);
  });

  // Responses streams can legitimately run for minutes without receiving a chunk.
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

function proxyModelRequest(
  providers: ModelProviders,
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
  if (!credentialsMatch(request.headers.authorization, provider.apiKey)) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }

  const suffix = route[2] || "";
  const upstreamUrl = new URL(
    `${provider.baseUrl.replace(/\/+$/, "")}${suffix}${requestUrl.search}`,
  );
  const requestUpstream =
    upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = requestUpstream(
    upstreamUrl,
    {
      method: request.method,
      headers: copyHeaders(request.headers),
      ...(upstreamUrl.protocol === "https:"
        ? { ALPNProtocols: ["http/1.1"] }
        : {}),
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        {
          ...copyHeaders(upstreamResponse.headers),
          "x-accel-buffering": "no",
        },
      );
      upstreamResponse.on("error", (error) => failRelay(response, error));
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("socket", (socket) => {
    socket.setKeepAlive(true, 15_000);
    socket.setNoDelay(true);
  });
  upstreamRequest.on("error", (error) => failRelay(response, error));

  let responseFinished = false;
  response.on("finish", () => {
    responseFinished = true;
  });
  response.on("close", () => {
    if (!responseFinished) {
      upstreamRequest.destroy();
    }
  });
  request.on("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

function credentialsMatch(
  authorization: string | undefined,
  apiKey: string,
): boolean {
  const actual = Buffer.from(authorization || "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function copyHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
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
  return result;
}

function failRelay(response: ServerResponse, error: Error): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  writeJson(response, 502, {
    error: `model relay upstream request failed: ${error.message}`,
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
