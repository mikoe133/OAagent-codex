export type OaResponseCoverage = {
  status: "complete" | "partial" | "unknown";
  received?: number;
  knownTotal?: number;
  reason?: string;
};

export type StoredOaResponse = {
  operationId: string;
  method: string;
  path: string;
  data: unknown;
  coverage: OaResponseCoverage;
};

export type OaResponseActionInput = {
  action?: unknown;
  responsePath?: unknown;
  conditions?: unknown;
  fields?: unknown;
  groupBy?: unknown;
  offset?: unknown;
  limit?: unknown;
};

export type OaResponseActionResult =
  | {
      ok: true;
      coverage: OaResponseCoverage;
      data: unknown;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: unknown;
    };

type StructureEntry = {
  path: string;
  type: string;
  fields?: string[];
  fieldCount?: number;
  length?: number;
  itemTypes?: string[];
  itemFields?: string[];
  sample?: unknown;
};

type ConditionOperator = "eq" | "contains" | "in" | "exists";

type ParsedCondition = {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
};

type ParsedConditionExpression =
  | { type: "condition"; condition: ParsedCondition }
  | { type: "all" | "any"; conditions: ParsedConditionExpression[] };

const MAX_PROGRESSIVE_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_RESPONSE_BYTES = 24 * 1024;
const PROGRESSIVE_ARRAY_ITEMS = 30;
const PROGRESSIVE_OBJECT_KEYS = 80;
const PROGRESSIVE_STRING_LENGTH = 6000;
const PROGRESSIVE_DEPTH = 8;
const MAX_STRUCTURE_ENTRIES = 100;
const MAX_STRUCTURE_FIELDS = 100;
const MAX_ACTION_RESULTS = 100;
const DEFAULT_ACTION_RESULTS = 20;

export function requiresProgressiveInspection(value: unknown): boolean {
  return (
    exceedsInlineBudget(value) ||
    exceedsCollectionBudget(value) ||
    exceedsInlineByteBudget(value)
  );
}

export function canStoreProgressiveResponse(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PROGRESSIVE_RESPONSE_BYTES;
  } catch {
    return false;
  }
}

function exceedsCollectionBudget(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): boolean {
  return countCollectionItems(value, depth, seen) > PROGRESSIVE_ARRAY_ITEMS;
}

function exceedsInlineByteBudget(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_INLINE_RESPONSE_BYTES;
  } catch {
    return true;
  }
}

function countCollectionItems(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): number {
  if (depth > PROGRESSIVE_DEPTH || value === null || typeof value !== "object") {
    return 0;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let count = value.length;
    for (const item of value) {
      count += countCollectionItems(item, depth + 1, seen);
      if (count > PROGRESSIVE_ARRAY_ITEMS) {
        break;
      }
    }
    return count;
  }

  let count = 0;
  for (const item of Object.values(value)) {
    count += countCollectionItems(item, depth + 1, seen);
    if (count > PROGRESSIVE_ARRAY_ITEMS) {
      break;
    }
  }
  return count;
}

export function inferOaResponseCoverage(
  value: unknown,
  operationDeclaresPagination: boolean,
): OaResponseCoverage {
  const pagination = findPaginationState(value);
  if (pagination.hasMore === true) {
    return {
      status: "partial",
      ...(pagination.received !== null ? { received: pagination.received } : {}),
      ...(pagination.total !== null ? { knownTotal: pagination.total } : {}),
      reason: "more_pages_available",
    };
  }
  if (
    pagination.total !== null &&
    pagination.received !== null &&
    pagination.total > pagination.received
  ) {
    return {
      status: "partial",
      received: pagination.received,
      knownTotal: pagination.total,
      reason: "response_contains_partial_collection",
    };
  }
  if (pagination.hasMore === false || !operationDeclaresPagination) {
    return {
      status: "complete",
      ...(pagination.received !== null ? { received: pagination.received } : {}),
      ...(pagination.total !== null ? { knownTotal: pagination.total } : {}),
    };
  }
  return {
    status: "unknown",
    ...(pagination.received !== null ? { received: pagination.received } : {}),
    ...(pagination.total !== null ? { knownTotal: pagination.total } : {}),
    reason: "pagination_completeness_not_declared",
  };
}

