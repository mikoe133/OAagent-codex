import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";

import { verifyOaSession } from "../auth/oaSession.js";

const MAX_BODY_BYTES = 1024 * 1024;

export type AutomationOperations = {
  getModelCatalog(userId: number): Promise<unknown>;
  getPromptProfile(jobType: string, userId: number): Promise<unknown>;
  patchPromptProfile(jobType: string, body: unknown, userId: number): Promise<unknown>;
  listTags(query: URLSearchParams, userId: number): Promise<unknown>;
  createTag(body: unknown, userId: number): Promise<unknown>;
  patchTag(tagId: number, body: unknown, userId: number): Promise<unknown>;
  deleteTag(tagId: number, userId: number): Promise<unknown>;
  listJobs(query: URLSearchParams, userId: number): Promise<unknown>;
  createJob(body: unknown, userId: number): Promise<unknown>;
  getJob(jobId: number, query: URLSearchParams, userId: number): Promise<unknown>;
  patchJob(jobId: number, body: unknown, userId: number): Promise<unknown>;
  deleteJob(jobId: number, version: number, userId: number): Promise<unknown>;
  validateJob(jobId: number, userId: number): Promise<unknown>;
  triggerJob(jobId: number, userId: number): Promise<unknown>;
  listRuns(query: URLSearchParams, userId: number): Promise<unknown>;
  getRun(runId: string, query: URLSearchParams, userId: number): Promise<unknown>;
  cancelRun(runId: string, userId: number): Promise<unknown>;
  listTraceEvents(runId: string, query: URLSearchParams, userId: number): Promise<unknown>;
  claimRun(body: unknown): Promise<unknown>;
  heartbeatRun(runId: string, body: unknown): Promise<unknown>;
  updateRun(runId: string, body: unknown): Promise<unknown>;
  upsertRunProject(runId: string, projectId: number, body: unknown): Promise<unknown>;
  createAiInteraction(runId: string, body: unknown): Promise<unknown>;
  upsertTraceEvent(runId: string, body: unknown): Promise<unknown>;
};

export type AutomationHttpConfig = {
  sessionSecret: string;
  sessionVerifyMaxAgeSeconds: number;
  internalToken: string;
};

export class AutomationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomationHttpError";
  }
}

export class AutomationHttpApplication {
  constructor(
    private readonly config: AutomationHttpConfig,
    private readonly operations: AutomationOperations,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const isUserRoute = url.pathname.startsWith("/automation-");
    const isInternalRoute = url.pathname.startsWith("/internal/automation-");
    if (!isUserRoute && !isInternalRoute) {
      return false;
    }

    try {
      const method = request.method ?? "GET";
      const data = isInternalRoute
        ? await this.routeInternal(request, method, url)
        : await this.routeUser(request, method, url);
      if (
        data === null &&
        method === "POST" &&
        url.pathname === "/internal/automation-job-runs/claim"
      ) {
        response.writeHead(204);
        response.end();
        return true;
      }
      const accepted =
        method === "POST" && /^\/automation-jobs\/\d+\/runs$/.test(url.pathname);
      const created =
        method === "POST" &&
        (url.pathname === "/automation-tags" ||
          url.pathname === "/automation-jobs" ||
          /^\/internal\/automation-job-runs\/[^/]+\/ai-interactions$/.test(
            url.pathname,
          ));
      writeEnvelope(response, accepted ? 202 : created ? 201 : 200, data);
    } catch (error) {
      writeAutomationError(response, error);
    }
    return true;
  }

