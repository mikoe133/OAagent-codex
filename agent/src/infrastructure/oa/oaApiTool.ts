import type { AppConfig } from "../../config/config.js";
import { resolveOpenApiContract } from "./openApiContract.js";

export type OaApiToolInput = {
  sessionId?: unknown;
  operationId?: unknown;
  method?: unknown;
  path?: unknown;
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
  confirmed?: unknown;
};

export type OaApiToolResult = {
  ok: boolean;
  status?: number;
  operationId?: string;
  method?: string;
  path?: string;
  warnings?: string[];
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type OpenApiOperation = {
  operationId: string;
  method: string;
  pathTemplate: string;
  operation: Record<string, unknown>;
};

const OPENAPI_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MUTATING_OPERATION_PATTERN =
  /delete|remove|create|add|update|edit|modify|save|submit|upload|import|approve|reject|change.?password|reset.?password|permission|role|admin|删除|移除|新增|创建|修改|更新|保存|提交|上传|导入|审批|通过|驳回|拒绝|密码|权限|角色|管理/i;
const READ_ONLY_OPERATION_PATTERN =
  /(^|[_/ -])(get|list|query|search|find|detail|details|read|view|preview|count|stat|stats|export|download|report)([_/ -]|$)|查询|读取|查看|列表|详情|搜索|统计|报表|周报|日报|月报|导出|下载/i;
const MAX_TOOL_PAGE_SIZE = 30;
const MAX_TOOL_ARRAY_ITEMS = 30;
const MAX_TOOL_OBJECT_KEYS = 80;
const MAX_TOOL_STRING_LENGTH = 6000;
const MAX_TOOL_OUTPUT_DEPTH = 8;

export async function callOaApiTool(
  config: AppConfig,
  input: OaApiToolInput,
  sessionOaApiToken: string | null = null,
): Promise<OaApiToolResult> {
  if (!config.oaApiBaseUrl || !sessionOaApiToken) {
    return toolError(
      "oa_not_configured",
      "缺少 OA_API_BASE_URL 或 OA 登录态,无法调用 OA 后端。",
    );
  }

  const { document: openapi } = await resolveOpenApiContract(config);
  const operation = resolveOperation(openapi, input);
  if (isToolResult(operation)) {
    return operation;
  }

  const validationError = validateOperationInput(operation.operation, input);
  if (validationError) {
    return validationError;
  }

  if (isSensitiveOperation(operation) && input.confirmed !== true) {
    return toolError(
      "confirmation_required",
      "该接口可能产生敏感影响,调用前必须获得用户确认,并在工具参数中传入 confirmed=true。",
      {
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        path: operation.pathTemplate,
      },
    );
  }

  const path = renderPath(operation.pathTemplate, objectField(input.pathParams));
  if (isToolResult(path)) {
    return path;
  }

  const normalizedQuery = normalizeQueryForTool(objectField(input.query));
  const response = await requestOa(config, {
    method: operation.method.toUpperCase(),
    path: path.value,
    query: normalizedQuery.value,
    body: input.body,
    oaApiToken: sessionOaApiToken,
  });
  const limitedData = limitToolOutput(response.data);
  const warnings = [
    ...normalizedQuery.warnings,
    ...(limitedData.truncated
      ? [
          `响应过大,已截断数组超过 ${MAX_TOOL_ARRAY_ITEMS} 项、对象超过 ${MAX_TOOL_OBJECT_KEYS} 个字段或字符串超过 ${MAX_TOOL_STRING_LENGTH} 字符的部分。需要更多数据时请缩小查询条件或分页继续查询。`,
        ]
      : []),
  ];

  return {
    ok: response.ok,
    status: response.status,
    operationId: operation.operationId,
    method: operation.method.toUpperCase(),
    path: operation.pathTemplate,
    ...(warnings.length > 0 ? { warnings } : {}),
    data: limitedData.value,
  };
}

function resolveOperation(
  openapi: unknown,
  input: OaApiToolInput,
): OpenApiOperation | OaApiToolResult {
  const operationId = stringField(input.operationId);
  const method = stringField(input.method)?.toLowerCase();
  const path = stringField(input.path);

  if (operationId) {
    const operation = findOperationById(openapi, operationId);
    if (!operation) {
      return toolError(
        "operation_not_found",
        `当前 OpenAPI 契约中不存在 operationId=${operationId}。`,
      );
    }
    if (method && method !== operation.method) {
      return toolError("operation_mismatch", "method 与 operationId 不匹配。", {
        expected: operation.method.toUpperCase(),
        actual: method.toUpperCase(),
      });
    }
    if (path && path !== operation.pathTemplate) {
      return toolError("operation_mismatch", "path 与 operationId 不匹配。", {
        expected: operation.pathTemplate,
        actual: path,
      });
    }
    return operation;
  }

  if (!method || !path) {
    return toolError(
      "missing_operation",
      "必须提供 operationId,或同时提供 method 和 path。",
    );
  }

  const operation = findOperationByMethodAndPath(openapi, method, path);
  if (!operation) {
    return toolError(
      "operation_not_found",
      `当前 OpenAPI 契约中不存在 ${method.toUpperCase()} ${path}。`,
    );
  }
  return operation;
}

function findOperationById(
  openapi: unknown,
  operationId: string,
): OpenApiOperation | null {
  for (const operation of listOperations(openapi)) {
    if (operation.operationId === operationId) {
      return operation;
    }
  }
  return null;
}

function findOperationByMethodAndPath(
  openapi: unknown,
  method: string,
  path: string,
): OpenApiOperation | null {
  for (const operation of listOperations(openapi)) {
    if (operation.method === method && operation.pathTemplate === path) {
      return operation;
    }
  }
  return null;
}

function listOperations(openapi: unknown): OpenApiOperation[] {
  if (!isRecord(openapi) || !isRecord(openapi.paths)) {
    return [];
  }

  const operations: OpenApiOperation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(openapi.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const method of OPENAPI_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        continue;
      }
      const operationId = stringField(operation.operationId);
      if (!operationId) {
        continue;
      }
      operations.push({ operationId, method, pathTemplate, operation });
    }
  }
  return operations;
}

