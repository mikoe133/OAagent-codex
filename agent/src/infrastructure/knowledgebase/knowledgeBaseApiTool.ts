import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../config/config.js";
import { normalizeJsonLineSeparators } from "../codex/jsonLineSafety.js";
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
const MAX_KNOWLEDGE_SEARCH_QUERIES = 3;
const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;
const OA_USER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const KNOWLEDGE_BASE_AUTHORIZATION_HEADER = "authorization";
const KNOWLEDGE_BASE_OA_USER_ID_HEADER = "x-oa-user-id";
const KNOWLEDGE_BASE_IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const GENERIC_KNOWLEDGE_SEARCH_TERMS = new Set([
  "配置",
  "信息",
  "资料",
  "内容",
  "详情",
  "文档",
  "说明",
  "相关",
  "什么",
  "哪些",
  "是否",
  "以及",
  "还有",
  "请问",
  "告诉我",
  "帮我查",
]);
const CONTEXT_KNOWLEDGE_SEARCH_TERMS = new Set([
  "公司",
  "本公司",
  "当前",
  "目前",
  "有关",
  "关于",
]);
const CONTROLLED_KNOWLEDGE_BASE_HEADERS = new Set([
  KNOWLEDGE_BASE_AUTHORIZATION_HEADER,
  KNOWLEDGE_BASE_OA_USER_ID_HEADER,
  KNOWLEDGE_BASE_IDEMPOTENCY_KEY_HEADER,
  "agent_api_token",
  "x-oa-agent-id",
  "x-oa-run-id",
  "x-request-id",
]);