  private async routeUser(
    request: IncomingMessage,
    method: string,
    url: URL,
  ): Promise<unknown> {
    const userId = this.authenticateUser(request);
    const path = url.pathname;

    if (method === "GET" && path === "/automation-models") {
      return this.operations.getModelCatalog(userId);
    }
    const promptMatch = path.match(/^\/automation-prompt-profiles\/([^/]+)$/);
    if (promptMatch) {
      const jobType = decodeURIComponent(promptMatch[1] ?? "");
      if (method === "GET") {
        return this.operations.getPromptProfile(jobType, userId);
      }
      if (method === "PATCH") {
        return this.operations.patchPromptProfile(
          jobType,
          await readJsonBody(request),
          userId,
        );
      }
    }
    if (path === "/automation-tags") {
      if (method === "GET") {
        return this.operations.listTags(url.searchParams, userId);
      }
      if (method === "POST") {
        return this.operations.createTag(await readJsonBody(request), userId);
      }
    }
    const tagMatch = path.match(/^\/automation-tags\/(\d+)$/);
    if (tagMatch) {
      const tagId = positiveInteger(tagMatch[1], "tag_id");
      if (method === "PATCH") {
        return this.operations.patchTag(tagId, await readJsonBody(request), userId);
      }
      if (method === "DELETE") {
        return this.operations.deleteTag(tagId, userId);
      }
    }
    if (path === "/automation-jobs") {
      if (method === "GET") {
        return this.operations.listJobs(url.searchParams, userId);
      }
      if (method === "POST") {
        return this.operations.createJob(await readJsonBody(request), userId);
      }
    }
    const jobActionMatch = path.match(
      /^\/automation-jobs\/(\d+)\/(validate|runs)$/,
    );
    if (method === "POST" && jobActionMatch) {
      const jobId = positiveInteger(jobActionMatch[1], "job_id");
      return jobActionMatch[2] === "validate"
        ? this.operations.validateJob(jobId, userId)
        : this.operations.triggerJob(jobId, userId);
    }
    const jobMatch = path.match(/^\/automation-jobs\/(\d+)$/);
    if (jobMatch) {
      const jobId = positiveInteger(jobMatch[1], "job_id");
      if (method === "GET") {
        return this.operations.getJob(jobId, url.searchParams, userId);
      }
      if (method === "PATCH") {
        return this.operations.patchJob(jobId, await readJsonBody(request), userId);
      }
      if (method === "DELETE") {
        const version = positiveInteger(url.searchParams.get("version"), "version");
        return this.operations.deleteJob(jobId, version, userId);
      }
    }
    if (method === "GET" && path === "/automation-job-runs") {
      return this.operations.listRuns(url.searchParams, userId);
    }
    const runActionMatch = path.match(
      /^\/automation-job-runs\/([^/]+)\/(cancel|trace-events)$/,
    );
    if (runActionMatch) {
      const runId = safeIdentifier(runActionMatch[1], "run_id");
      if (method === "POST" && runActionMatch[2] === "cancel") {
        return this.operations.cancelRun(runId, userId);
      }
      if (method === "GET" && runActionMatch[2] === "trace-events") {
        return this.operations.listTraceEvents(runId, url.searchParams, userId);
      }
    }
    const runMatch = path.match(/^\/automation-job-runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      return this.operations.getRun(
        safeIdentifier(runMatch[1], "run_id"),
        url.searchParams,
        userId,
      );
    }
    throw new AutomationHttpError(404, "not_found", "接口不存在");
  }

