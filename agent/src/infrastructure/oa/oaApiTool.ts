import type { AppConfig } from "../../config/config.js";
import { resolveOpenApiContract } from "./openApiContract.js";
import {
  cacheOaApiResult,
  clearCachedOaApiResult,
  getCachedOaApiResult,
  getActiveOaQueryPolicy,
  getStoredOaResponse,
  recordOaApiCallResult,
  reserveOaApiCall,
  storeOaResponse,
  type OaIdentityMatch,
} from "./oaQueryPolicy.js";
import {
  canStoreProgressiveResponse,
  inferOaResponseCoverage,
  inspectOaResponse,
  requiresProgressiveInspection,
  runOaResponseAction,
  type OaResponseCoverage,
} from "./oaResponseNavigator.js";

export type OaApiToolInput = {
  sessionId?: unknown;
  operationId?: unknown;
  method?: unknown;
  path?: unknown;
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
  confirmed?: unknown;
  responseId?: unknown;
  action?: unknown;
  responsePath?: unknown;
  conditions?: unknown;
  fields?: unknown;
  groupBy?: unknown;
  offset?: unknown;
  limit?: unknown;
};

export type OaApiToolResult = {
  ok: boolean;
  status?: number;
  operationId?: string;
  method?: string;
  path?: string;
  responseId?: string;
  coverage?: OaResponseCoverage;
  identityMatch?: OaIdentityMatch;
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
  const sessionId = stringField(input.sessionId);
  if (!config.oaApiBaseUrl || !sessionOaApiToken) {
    return toolError(
      "oa_not_configured",
      "缺少 OA_API_BASE_URL 或 OA 登录态,无法调用 OA 后端。",
    );
  }

  const responseId = stringField(input.responseId);
  if (responseId) {
    return navigateStoredResponse(sessionId, responseId, input);
  }

  const { document: openapi } = await resolveOpenApiContract(config);
  const operation = resolveOperation(openapi, input);
  if (isToolResult(operation)) {
    return operation;
  }

  const query = applyConfiguredOaAlias(
    operation.operation,
    objectField(input.query),
    config.oaAuthAlias,
  );
  const normalizedInput = { ...input, query };
  const validationError = validateOperationInput(
    operation.operation,
    normalizedInput,
  );
  if (validationError) {
    recordOaApiCallResult(sessionId, validationError);
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
    recordOaApiCallResult(sessionId, path);
    return path;
  }

  const normalizedQuery = normalizeQueryForTool(query);
  const requestKey = buildOaRequestKey(
    operation,
    path.value,
    normalizedQuery.value,
    input.body,
  );
  const cachedResult = getCachedOaApiResult(sessionId, requestKey);
  if (cachedResult !== undefined) {
    return (await cachedResult) as OaApiToolResult;
  }

  const reservation = reserveOaApiCall(sessionId);
  if (!reservation.allowed) {
    return toolError(
      "oa_call_budget_exceeded",
      "当前查询的首次结果完整,本 turn 不再执行额外 OA 查询。请直接基于已有结果回答。",
    );
  }
  const resultPromise = executeOaRequest(
    config,
    operation,
    path.value,
    normalizedQuery.value,
    normalizedQuery.warnings,
    input.body,
    sessionId,
    sessionOaApiToken,
  );
  cacheOaApiResult(sessionId, requestKey, resultPromise);
  try {
    return await resultPromise;
  } catch (error) {
    clearCachedOaApiResult(sessionId, requestKey);
    throw error;
  }
}