export function inspectOaResponse(value: unknown): {
  mode: "inspect";
  structure: StructureEntry[];
  availableActions: string[];
} {
  const structure: StructureEntry[] = [];
  collectStructure(value, "$", structure, 0);
  return {
    mode: "inspect",
    structure,
    availableActions: ["inspect", "find", "filter", "count", "group_count", "read"],
  };
}

export function runOaResponseAction(
  stored: StoredOaResponse,
  input: OaResponseActionInput,
): OaResponseActionResult {
  const action = stringValue(input.action)?.toLowerCase() ?? "";
  const responsePath = stringValue(input.responsePath) ?? "$";
  const resolved = resolveResponsePath(stored.data, responsePath);
  if (!resolved.ok) {
    return resolved;
  }

  if (action === "inspect") {
    return {
      ok: true,
      coverage: stored.coverage,
      data: inspectOaResponse(resolved.value),
    };
  }

  if (action === "read") {
    return readResponsePath(resolved.value, responsePath, stored.coverage, input);
  }

  if (!Array.isArray(resolved.value)) {
    return {
      ok: false,
      code: "response_path_not_array",
      message: `${responsePath} 不是数组，不能执行 ${action || "该"} 操作。`,
    };
  }

  const conditions = parseConditions(input.conditions);
  if (!conditions.ok) {
    return conditions;
  }
  const fields = parseFields(input.fields);
  if (!fields.ok) {
    return fields;
  }
  const matchingItems = resolved.value.filter((item) =>
    matchesConditionExpression(item, conditions.value),
  );

  if (action === "find" || action === "filter") {
    if (action === "find" && countLeafConditions(conditions.value) === 0) {
      return {
        ok: false,
        code: "response_conditions_required",
        message: "find 操作必须提供 conditions。",
      };
    }
    const limit = parseBoundedInteger(input.limit, DEFAULT_ACTION_RESULTS, 1, MAX_ACTION_RESULTS);
    const returnedItems = matchingItems.slice(0, limit);
    const items = returnedItems.map((item) => projectFields(item, fields.value));
    const matchedBy = returnedItems.map((item, itemIndex) => ({
      itemIndex,
      fields: matchedConditionFields(item, conditions.value),
    }));
    return {
      ok: true,
      coverage: stored.coverage,
      data: {
        action,
        path: responsePath,
        scanned: resolved.value.length,
        matched: matchingItems.length,
        returned: items.length,
        items,
        ...(countLeafConditions(conditions.value) > 0 ? { matchedBy } : {}),
      },
    };
  }

  if (action === "count") {
    return {
      ok: true,
      coverage: stored.coverage,
      data: {
        action,
        path: responsePath,
        scanned: resolved.value.length,
        count: matchingItems.length,
      },
    };
  }

  if (action === "group_count") {
    const groupBy = stringValue(input.groupBy);
    if (!groupBy) {
      return {
        ok: false,
        code: "response_group_by_required",
        message: "group_count 操作必须提供 groupBy。",
      };
    }
    const counts = new Map<string, { value: unknown; count: number }>();
    for (const item of matchingItems) {
      const groupedValues = readFieldValues(item, groupBy);
      const values = groupedValues.length > 0 ? groupedValues : [undefined];
      for (const value of values) {
        const key = stableValueKey(value);
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, { value: value ?? null, count: 1 });
        }
      }
    }
    const groups = [...counts.values()].sort(
      (left, right) => right.count - left.count || stableValueKey(left.value).localeCompare(stableValueKey(right.value)),
    );
    return {
      ok: true,
      coverage: stored.coverage,
      data: {
        action,
        path: responsePath,
        scanned: resolved.value.length,
        groups: groups.slice(0, MAX_ACTION_RESULTS),
        ...(groups.length > MAX_ACTION_RESULTS
          ? { totalGroups: groups.length, omittedGroups: groups.length - MAX_ACTION_RESULTS }
          : {}),
      },
    };
  }

  return {
    ok: false,
    code: "unsupported_response_action",
    message: "action 必须是 inspect、find、filter、count、group_count 或 read。",
  };
}