  private async routeInternal(
    request: IncomingMessage,
    method: string,
    url: URL,
  ): Promise<unknown> {
    this.authenticateInternal(request);
    const path = url.pathname;
    if (method === "POST" && path === "/internal/automation-job-runs/claim") {
      return this.operations.claimRun(await readJsonBody(request));
    }
    const projectMatch = path.match(
      /^\/internal\/automation-job-runs\/([^/]+)\/projects\/(\d+)$/,
    );
    if (method === "PUT" && projectMatch) {
      return this.operations.upsertRunProject(
        safeIdentifier(projectMatch[1], "run_id"),
        positiveInteger(projectMatch[2], "project_id"),
        await readJsonBody(request),
      );
    }
    const actionMatch = path.match(
      /^\/internal\/automation-job-runs\/([^/]+)\/(heartbeat|ai-interactions|trace-events)$/,
    );
    if (actionMatch) {
      const runId = safeIdentifier(actionMatch[1], "run_id");
      const body = await readJsonBody(request);
      if (method === "POST" && actionMatch[2] === "heartbeat") {
        return this.operations.heartbeatRun(runId, body);
      }
      if (method === "POST" && actionMatch[2] === "ai-interactions") {
        return this.operations.createAiInteraction(runId, body);
      }
      if (method === "POST" && actionMatch[2] === "trace-events") {
        return this.operations.upsertTraceEvent(runId, body);
      }
    }
    const runMatch = path.match(/^\/internal\/automation-job-runs\/([^/]+)$/);
    if (method === "PATCH" && runMatch) {
      return this.operations.updateRun(
        safeIdentifier(runMatch[1], "run_id"),
        await readJsonBody(request),
      );
    }
    throw new AutomationHttpError(404, "not_found", "接口不存在");
  }

  private authenticateUser(request: IncomingMessage): number {
    const token = readSessionToken(request);
    if (!token) {
      throw new AutomationHttpError(401, "unauthorized", "未登录或登录态无效");
    }
    try {
      return verifyOaSession(token, {
        secret: this.config.sessionSecret,
        maxAgeSeconds: this.config.sessionVerifyMaxAgeSeconds,
      }).userId;
    } catch {
      throw new AutomationHttpError(401, "unauthorized", "未登录或登录态无效");
    }
  }

  private authenticateInternal(request: IncomingMessage): void {
    const authorization = headerValue(request, "authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!constantTimeEqual(token, this.config.internalToken)) {
      throw new AutomationHttpError(
        401,
        "automation_service_unauthorized",
        "内部认证失败",
      );
    }
  }
}

function readSessionToken(request: IncomingMessage): string | null {
  const cookie = headerValue(request, "cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...values] = part.trim().split("=");
      if (name === "sessionid") {
        return values.join("=").trim() || null;
      }
    }
  }
  const direct = headerValue(request, "sessionid");
  if (direct) {
    return direct;
  }
  const authorization = headerValue(request, "authorization");
  const match = authorization?.match(/^(?:Bearer|sessionid=)\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = headerValue(request, "content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new AutomationHttpError(
      415,
      "invalid_request",
      "Content-Type 必须是 application/json",
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new AutomationHttpError(413, "request_too_large", "请求体过大");
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new AutomationHttpError(400, "invalid_request", "请求体必须是 JSON object");
  }
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return typeof value === "string" ? value.trim() || null : null;
}

function positiveInteger(value: string | null | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AutomationHttpError(422, "invalid_request", `${name} 必须是正整数`);
  }
  return parsed;
}

function safeIdentifier(value: string | undefined, name: string): string {
  const decoded = decodeURIComponent(value ?? "");
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(decoded)) {
    throw new AutomationHttpError(422, "invalid_request", `${name} 格式无效`);
  }
  return decoded;
}

function constantTimeEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function writeAutomationError(response: ServerResponse, error: unknown): void {
  if (error instanceof AutomationHttpError) {
    writeEnvelope(
      response,
      error.status,
      { error_code: error.code, details: null },
      error.message,
      false,
    );
    return;
  }
  if (error instanceof ZodError) {
    writeEnvelope(
      response,
      422,
      {
        error_code: error.issues[0]?.message || "validation_error",
        details: error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
      "请求字段校验失败",
      false,
    );
    return;
  }
  const diagnosticCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.name
        : "unknown_error";
  console.error(`[automation-http] request failed: ${diagnosticCode}`);
  writeEnvelope(response, 500, null, "自动任务服务内部错误", false);
}

function writeEnvelope(
  response: ServerResponse,
  status: number,
  data: unknown,
  message = status === 201 ? "created" : status === 202 ? "accepted" : "success",
  success = true,
): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ code: status, message, data, success }));
}