async function executeOaRequest(
  config: AppConfig,
  operation: OpenApiOperation,
  renderedPath: string,
  query: Record<string, unknown>,
  queryWarnings: string[],
  body: unknown,
  sessionId: string | null,
  sessionOaApiToken: string,
): Promise<OaApiToolResult> {
  const response = await requestOa(config, {
    method: operation.method.toUpperCase(),
    path: renderedPath,
    query,
    body,
    oaApiToken: sessionOaApiToken,
  });
  const exactPersonName = getActiveOaQueryPolicy(sessionId)?.exactPersonName;
  const focusedResult = exactPersonName
    ? focusExactPersonResult(response.data, exactPersonName)
    : null;
  const focusedData = focusedResult?.data ?? response.data;
  const coverage = inferOaResponseCoverage(
    focusedData,
    operationDeclaresPagination(operation),
  );
  const progressive = (coverage.status === "partial" ||
    requiresProgressiveInspection(focusedData)) &&
    canStoreProgressiveResponse(focusedData);
  const responseId = progressive
    ? storeOaResponse(sessionId, {
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        path: operation.pathTemplate,
        data: focusedData,
        coverage,
      })
    : null;
  if (responseId) {
    const result: OaApiToolResult = {
      ok: response.ok,
      status: response.status,
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      path: operation.pathTemplate,
      responseId,
      coverage,
      ...(focusedResult ? { identityMatch: focusedResult.identityMatch } : {}),
      ...(queryWarnings.length > 0 ? { warnings: queryWarnings } : {}),
      data: inspectOaResponse(focusedData),
    };
    recordOaApiCallResult(sessionId, result);
    return result;
  }
  const limitedData = limitToolOutput(focusedData);
  const warnings = [
    ...queryWarnings,
    ...(limitedData.truncated
      ? [
          "响应过大,已缩小展示范围;源数据仍然完整。需要更多细节时请缩小查询条件后查看。",
        ]
      : []),
  ];
  const result: OaApiToolResult = {
    ok: response.ok,
    status: response.status,
    operationId: operation.operationId,
    method: operation.method.toUpperCase(),
    path: operation.pathTemplate,
    coverage,
    ...(focusedResult ? { identityMatch: focusedResult.identityMatch } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    data: limitedData.value,
  };
  recordOaApiCallResult(sessionId, result);
  return result;
}

function navigateStoredResponse(
  sessionId: string | null,
  responseId: string,
  input: OaApiToolInput,
): OaApiToolResult {
  if (!sessionId) {
    return toolError(
      "response_session_required",
      "渐进式响应读取必须提供当前 sessionId。",
    );
  }
  const stored = getStoredOaResponse(sessionId, responseId);
  if (!stored) {
    return toolError(
      "response_not_found",
      "responseId 不存在、已过期或不属于当前 turn。请重新调用原 OA 接口。",
    );
  }
  const actionResult = runOaResponseAction(stored, input);
  if (!actionResult.ok) {
    return toolError(actionResult.code, actionResult.message, actionResult.details);
  }
  const limitedData = limitToolOutput(actionResult.data);
  return {
    ok: true,
    operationId: stored.operationId,
    method: stored.method,
    path: stored.path,
    responseId,
    coverage: actionResult.coverage,
    ...(limitedData.truncated
      ? { warnings: ["渐进式分析结果过大,已缩小展示范围;请缩小 fields、conditions 或 read 范围。"] }
      : {}),
    data: limitedData.value,
  };
}

function buildOaRequestKey(
  operation: OpenApiOperation,
  renderedPath: string,
  query: Record<string, unknown>,
  body: unknown,
): string {
  return JSON.stringify({
    operationId: operation.operationId,
    method: operation.method.toUpperCase(),
    path: renderedPath,
    query: canonicalizeQuery(query),
    body: canonicalizeRequestValue(body),
  });
}

function canonicalizeQuery(query: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(query)
      .sort()
      .filter((key) => query[key] !== null && query[key] !== undefined)
      .map((key) => [key, String(query[key])]),
  );
}

function canonicalizeRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeRequestValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeRequestValue(value[key])]),
    );
  }
  return value;
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

function applyConfiguredOaAlias(
  operation: Record<string, unknown>,
  query: Record<string, unknown>,
  alias: string,
): Record<string, unknown> {
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : [];
  const declaresAlias = parameters.some(
    (parameter) =>
      isRecord(parameter) &&
      stringField(parameter.in) === "query" &&
      stringField(parameter.name) === "alias",
  );

  return declaresAlias ? { ...query, alias } : query;
}