function readResponsePath(
  value: unknown,
  responsePath: string,
  coverage: OaResponseCoverage,
  input: OaResponseActionInput,
): OaResponseActionResult {
  const fields = parseFields(input.fields);
  if (!fields.ok) {
    return fields;
  }
  if (!Array.isArray(value)) {
    return {
      ok: true,
      coverage,
      data: {
        action: "read",
        path: responsePath,
        value: projectFields(value, fields.value),
      },
    };
  }
  const offset = parseBoundedInteger(input.offset, 0, 0, Math.max(value.length, 0));
  const limit = parseBoundedInteger(input.limit, DEFAULT_ACTION_RESULTS, 1, MAX_ACTION_RESULTS);
  const items = value
    .slice(offset, offset + limit)
    .map((item) => projectFields(item, fields.value));
  const nextOffset = offset + items.length < value.length ? offset + items.length : null;
  return {
    ok: true,
    coverage,
    data: {
      action: "read",
      path: responsePath,
      total: value.length,
      offset,
      returned: items.length,
      nextOffset,
      items,
    },
  };
}

function exceedsInlineBudget(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > PROGRESSIVE_DEPTH) {
    return true;
  }
  if (typeof value === "string") {
    return value.length > PROGRESSIVE_STRING_LENGTH;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return (
      value.length > PROGRESSIVE_ARRAY_ITEMS ||
      value.some((item) => exceedsInlineBudget(item, depth + 1, seen))
    );
  }
  const entries = Object.entries(value);
  return (
    entries.length > PROGRESSIVE_OBJECT_KEYS ||
    entries.some(([, item]) => exceedsInlineBudget(item, depth + 1, seen))
  );
}

function collectStructure(
  value: unknown,
  path: string,
  entries: StructureEntry[],
  depth: number,
): void {
  if (entries.length >= MAX_STRUCTURE_ENTRIES || depth > PROGRESSIVE_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    const itemTypes = [...new Set(value.map(valueType))].sort();
    const itemFields = new Set<string>();
    for (const item of value) {
      if (isRecord(item)) {
        for (const field of Object.keys(item)) {
          if (itemFields.size < MAX_STRUCTURE_FIELDS) {
            itemFields.add(field);
          }
        }
      }
    }
    entries.push({
      path,
      type: "array",
      length: value.length,
      itemTypes,
      ...(itemFields.size > 0 ? { itemFields: [...itemFields].sort() } : {}),
      ...(value.length > 0 ? { sample: sampleValue(value[0]) } : {}),
    });
    if (value.length > 0) {
      collectNestedStructure(value[0], `${path}[0]`, entries, depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    const fields = Object.keys(value);
    entries.push({
      path,
      type: "object",
      fields: fields.slice(0, MAX_STRUCTURE_FIELDS),
      fieldCount: fields.length,
    });
    for (const [key, item] of Object.entries(value)) {
      if (entries.length >= MAX_STRUCTURE_ENTRIES) {
        break;
      }
      const childPath = `${path}.${key}`;
      if (Array.isArray(item) || isRecord(item)) {
        collectStructure(item, childPath, entries, depth + 1);
      } else {
        entries.push({ path: childPath, type: valueType(item), sample: sampleValue(item) });
      }
    }
    return;
  }
  entries.push({ path, type: valueType(value), sample: sampleValue(value) });
}

function collectNestedStructure(
  value: unknown,
  path: string,
  entries: StructureEntry[],
  depth: number,
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) || isRecord(item)) {
      collectStructure(item, `${path}.${key}`, entries, depth + 1);
    }
  }
}

function sampleValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return "[nested]";
  }
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? [sampleValue(value[0], depth + 1)] : [];
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [key, sampleValue(item, depth + 1)]),
    );
  }
  return value;
}

function findPaginationState(value: unknown): {
  hasMore: boolean | null;
  total: number | null;
  received: number | null;
} {
  let hasMore: boolean | null = null;
  let total: number | null = null;
  let received: number | null = null;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 5 || item === null || typeof item !== "object") {
      return;
    }
    if (Array.isArray(item)) {
      received = Math.max(received ?? 0, item.length);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:has_?next|has_?more|more)$/i.test(key) && typeof child === "boolean") {
        hasMore = child;
      } else if (/^(?:next_?page|next_?cursor|next)$/i.test(key) && child != null && child !== false) {
        hasMore = true;
      } else if (/^(?:total|total_?count)$/i.test(key) && typeof child === "number") {
        total = child;
      }
      if (Array.isArray(child)) {
        received = Math.max(received ?? 0, child.length);
      } else if (child && typeof child === "object") {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return { hasMore, total, received };
}

