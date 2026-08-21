import type { AppConfig } from "../../config/config.js";
import type { OpenApiCatalog } from "../oa/openApiIndex.js";
import { resolveKnowledgeBaseContracts } from "./knowledgeBaseContract.js";

export type KnowledgeBaseApiToolInput = {
  sessionId?: unknown;
  operationId?: unknown;
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
  confirmed?: unknown;
};

export type KnowledgeBaseApiToolResult = {
  ok: boolean;
  status?: number;
  catalog?: OpenApiCatalog;
  operationId?: string;
  method?: string;
  path?: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type KnowledgeBaseOperation = {
  catalog: Extract<
    OpenApiCatalog,
    "knowledge_base_read" | "knowledge_base_write"
  >;
  document: Record<string, unknown>;
  operationId: string;
  method: string;
  pathTemplate: string;
  pathItem: Record<string, unknown>;
  operation: Record<string, unknown>;
};

type KnowledgeBaseFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const OPENAPI_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_STRING_LENGTH = 24_000;
const MAX_RESPONSE_ARRAY_ITEMS = 50;
const MAX_RESPONSE_OBJECT_KEYS = 100;
const MAX_RESPONSE_DEPTH = 10;
const OA_USER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;

export async function callKnowledgeBaseApiTool(
  config: AppConfig,
  input: KnowledgeBaseApiToolInput,
  oaUserId: string | null,
  fetchImpl: KnowledgeBaseFetch = fetch,
): Promise<KnowledgeBaseApiToolResult> {
  if (!config.knowledgeBaseApiToken || !config.knowledgeBaseApiBaseUrl) {
    return toolError(
      "knowledge_base_not_configured",
      "缺少 OA_KNOWLEDGE_API_KEY 或知识库 API 地址，无法调用知识库。",
    );
  }
  if (!oaUserId || !OA_USER_ID_PATTERN.test(oaUserId)) {
    return toolError(
      "knowledge_base_user_required",
      "当前 session 缺少已验证的稳定 OA user id，无法按用户权限调用知识库。",
    );
  }

  const contracts = await resolveKnowledgeBaseContracts(config);
  const operationId = stringField(input.operationId);
  if (!operationId) {
    return toolError("missing_operation", "必须提供知识库 operationId。");
  }
  const operations = [
    ...listOperations(
      contracts.read.document,
      "knowledge_base_read",
    ),
    ...(contracts.write
      ? listOperations(contracts.write.document, "knowledge_base_write")
      : []),
  ].filter((operation) => operation.operationId === operationId);
  if (operations.length === 0) {
    return toolError(
      "operation_not_found",
      `当前知识库契约中不存在 operationId=${operationId}。`,
      {
        writeContractAvailable: contracts.write !== null,
        writeContractPath: contracts.writePath,
      },
    );
  }
  if (operations.length > 1) {
    return toolError(
      "ambiguous_operation",
      `知识库读写契约中存在重复 operationId=${operationId}。`,
    );
  }
  const operation = operations[0]!;
  const validationError = validateOperationInput(operation, input);
  if (validationError) {
    return validationError;
  }
  if (
    (operation.catalog === "knowledge_base_write" ||
      operation.method !== "get") &&
    input.confirmed !== true
  ) {
    return toolError(
      "confirmation_required",
      "知识库写操作必须先获得用户确认，并传入 confirmed=true。",
      {
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        path: operation.pathTemplate,
      },
    );
  }

  const renderedPath = renderPath(
    operation.pathTemplate,
    objectField(input.pathParams),
  );
  if (typeof renderedPath !== "string") {
    return renderedPath;
  }

  try {
    const url = new URL(
      renderedPath.replace(/^\/+/, ""),
      ensureTrailingSlash(config.knowledgeBaseApiBaseUrl),
    );
    appendQuery(url, objectField(input.query));
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${config.knowledgeBaseApiToken}`,
      "x-oa-user-id": oaUserId,
    });
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await fetchImpl(url, {
      method: operation.method.toUpperCase(),
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = redactValue(
      parseResponseBody(await response.text()),
      config.knowledgeBaseApiToken,
    );
    return {
      ok: response.ok,
      status: response.status,
      catalog: operation.catalog,
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      path: operation.pathTemplate,
      data: limitResponse(payload),
    };
  } catch (error) {
    return toolError(
      "knowledge_base_request_failed",
      "知识库请求失败。",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function listOperations(
  rawDocument: unknown,
  catalog: KnowledgeBaseOperation["catalog"],
): KnowledgeBaseOperation[] {
  if (!isRecord(rawDocument) || !isRecord(rawDocument.paths)) {
    return [];
  }
  const operations: KnowledgeBaseOperation[] = [];
  for (const [pathTemplate, rawPathItem] of Object.entries(rawDocument.paths)) {
    if (!isRecord(rawPathItem)) {
      continue;
    }
    for (const method of OPENAPI_METHODS) {
      const operation = rawPathItem[method];
      if (!isRecord(operation)) {
        continue;
      }
      const operationId = stringField(operation.operationId);
      if (!operationId) {
        continue;
      }
      operations.push({
        catalog,
        document: rawDocument,
        operationId,
        method,
        pathTemplate,
        pathItem: rawPathItem,
        operation,
      });
    }
  }
  return operations;
}

function validateOperationInput(
  operation: KnowledgeBaseOperation,
  input: KnowledgeBaseApiToolInput,
): KnowledgeBaseApiToolResult | null {
  const query = objectField(input.query);
  const pathParams = objectField(input.pathParams);
  const missing: string[] = [];
  const unsupported: string[] = [];
  const parameters = [
    ...unknownArray(operation.pathItem.parameters),
    ...unknownArray(operation.operation.parameters),
  ];
  for (const rawParameter of parameters) {
    const parameter = resolveReference(operation.document, rawParameter);
    const name = stringField(parameter?.name);
    const location = stringField(parameter?.in);
    if (!parameter || !name || !location || parameter.required !== true) {
      continue;
    }
    if (location === "query" && !hasNonEmptyField(query, name)) {
      missing.push(`query.${name}`);
    } else if (location === "path" && !hasNonEmptyField(pathParams, name)) {
      missing.push(`pathParams.${name}`);
    } else if (
      location === "header" &&
      name.toLowerCase() !== "x-oa-user-id"
    ) {
      unsupported.push(`header.${name}`);
    } else if (location === "cookie") {
      unsupported.push(`cookie.${name}`);
    }
  }
  if (missing.length > 0) {
    return toolError("missing_required_parameters", "缺少必填参数。", {
      missing,
    });
  }
  if (unsupported.length > 0) {
    return toolError(
      "unsupported_required_parameters",
      "知识库契约声明了工具不能由模型传入的必填 header/cookie。",
      { unsupported },
    );
  }
  const requestBody = resolveReference(
    operation.document,
    operation.operation.requestBody,
  );
  if (
    requestBody?.required === true &&
    (input.body === undefined || input.body === null)
  ) {
    return toolError("missing_required_body", "缺少必填 request body。");
  }
  return null;
}

function renderPath(
  pathTemplate: string,
  pathParams: Record<string, unknown>,
): string | KnowledgeBaseApiToolResult {
  let result = pathTemplate;
  for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (!name || !hasNonEmptyField(pathParams, name)) {
      return toolError("missing_path_parameter", `缺少路径参数:${name ?? ""}`);
    }
    result = result.replace(`{${name}}`, encodeURIComponent(String(pathParams[name])));
  }
  return result;
}

function appendQuery(url: URL, query: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(name, String(item)));
    } else {
      url.searchParams.set(name, String(value));
    }
  }
}

function resolveReference(
  document: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> | null {
  const record = isRecord(value) ? value : null;
  const reference = stringField(record?.$ref);
  if (!reference?.startsWith("#/")) {
    return record;
  }
  const resolved = reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (current, segment) => (isRecord(current) ? current[segment] : null),
      document,
    );
  return isRecord(resolved) ? resolved : null;
}

function parseResponseBody(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function limitResponse(value: unknown, depth = 0): unknown {
  if (depth > MAX_RESPONSE_DEPTH) {
    return "[DISPLAY_TRUNCATED: max depth]";
  }
  if (typeof value === "string") {
    return value.length <= MAX_RESPONSE_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_RESPONSE_STRING_LENGTH)}... [TRUNCATED]`;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RESPONSE_ARRAY_ITEMS)
      .map((item) => limitResponse(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_RESPONSE_OBJECT_KEYS)
        .map(([key, item]) => [key, limitResponse(item, depth + 1)]),
    );
  }
  return value;
}

function redactValue(value: unknown, secret: string, depth = 0): unknown {
  if (depth > MAX_RESPONSE_DEPTH) {
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    return value.split(secret).join("[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secret, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, secret, depth + 1),
      ]),
    );
  }
  return value;
}

function toolError(
  code: string,
  message: string,
  details?: unknown,
): KnowledgeBaseApiToolResult {
  return { ok: false, error: { code, message, details } };
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasNonEmptyField(
  value: Record<string, unknown>,
  name: string,
): boolean {
  const field = value[name];
  return field !== undefined && field !== null && String(field).trim().length > 0;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