function validateOperationInput(
  operation: Record<string, unknown>,
  input: OaApiToolInput,
): OaApiToolResult | null {
  const query = objectField(input.query);
  const pathParams = objectField(input.pathParams);
  const missing: string[] = [];
  const unsupported: string[] = [];

  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : [];
  for (const parameter of parameters) {
    if (!isRecord(parameter) || parameter.required !== true) {
      continue;
    }
    const name = stringField(parameter.name);
    const location = stringField(parameter.in);
    if (!name || !location) {
      continue;
    }
    if (location === "query" && !hasNonEmptyField(query, name)) {
      missing.push(`query.${name}`);
    } else if (location === "path" && !hasNonEmptyField(pathParams, name)) {
      missing.push(`pathParams.${name}`);
    } else if (location === "header" || location === "cookie") {
      unsupported.push(`${location}.${name}`);
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
      "接口声明了必填 header/cookie 参数,当前受控工具不允许 agent 自行传入这类参数。",
      { unsupported },
    );
  }

  if (isRecord(operation.requestBody) && operation.requestBody.required === true) {
    if (input.body === undefined || input.body === null) {
      return toolError("missing_required_body", "缺少必填 request body。");
    }
  }

  return null;
}

function isSensitiveOperation(operation: OpenApiOperation): boolean {
  if (operation.method === "get") {
    return false;
  }

  const text = [
    operation.operationId,
    operation.pathTemplate,
    stringField(operation.operation.summary) ?? "",
    stringField(operation.operation.description) ?? "",
  ].join(" ");

  if (READ_ONLY_OPERATION_PATTERN.test(text)) {
    return false;
  }

  return MUTATING_OPERATION_PATTERN.test(text);
}

function renderPath(
  pathTemplate: string,
  pathParams: Record<string, unknown>,
): { ok: true; value: string } | OaApiToolResult {
  let path = pathTemplate;
  for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (!name || !hasNonEmptyField(pathParams, name)) {
      return toolError("missing_path_parameter", `缺少路径参数:${name ?? ""}`);
    }
    path = path.replace(
      `{${name}}`,
      encodeURIComponent(String(pathParams[name])),
    );
  }
  return { ok: true, value: path };
}