function resolveResponsePath(
  root: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  if (path === "$" || path === "") {
    return { ok: true, value: root };
  }
  if (!path.startsWith("$.") || !/^\$(?:\.[^.[\]]+|\[\d+\])+$/u.test(path)) {
    return {
      ok: false,
      code: "invalid_response_path",
      message: "responsePath 仅支持 $.field、$.nested.field 和数组下标 [0]，字段名可包含中文。",
    };
  }
  const segments = [...path.matchAll(/\.([^.[]+)|\[(\d+)\]/gu)].map(
    (match) => match[1] ?? Number(match[2]),
  );
  let current = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return {
          ok: false,
          code: "response_path_not_found",
          message: `响应中不存在路径 ${path}。`,
        };
      }
      current = current[segment];
    } else {
      if (!isRecord(current) || !(segment in current)) {
        return {
          ok: false,
          code: "response_path_not_found",
          message: `响应中不存在路径 ${path}。`,
        };
      }
      current = current[segment];
    }
  }
  return { ok: true, value: current };
}

function parseConditions(
  value: unknown,
): { ok: true; value: ParsedConditionExpression } | { ok: false; code: string; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: { type: "all", conditions: [] } };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_response_conditions",
      message: "conditions 必须是 JSON object。",
    };
  }
  return parseConditionGroup(value, "all");
}

function parseConditionGroup(
  value: Record<string, unknown>,
  type: "all" | "any",
): { ok: true; value: ParsedConditionExpression } | { ok: false; code: string; message: string } {
  const conditions: ParsedConditionExpression[] = [];
  for (const [field, expected] of Object.entries(value)) {
    if (isConditionGroupKey(field)) {
      const groupType = conditionGroupType(field);
      const groupItems = parseConditionGroupItems(expected, groupType);
      if (!groupItems.ok) {
        return groupItems;
      }
      conditions.push(...groupItems.value);
      continue;
    }
    if (!field || field.length > 200) {
      return {
        ok: false,
        code: "invalid_response_conditions",
        message: "conditions 字段名无效。",
      };
    }
    const condition = parseCondition(field, expected);
    if (!condition.ok) {
      return condition;
    }
    conditions.push({ type: "condition", condition: condition.value });
  }
  return { ok: true, value: { type, conditions } };
}

function parseConditionGroupItems(
  value: unknown,
  type: "all" | "any",
): { ok: true; value: ParsedConditionExpression[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return {
      ok: false,
      code: "invalid_response_conditions",
      message: "$or/$and 条件必须是 1 到 20 项的 JSON object 数组。",
    };
  }
  const expressions: ParsedConditionExpression[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return {
        ok: false,
        code: "invalid_response_conditions",
        message: "$or/$and 的每一项都必须是 JSON object。",
      };
    }
    const parsed = parseConditionGroup(item, "all");
    if (!parsed.ok) {
      return parsed;
    }
    expressions.push(parsed.value);
  }
  return { ok: true, value: [{ type, conditions: expressions }] };
}

function parseCondition(
  field: string,
  expected: unknown,
): { ok: true; value: ParsedCondition } | { ok: false; code: string; message: string } {
  if (isRecord(expected) && typeof expected.operator === "string") {
    const operator = expected.operator.toLowerCase();
    if (!isConditionOperator(operator)) {
      return {
        ok: false,
        code: "invalid_response_condition_operator",
        message: `不支持 conditions.${field}.operator=${operator}。`,
      };
    }
    return { ok: true, value: { field, operator, ...(operator !== "exists" ? { value: expected.value } : {}) } };
  }
  return { ok: true, value: { field, operator: "eq", value: expected } };
}

function isConditionGroupKey(field: string): boolean {
  return /^(?:\$or|anyOf|\$and|allOf)$/i.test(field);
}