export async function callKnowledgeBaseApiTool(
  config: AppConfig,
  input: KnowledgeBaseApiToolInput,
  oaUserId: string | null,
  fetchImpl: KnowledgeBaseFetch = fetch,
): Promise<KnowledgeBaseApiToolResult> {
  if (!config.knowledgeBaseApiToken || !config.knowledgeBaseApiBaseUrl) {
    return toolError(
      "knowledge_base_not_configured",
      "缺少 OA_KNOWLEDGE_BASE_API_KEY 或知识库 API 地址，无法调用知识库。",
    );
  }
  if (!oaUserId || !OA_USER_ID_PATTERN.test(oaUserId)) {
    return toolError(
      "knowledge_base_user_required",
      "当前 session 缺少已验证的稳定 OA user id，无法按用户权限调用知识库。",
    );
  }
  const controlledHeaderOverride = validateControlledHeaderInput(input);
  if (controlledHeaderOverride) {
    return controlledHeaderOverride;
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
        contractPath: contracts.read.path,
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
    const query = objectField(input.query);
    if (operation.operationId === "searchKnowledgeBase") {
      return await executeKnowledgeBaseSearch(
        config,
        operation,
        renderedPath,
        query,
        oaUserId,
        fetchImpl,
      );
    }

    const { response, payload } = await requestKnowledgeBase(
      config,
      operation,
      renderedPath,
      query,
      input.body,
      oaUserId,
      fetchImpl,
    );
    const redactedPayload = redactValue(
      payload,
      config.knowledgeBaseApiToken!,
    );
    return {
      ok: response.ok,
      status: response.status,
      catalog: operation.catalog,
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      path: operation.pathTemplate,
      data: limitResponse(redactedPayload),
    };
  } catch (error) {
    return toolError(
      "knowledge_base_request_failed",
      "知识库请求失败。",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeKnowledgeBaseQuery(
  operation: KnowledgeBaseOperation,
  query: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.operationId !== "searchKnowledgeBase") {
    return query;
  }
  const searchText = stringField(query.q);
  if (!searchText) {
    return query;
  }
  const terms = normalizeKnowledgeBaseSearchText(searchText)
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) {
    return query;
  }
  const coreTerms = terms.filter((term) => !isGenericKnowledgeSearchTerm(term));
  if (coreTerms.length === 0) {
    return query;
  }
  return { ...query, q: coreTerms.join(" ") };
}

async function executeKnowledgeBaseSearch(
  config: AppConfig,
  operation: KnowledgeBaseOperation,
  renderedPath: string,
  query: Record<string, unknown>,
  oaUserId: string,
  fetchImpl: KnowledgeBaseFetch,
): Promise<KnowledgeBaseApiToolResult> {
  const normalizedQuery = normalizeKnowledgeBaseQuery(operation, query);
  const searchQueries = buildKnowledgeBaseSearchQueries(normalizedQuery);
  if (searchQueries.length === 0) {
    return toolError("missing_required_parameters", "缺少必填参数。", {
      missing: ["query.q"],
    });
  }

  const results = await Promise.all(
    searchQueries.map(async (searchQuery) => {
      try {
        const { response, payload } = await requestKnowledgeBase(
          config,
          operation,
          renderedPath,
          { ...normalizedQuery, q: searchQuery },
          undefined,
          oaUserId,
          fetchImpl,
        );
        return {
          query: searchQuery,
          response,
          payload: redactValue(payload, config.knowledgeBaseApiToken!),
          error: null,
        };
      } catch (error) {
        return {
          query: searchQuery,
          response: null,
          payload: null,
          error,
        };
      }
    }),
  );

  const attempts: Array<{ status: number; payload: unknown; query: string }> = [];
  let firstHttpFailure:
    | { status: number; payload: unknown }
    | null = null;
  let firstError: unknown = null;
  for (const result of results) {
    if (result.error) {
      firstError ??= result.error;
      continue;
    }
    if (!result.response) {
      continue;
    }
    if (!result.response.ok) {
      firstHttpFailure ??= {
        status: result.response.status,
        payload: result.payload,
      };
      continue;
    }
    attempts.push({
      status: result.response.status,
      payload: result.payload,
      query: result.query,
    });
  }

  const firstAttempt = attempts[0];
  if (!firstAttempt) {
    if (firstHttpFailure) {
      return {
        ok: false,
        status: firstHttpFailure.status,
        catalog: operation.catalog,
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        path: operation.pathTemplate,
        data: limitResponse(firstHttpFailure.payload),
      };
    }
    if (firstError !== null) {
      throw firstError;
    }
    return toolError("knowledge_base_request_failed", "知识库搜索失败。");
  }
  const mergedPayload = mergeKnowledgeBaseSearchPayloads(
    attempts.map(({ payload, query: searchQuery }) => ({
      payload,
      query: searchQuery,
    })),
    normalizedQuery,
  );
  return {
    ok: true,
    status: firstAttempt.status,
    catalog: operation.catalog,
    operationId: operation.operationId,
    method: operation.method.toUpperCase(),
    path: operation.pathTemplate,
    data: limitResponse(mergedPayload),
  };
}

async function requestKnowledgeBase(
  config: AppConfig,
  operation: KnowledgeBaseOperation,
  renderedPath: string,
  query: Record<string, unknown>,
  bodyInput: unknown,
  oaUserId: string,
  fetchImpl: KnowledgeBaseFetch,
): Promise<{ response: Response; payload: unknown }> {
  const url = new URL(
    renderedPath.replace(/^\/+/, ""),
    ensureTrailingSlash(config.knowledgeBaseApiBaseUrl!),
  );
  appendQuery(url, query);
  const headers = new Headers({
    accept: "application/json",
    [KNOWLEDGE_BASE_AUTHORIZATION_HEADER]:
      `Bearer ${config.knowledgeBaseApiToken}`,
    [KNOWLEDGE_BASE_OA_USER_ID_HEADER]: oaUserId,
  });
  if (operation.catalog === "knowledge_base_write") {
    headers.set(KNOWLEDGE_BASE_IDEMPOTENCY_KEY_HEADER, randomUUID());
  }
  const body = bodyInput === undefined ? undefined : JSON.stringify(bodyInput);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetchImpl(url, {
    method: operation.method.toUpperCase(),
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    response,
    payload: parseResponseBody(await response.text()),
  };
}

function buildKnowledgeBaseSearchQueries(
  query: Record<string, unknown>,
): string[] {
  const normalized = stringField(query.q);
  if (!normalized) {
    return [];
  }
  if (stringField(query.cursor)) {
    return [normalized];
  }

  const coreTerms = normalized
    .split(/\s+/u)
    .filter((term) => term.length > 0 && !isGenericKnowledgeSearchTerm(term));
  if (coreTerms.length <= 1) {
    return [normalized];
  }

  const candidates = [normalized];
  if (coreTerms.length >= 3) {
    candidates.push(coreTerms.slice(0, -1).join(" "));
  }
  candidates.push(coreTerms[0]!);
  return [...new Set(candidates)].slice(0, MAX_KNOWLEDGE_SEARCH_QUERIES);
}

function mergeKnowledgeBaseSearchPayloads(
  attempts: Array<{ payload: unknown; query: string }>,
  query: Record<string, unknown>,
): unknown {
  const firstPayload = attempts[0]?.payload;
  const firstRecord = isRecord(firstPayload) ? firstPayload : null;
  if (!firstRecord) {
    return firstPayload;
  }
  const limit = resolveKnowledgeSearchLimit(query);
  const merged = new Map<string, { item: Record<string, unknown>; score: number; order: number }>();
  let order = 0;
  for (const attempt of attempts) {
    const payload = attempt.payload;
    for (const item of extractKnowledgeSearchItems(payload)) {
      const key = knowledgeSearchResultKey(item, order);
      const candidate = {
        item,
        score: Math.max(
          knowledgeSearchResultScore(item, stringField(query.q) ?? ""),
          knowledgeSearchResultScore(item, attempt.query),
        ),
        order,
      };
      const existing = merged.get(key);
      if (
        !existing ||
        candidate.score > existing.score ||
        (candidate.score === existing.score &&
          stringLength(candidate.item.excerpt) > stringLength(existing.item.excerpt))
      ) {
        merged.set(key, candidate);
      }
      order += 1;
    }
  }
  const data = [...merged.values()]
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map(({ item }) => item);
  return {
    ...firstRecord,
    data,
    nextCursor: attempts.length === 1 ? firstRecord.nextCursor ?? null : null,
  };
}

function extractKnowledgeSearchItems(value: unknown): Record<string, unknown>[] {
  const data = isRecord(value) ? value.data : null;
  return Array.isArray(data)
    ? data.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function knowledgeSearchResultKey(
  item: Record<string, unknown>,
  fallback: number,
): string {
  const sourceUrl = stringField(item.sourceUrl);
  const id = stringField(item.id);
  return sourceUrl ? `url:${sourceUrl}` : id ? `id:${id}` : `item:${fallback}`;
}

function knowledgeSearchResultScore(
  item: Record<string, unknown>,
  query: string,
): number {
  const normalizedQuery = normalizeKnowledgeSearchMatchText(query);
  if (!normalizedQuery) {
    return 0;
  }
  const title = normalizeKnowledgeSearchMatchText(stringField(item.title) ?? "");
  const excerpt = normalizeKnowledgeSearchMatchText(stringField(item.excerpt) ?? "");
  const fields = [title, excerpt].filter(Boolean);
  const allFields = fields.join(" ");
  const queryTerms = query
    .split(/\s+/u)
    .map(normalizeKnowledgeSearchMatchText)
    .filter(Boolean);
  if (title.includes(normalizedQuery)) {
    return 100;
  }
  if (queryTerms.length > 1 && queryTerms.every((term) => title.includes(term))) {
    return 90;
  }
  if (excerpt.includes(normalizedQuery)) {
    return 80;
  }
  if (queryTerms.length > 1 && queryTerms.every((term) => allFields.includes(term))) {
    return 70;
  }
  return queryTerms.some((term) => allFields.includes(term)) ? 30 : 0;
}

function resolveKnowledgeSearchLimit(query: Record<string, unknown>): number {
  const value = Number(query.limit);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, 50)
    : DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
}

function normalizeKnowledgeBaseSearchText(value: string): string {
  const terms = value
    .replace(/[，。；;、|/]+/gu, " ")
    .split(/\s+/u)
    .map((term) => stripGenericSearchSuffix(term.trim()))
    .filter(Boolean);
  for (let index = 0; index < terms.length; index += 1) {
    terms[index] = stripContextSearchPrefix(terms[index]!);
  }
  while (terms.length > 1 && CONTEXT_KNOWLEDGE_SEARCH_TERMS.has(terms[0]!)) {
    terms.shift();
  }
  return terms.join(" ");
}

function stripContextSearchPrefix(value: string): string {
  for (const prefix of [...CONTEXT_KNOWLEDGE_SEARCH_TERMS].sort(
    (left, right) => right.length - left.length,
  )) {
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

function stripGenericSearchSuffix(value: string): string {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of [...GENERIC_KNOWLEDGE_SEARCH_TERMS].sort(
      (left, right) => right.length - left.length,
    )) {
      if (result.endsWith(suffix) && result.length > suffix.length) {
        result = result.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function isGenericKnowledgeSearchTerm(term: string): boolean {
  return (
    GENERIC_KNOWLEDGE_SEARCH_TERMS.has(term) ||
    CONTEXT_KNOWLEDGE_SEARCH_TERMS.has(term)
  );
}

function normalizeKnowledgeSearchMatchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
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
      if (
        (catalog === "knowledge_base_read" && method !== "get") ||
        (catalog === "knowledge_base_write" && method === "get")
      ) {
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
    } else if (location === "header" && !isControlledKnowledgeBaseHeader(name)) {
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

function validateControlledHeaderInput(
  input: KnowledgeBaseApiToolInput,
): KnowledgeBaseApiToolResult | null {
  const rawInput = input as Record<string, unknown>;
  const attemptedFields: string[] = [];
  for (const name of Object.keys(rawInput)) {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === "header" ||
      normalizedName === "headers" ||
      CONTROLLED_KNOWLEDGE_BASE_HEADERS.has(normalizedName)
    ) {
      attemptedFields.push(name);
    }
  }
  for (const name of Object.keys(objectField(input.query))) {
    if (isControlledKnowledgeBaseHeader(name)) {
      attemptedFields.push(`query.${name}`);
    }
  }
  if (attemptedFields.length === 0) {
    return null;
  }
  return toolError(
    "controlled_headers_not_allowed",
    "知识库鉴权、用户身份与幂等 Header 只能由服务端根据环境变量、当前登录 session 和请求上下文组装。",
    { attemptedFields },
  );
}

function isControlledKnowledgeBaseHeader(name: string): boolean {
  return CONTROLLED_KNOWLEDGE_BASE_HEADERS.has(name.toLowerCase());
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
    const normalized = normalizeJsonLineSeparators(value);
    return normalized.length <= MAX_RESPONSE_STRING_LENGTH
      ? normalized
      : `${normalized.slice(0, MAX_RESPONSE_STRING_LENGTH)}... [TRUNCATED]`;
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