function isPaginationSizeKey(key: string): boolean {
  return /^(size|limit|pageSize|page_size|perPage|per_page)$/i.test(key);
}

function operationDeclaresPagination(operation: OpenApiOperation): boolean {
  const parameters = Array.isArray(operation.operation.parameters)
    ? operation.operation.parameters
    : [];
  return parameters.some(
    (parameter) =>
      isRecord(parameter) &&
      stringField(parameter.in) === "query" &&
      Boolean(stringField(parameter.name)?.match(/^(?:page|cursor|offset|size|limit|pageSize|page_size|perPage|per_page)$/i)),
  );
}

function focusExactPersonResult(
  value: unknown,
  exactName: string,
): { data: unknown; identityMatch: OaIdentityMatch } {
  const matches: Array<{ item: Record<string, unknown>; fields: string[] }> = [];
  const seen = new Set<object>();
  const scannedCandidates = collectExactPersonMatches(
    value,
    normalizePersonName(exactName),
    matches,
    seen,
  );
  if (matches.length === 0) {
    return {
      data: value,
      identityMatch: {
        query: exactName,
        status: scannedCandidates > 0 ? "not_found" : "insufficient",
        scannedCandidates,
        matched: 0,
      },
    };
  }
  const matchedItems = matches.map(({ item }) => item);
  const identityMatch: OaIdentityMatch = {
    query: exactName,
    status: "matched",
    scannedCandidates,
    matched: matches.length,
    matchedBy: matches.map(({ fields }, itemIndex) => ({ itemIndex, fields })),
  };
  if (!isRecord(value)) {
    return { data: matchedItems, identityMatch };
  }

  const metadata = Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        (item === null || typeof item !== "object") &&
        !/^(?:total|total_?count|page|page_?size|next|next_?page|has_?next)$/i.test(
          key,
        ),
    ),
  );
  return { data: { ...metadata, data: matchedItems }, identityMatch };
}

function collectExactPersonMatches(
  value: unknown,
  exactName: string,
  matches: Array<{ item: Record<string, unknown>; fields: string[] }>,
  seen: Set<object>,
  depth = 0,
): number {
  if (
    depth > MAX_TOOL_OUTPUT_DEPTH ||
    value === null ||
    typeof value !== "object" ||
    matches.length >= MAX_TOOL_ARRAY_ITEMS ||
    seen.has(value)
  ) {
    return 0;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let scannedCandidates = 0;
    for (const item of value) {
      scannedCandidates += collectExactPersonMatches(
        item,
        exactName,
        matches,
        seen,
        depth + 1,
      );
    }
    return scannedCandidates;
  }

  const record = value as Record<string, unknown>;
  const identityEntries = Object.entries(record).filter(
    ([key, item]) => isPersonIdentityField(key, record) && typeof item === "string",
  );
  if (identityEntries.length > 0) {
    const matchedFields = identityEntries
      .filter(([, item]) => normalizePersonName(item as string) === exactName)
      .map(([key]) => key);
    if (matchedFields.length > 0) {
      matches.push({ item: record, fields: matchedFields });
    }
    return 1;
  }

  let scannedCandidates = 0;
  for (const item of Object.values(record)) {
    scannedCandidates += collectExactPersonMatches(
      item,
      exactName,
      matches,
      seen,
      depth + 1,
    );
  }
  return scannedCandidates;
}

function isPersonIdentityField(
  key: string,
  record: Record<string, unknown>,
): boolean {
  if (
    /^(?:full_?name|real_?name|display_?name|employee_?name|chinese_?name|user_?name|wx_?name|qq_?name|email|alias)$/i.test(
      key,
    )
  ) {
    return true;
  }
  return key.toLowerCase() === "name" && Object.keys(record).some((field) =>
    /^(?:user|employee|staff|member)_?id$/i.test(field),
  );
}

function normalizePersonName(value: string): string {
  return value.replace(/[\s·•]/g, "").toLocaleLowerCase("zh-CN");
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
    return { value: "[DISPLAY_TRUNCATED: max depth]", truncated: true };
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
        __display_truncated: true,
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
      result.__display_truncated = true;
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