function conditionGroupType(field: string): "all" | "any" {
  return /^(?:\$or|anyOf)$/i.test(field) ? "any" : "all";
}

function parseFields(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; code: string; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((field) => typeof field !== "string" || !field.trim() || field.length > 200)
  ) {
    return {
      ok: false,
      code: "invalid_response_fields",
      message: "fields 必须是最多 20 项的非空字符串数组。",
    };
  }
  return { ok: true, value: value.map((field) => field.trim()) };
}

function matchesCondition(item: unknown, condition: ParsedCondition): boolean {
  const actualValues = readFieldValues(item, condition.field);
  if (condition.operator === "exists") {
    return actualValues.some((actual) => actual !== undefined && actual !== null);
  }
  if (condition.operator === "contains") {
    return actualValues.some((actual) => valueContains(actual, condition.value));
  }
  if (condition.operator === "in") {
    const expectedValues = Array.isArray(condition.value) ? condition.value : null;
    return expectedValues !== null && actualValues.some((actual) =>
      expectedValues.some((candidate) => valueMatches(actual, candidate)),
    );
  }
  return actualValues.some((actual) => valueMatches(actual, condition.value));
}

function matchesConditionExpression(
  item: unknown,
  expression: ParsedConditionExpression,
): boolean {
  if (expression.type === "condition") {
    return matchesCondition(item, expression.condition);
  }
  if (expression.type === "any") {
    return expression.conditions.some((condition) =>
      matchesConditionExpression(item, condition),
    );
  }
  return expression.conditions.every((condition) =>
    matchesConditionExpression(item, condition),
  );
}

function countLeafConditions(expression: ParsedConditionExpression): number {
  if (expression.type === "condition") {
    return 1;
  }
  return expression.conditions.reduce(
    (count, condition) => count + countLeafConditions(condition),
    0,
  );
}

function matchedConditionFields(
  item: unknown,
  expression: ParsedConditionExpression,
): string[] {
  if (expression.type === "condition") {
    return matchesCondition(item, expression.condition)
      ? [expression.condition.field]
      : [];
  }
  const fields = expression.conditions.flatMap((condition) =>
    matchedConditionFields(item, condition),
  );
  return [...new Set(fields)];
}

function projectFields(item: unknown, fields: string[]): unknown {
  if (fields.length === 0) {
    return item;
  }
  return Object.fromEntries(fields.map((field) => [field, readField(item, field) ?? null]));
}

function readField(value: unknown, field: string): unknown {
  const values = readFieldValues(value, field);
  if (values.length === 0) {
    return undefined;
  }
  return values.length === 1 ? values[0] : values;
}

function readFieldValues(value: unknown, field: string): unknown[] {
  const segments = field.split(".");
  return readFieldValuesAtPath(value, segments, 0);
}

function readFieldValuesAtPath(
  current: unknown,
  segments: string[],
  index: number,
): unknown[] {
  if (index >= segments.length) {
    return current === undefined ? [] : [current];
  }
  if (Array.isArray(current)) {
    return current.flatMap((item) => readFieldValuesAtPath(item, segments, index));
  }
  if (!isRecord(current)) {
    return [];
  }
  const segment = segments[index];
  if (!segment || !(segment in current)) {
    return [];
  }
  return readFieldValuesAtPath(current[segment], segments, index + 1);
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((candidate) => valueMatches(candidate, expected));
  }
  if (isRecord(actual)) {
    return Object.values(actual).some((candidate) => valueMatches(candidate, expected));
  }
  return valuesEqual(actual, expected);
}

function valueContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((candidate) => valueContains(candidate, expected));
  }
  if (isRecord(actual)) {
    return Object.values(actual).some((candidate) => valueContains(candidate, expected));
  }
  return normalizeComparable(actual).includes(normalizeComparable(expected));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return normalizeComparable(left) === normalizeComparable(right);
  }
  return Object.is(left, right);
}

function normalizeComparable(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s·•]/g, "")
    .toLocaleLowerCase("zh-CN");
}

function stableValueKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : fallback;
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function isConditionOperator(value: string): value is ConditionOperator {
  return value === "eq" || value === "contains" || value === "in" || value === "exists";
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