async function requestOa(
  config: AppConfig,
  request: {
    method: string;
    path: string;
    query: Record<string, unknown>;
    body: unknown;
    oaApiToken: string;
  },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = new URL(request.path, ensureTrailingSlash(config.oaApiBaseUrl!));
  for (const [key, value] of Object.entries(request.query)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({ accept: "application/json" });
  headers.set(
    config.oaApiTokenHeader,
    formatTokenHeaderValue(config.oaApiTokenPrefix, request.oaApiToken),
  );

  let body: string | undefined;
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(request.body);
  }

  const response = await fetch(url, {
    method: request.method,
    headers,
    body,
  });
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    data: redactValue(parseResponseBody(text), [
      request.oaApiToken,
      config.oaApiToolToken,
    ]),
  };
}

function toolError(
  code: string,
  message: string,
  details?: unknown,
): OaApiToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function isToolResult(
  value:
    | OaApiToolResult
    | OpenApiOperation
    | { ok: true; value: string },
): value is OaApiToolResult {
  return "error" in value || ("ok" in value && value.ok === false);
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasNonEmptyField(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const fieldValue = value[field];
  return fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
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

function formatTokenHeaderValue(prefix: string, token: string): string {
  if (!prefix) {
    return token;
  }
  if (prefix.endsWith("=")) {
    return `${prefix}${token}`;
  }
  return `${prefix} ${token}`;
}

function normalizeQueryForTool(query: Record<string, unknown>): {
  value: Record<string, unknown>;
  warnings: string[];
} {
  const normalized = { ...query };
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (!isPaginationSizeKey(key)) {
      continue;
    }

    const size = positiveIntegerValue(value);
    if (size !== null && size > MAX_TOOL_PAGE_SIZE) {
      normalized[key] = MAX_TOOL_PAGE_SIZE;
      warnings.push(
        `query.${key}=${size} 过大,受控工具已限制为 ${MAX_TOOL_PAGE_SIZE};如需更多数据请继续分页查询。`,
      );
    }
  }

  return { value: normalized, warnings };
}

function isPaginationSizeKey(key: string): boolean {
  return /^(size|limit|pageSize|page_size|perPage|per_page)$/i.test(key);
}

function positiveIntegerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function limitToolOutput(value: unknown, depth = 0): {
  value: unknown;
  truncated: boolean;
} {
  if (depth > MAX_TOOL_OUTPUT_DEPTH) {
    return { value: "[TRUNCATED: max depth]", truncated: true };
  }

  if (typeof value === "string") {
    if (value.length <= MAX_TOOL_STRING_LENGTH) {
      return { value, truncated: false };
    }
    return {
      value: `${value.slice(0, MAX_TOOL_STRING_LENGTH)}... [TRUNCATED ${value.length - MAX_TOOL_STRING_LENGTH} chars]`,
      truncated: true,
    };
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { value, truncated: false };
  }

  if (Array.isArray(value)) {
    let truncated = value.length > MAX_TOOL_ARRAY_ITEMS;
    const items = value
      .slice(0, MAX_TOOL_ARRAY_ITEMS)
      .map((item) => {
        const limited = limitToolOutput(item, depth + 1);
        truncated ||= limited.truncated;
        return limited.value;
      });

    if (value.length > MAX_TOOL_ARRAY_ITEMS) {
      items.push({
        __truncated: true,
        omittedItems: value.length - MAX_TOOL_ARRAY_ITEMS,
      });
    }

    return { value: items, truncated };
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    let truncated = entries.length > MAX_TOOL_OBJECT_KEYS;
    const limitedEntries = entries
      .slice(0, MAX_TOOL_OBJECT_KEYS)
      .map(([key, item]) => {
        const limited = limitToolOutput(item, depth + 1);
        truncated ||= limited.truncated;
        return [key, limited.value] as const;
      });
    const result: Record<string, unknown> = Object.fromEntries(limitedEntries);

    if (entries.length > MAX_TOOL_OBJECT_KEYS) {
      result.__truncated = true;
      result.omittedFields = entries.length - MAX_TOOL_OBJECT_KEYS;
    }

    return { value: result, truncated };
  }

  return { value: String(value), truncated: false };
}

function redactValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 8) {
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, secrets, depth + 1),
      ]),
    );
  }
  return String(value);
}

function redactSecrets(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      text,
    );
}
