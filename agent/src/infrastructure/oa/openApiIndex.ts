import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const INDEX_VERSION = 2;
const INDEX_FILE_NAME = "openapi-index.json";
const OPENAPI_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_RESPONSE_FIELDS = 32;
const MAX_RESPONSE_DEPTH = 4;

type JsonRecord = Record<string, unknown>;

export type OpenApiPermissionLevel = "public" | "user" | "admin" | "unknown";

export type OpenApiIndexParameter = {
  name: string;
  in: string;
  required: boolean;
  type: string | null;
};

export type OpenApiOperationIndexEntry = {
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  tags: string[];
  permissionLevel: OpenApiPermissionLevel;
  parameters: OpenApiIndexParameter[];
  requestBodyFields: string[];
  mainResponseFields: string[];
};

export type OpenApiOperationIndex = {
  version: typeof INDEX_VERSION;
  documentHash: string;
  generatedAt: string;
  operations: OpenApiOperationIndexEntry[];
};

const resolvedIndexCache = new Map<string, Promise<OpenApiOperationIndex>>();

export function buildOpenApiIndex(document: unknown): OpenApiOperationIndex {
  const documentHash = hashOpenApiDocument(document);
  const root = toRecord(document) ?? {};
  const paths = toRecord(root.paths);
  const operations: OpenApiOperationIndexEntry[] = [];

  for (const [operationPath, rawPathItem] of Object.entries(paths ?? {})) {
    const pathItem = toRecord(rawPathItem);
    if (!pathItem) {
      continue;
    }

    for (const method of OPENAPI_METHODS) {
      const operation = toRecord(pathItem[method]);
      const operationId = stringValue(operation?.operationId);
      if (!operation || !operationId) {
        continue;
      }

      const summary = stringValue(operation.summary);
      const tags = stringArray(operation.tags);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: operationPath,
        summary,
        tags,
        permissionLevel: inferPermissionLevel(
          operationPath,
          operationId,
          summary,
          tags,
          operation,
        ),
        parameters: extractParameters(root, pathItem, operation),
        requestBodyFields: extractRequestBodyFields(root, operation),
        mainResponseFields: extractMainResponseFields(root, operation),
      });
    }
  }

  return {
    version: INDEX_VERSION,
    documentHash,
    generatedAt: new Date().toISOString(),
    operations: operations.sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    ),
  };
}

export async function resolveOpenApiIndex(
  projectRoot: string,
  document: unknown,
): Promise<OpenApiOperationIndex> {
  const documentHash = hashOpenApiDocument(document);
  const cachePath = path.join(projectRoot, ".context", INDEX_FILE_NAME);
  const cacheKey = `${cachePath}:${documentHash}`;
  const existing = resolvedIndexCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = loadOrCreateIndex(cachePath, document, documentHash).catch(
    (error) => {
      resolvedIndexCache.delete(cacheKey);
      throw error;
    },
  );
  resolvedIndexCache.set(cacheKey, pending);
  return pending;
}

export function selectOpenApiCandidates(
  index: OpenApiOperationIndex,
  task: string,
  requestedLimit = 5,
): OpenApiOperationIndexEntry[] {
  const limit = Math.min(5, Math.max(3, Math.trunc(requestedLimit) || 5));
  const terms = buildSearchTerms(task);
  const adminIntent = /管理员|管理后台|后台管理|权限管理|全员管理/i.test(task);
  const writeIntent =
    /新增|创建|添加|增加|修改|更新|编辑|维护|配置|设置|补充|替换|清空|删除|移除|保存|提交|上传|导入|审批|通过|驳回|拒绝|重置|变更|写入|发布|归档|恢复|分配|调整/i.test(
      task,
    );

  return index.operations
    .map((operation) => ({
      operation,
      score: scoreOperation(
        operation,
        terms,
        adminIntent,
        writeIntent,
        task.toLowerCase(),
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.operation.operationId.localeCompare(right.operation.operationId),
    )
    .slice(0, Math.min(limit, index.operations.length))
    .map(({ operation }) => operation);
}

async function loadOrCreateIndex(
  cachePath: string,
  document: unknown,
  documentHash: string,
): Promise<OpenApiOperationIndex> {
  const cached = await readCachedIndex(cachePath);
  if (cached?.documentHash === documentHash) {
    return cached;
  }

  const index = buildOpenApiIndex(document);
  await persistIndex(cachePath, index);
  return index;
}

async function readCachedIndex(
  cachePath: string,
): Promise<OpenApiOperationIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    return isOpenApiOperationIndex(parsed) ? parsed : null;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function persistIndex(
  cachePath: string,
  index: OpenApiOperationIndex,
): Promise<void> {
  const directory = path.dirname(cachePath);
  const temporaryPath = path.join(
    directory,
    `.${INDEX_FILE_NAME}-${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function extractParameters(
  document: JsonRecord,
  pathItem: JsonRecord,
  operation: JsonRecord,
): OpenApiIndexParameter[] {
  const parameters = [
    ...unknownArray(pathItem.parameters),
    ...unknownArray(operation.parameters),
  ];
  const result = new Map<string, OpenApiIndexParameter>();

  for (const rawParameter of parameters) {
    const parameter = resolveReference(document, rawParameter);
    const name = stringValue(parameter?.name);
    const location = stringValue(parameter?.in);
    if (!parameter || !name || !location) {
      continue;
    }
    const schema = resolveReference(document, parameter.schema);
    result.set(`${location}:${name}`, {
      name,
      in: location,
      required: parameter.required === true,
      type: inferSchemaType(schema),
    });
  }

  return [...result.values()];
}

function extractMainResponseFields(
  document: JsonRecord,
  operation: JsonRecord,
): string[] {
  const responses = toRecord(operation.responses);
  if (!responses) {
    return [];
  }
  const responseKey =
    Object.keys(responses)
      .filter((key) => /^2\d\d$/.test(key))
      .sort()[0] ??
    ("default" in responses ? "default" : Object.keys(responses)[0]);
  if (!responseKey) {
    return [];
  }

  const response = resolveReference(document, responses[responseKey]);
  const content = toRecord(response?.content);
  const mediaType = content
    ? (toRecord(content["application/json"]) ??
      toRecord(Object.values(content)[0]))
    : null;
  const fields: string[] = [];
  collectSchemaFields(document, mediaType?.schema, "", 0, fields, new Set());
  return fields;
}

function extractRequestBodyFields(
  document: JsonRecord,
  operation: JsonRecord,
): string[] {
  const requestBody = resolveReference(document, operation.requestBody);
  const content = toRecord(requestBody?.content);
  const mediaType = content
    ? (toRecord(content["application/json"]) ??
      toRecord(Object.values(content)[0]))
    : null;
  const fields: string[] = [];
  collectSchemaFields(document, mediaType?.schema, "", 0, fields, new Set());
  return fields;
}

function collectSchemaFields(
  document: JsonRecord,
  rawSchema: unknown,
  prefix: string,
  depth: number,
  fields: string[],
  seenReferences: Set<string>,
): void {
  if (fields.length >= MAX_RESPONSE_FIELDS || depth > MAX_RESPONSE_DEPTH) {
    return;
  }
  const schema = toRecord(rawSchema);
  if (!schema) {
    return;
  }

  const reference = stringValue(schema.$ref);
  if (reference) {
    if (seenReferences.has(reference)) {
      return;
    }
    const nextReferences = new Set(seenReferences);
    nextReferences.add(reference);
    collectSchemaFields(
      document,
      resolveJsonPointer(document, reference),
      prefix,
      depth,
      fields,
      nextReferences,
    );
    return;
  }

  for (const compositionKey of ["allOf", "oneOf", "anyOf"] as const) {
    for (const composedSchema of unknownArray(schema[compositionKey])) {
      collectSchemaFields(
        document,
        composedSchema,
        prefix,
        depth,
        fields,
        new Set(seenReferences),
      );
    }
  }

  if (schema.type === "array" || schema.items) {
    collectSchemaFields(
      document,
      schema.items,
      `${prefix}[]`,
      depth + 1,
      fields,
      seenReferences,
    );
    return;
  }

  const properties = toRecord(schema.properties);
  for (const [name, propertySchema] of Object.entries(properties ?? {})) {
    if (fields.length >= MAX_RESPONSE_FIELDS) {
      break;
    }
    const fieldPath = prefix ? `${prefix}.${name}` : name;
    if (!fields.includes(fieldPath)) {
      fields.push(fieldPath);
    }
    collectSchemaFields(
      document,
      propertySchema,
      fieldPath,
      depth + 1,
      fields,
      new Set(seenReferences),
    );
  }
}

function inferPermissionLevel(
  operationPath: string,
  operationId: string,
  summary: string | null,
  tags: string[],
  operation: JsonRecord,
): OpenApiPermissionLevel {
  const descriptor = `${operationPath} ${operationId} ${summary ?? ""} ${tags.join(" ")}`;
  if (/^\/admin(?:\/|$)/i.test(operationPath) || /\badmin(?:istrator)?\b|后台管理|管理员/i.test(descriptor)) {
    return "admin";
  }
  if (Array.isArray(operation.security) && operation.security.length === 0) {
    return "public";
  }
  if (
    /^\/(?:user|self|me)(?:\/|$)/i.test(operationPath) ||
    tags.some((tag) => /^(?:user|self|profile)$/i.test(tag))
  ) {
    return "user";
  }
  return "unknown";
}

function scoreOperation(
  operation: OpenApiOperationIndexEntry,
  terms: Set<string>,
  adminIntent: boolean,
  writeIntent: boolean,
  normalizedTask: string,
): number {
  const primary = `${operation.operationId} ${operation.path}`.toLowerCase();
  const secondary = `${operation.summary ?? ""} ${operation.tags.join(" ")}`.toLowerCase();
  const details = `${operation.parameters.map((parameter) => parameter.name).join(" ")} ${operation.requestBodyFields.join(" ")} ${operation.mainResponseFields.join(" ")}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    score += Math.min(countOccurrences(primary, term), 3) * 8;
    score += Math.min(countOccurrences(secondary, term), 2) * 5;
    score += Math.min(countOccurrences(details, term), 2) * 2;
  }

  score += scoreBusinessResource(operation, normalizedTask, writeIntent);
  score += scoreFieldCoverage(operation, normalizedTask);

  if (adminIntent) {
    score += operation.permissionLevel === "admin" ? 32 : 0;
  } else if (operation.permissionLevel === "admin") {
    score -= 16;
  } else if (operation.permissionLevel === "user") {
    score += 6;
  } else if (operation.permissionLevel === "public") {
    score += 4;
  }

  if (writeIntent) {
    score += operation.method === "GET" ? 0 : 5;
  } else if (operation.method === "GET") {
    score += 2;
  } else {
    score -= 6;
  }
  return score;
}

function scoreBusinessResource(
  operation: OpenApiOperationIndexEntry,
  task: string,
  writeIntent: boolean,
): number {
  let score = 0;
  if (isCompanyProjectInventoryIntent(task)) {
    if (/^\/projects\/list-by-project$/i.test(operation.path)) {
      score += 96;
    }
  }
  if (writeIntent && isCompanyProjectInventoryIntent(task)) {
    const projectCreationIntent =
      /(?:新增|创建)(?:一个|新的|新)?\s*项目/i.test(task);
    if (/^\/projects\/project$/i.test(operation.path)) {
      if (projectCreationIntent && operation.method === "POST") {
        score += 140;
      } else if (!projectCreationIntent && operation.method === "PUT") {
        score += 140;
      }
    }
    if (/github-commit-(?:summary|summaries)/i.test(operation.path)) {
      score -= 80;
    }
  }
  if (/个人信息|用户信息|员工信息|人员信息|同事|姓名|邮箱/.test(task)) {
    if (/^\/user\/user-list$/i.test(operation.path)) {
      score += 18;
    }
    if (/category|skills?/i.test(`${operation.path} ${operation.operationId}`)) {
      score -= 10;
    }
  }
  if (hasNamedPersonLookupIntent(task)) {
    if (/^\/user\/user-list$/i.test(operation.path)) {
      score += 42;
    } else if (/^\/user\/user$/i.test(operation.path)) {
      score += 18;
    }
    if (/技能|能力|擅长|专长|技术栈/i.test(task)) {
      if (/^\/user\/user-skill-list$/i.test(operation.path)) {
        score += 34;
      } else if (/^\/user\/user-skill$/i.test(operation.path)) {
        score += 20;
      } else if (/^\/user\/skills$/i.test(operation.path)) {
        score -= 22;
      }
    }
    if (/^\/user\/(?:skills|groups|image-list|user-category-list)$/i.test(operation.path)) {
      score -= 18;
    }
  }
  if (/周报/.test(task)) {
    if (/^\/weekly-report\/(?:report|report-list)$/i.test(operation.path)) {
      score += 16;
    }
    if (
      /\/weekly-report\/days|holiday/i.test(operation.path) &&
      !/日期|工作日|节假日|假期/.test(task)
    ) {
      score -= 14;
    }
    if (/export/i.test(operation.path) && !/导出|下载/.test(task)) {
      score -= 10;
    }
  }
  return score;
}

function scoreFieldCoverage(
  operation: OpenApiOperationIndexEntry,
  task: string,
): number {
  const requirements = inferFieldRequirements(task);
  if (requirements.length === 0) {
    return 0;
  }

  const fieldNames = buildOperationFieldNames(operation);
  return requirements.reduce((score, requirement) => {
    const matched = requirement.fields.some((field) => fieldNames.has(field));
    return score + (matched ? requirement.weight : -requirement.missingPenalty);
  }, 0);
}

type FieldRequirement = {
  fields: string[];
  weight: number;
  missingPenalty: number;
};

function inferFieldRequirements(task: string): FieldRequirement[] {
  const requirements: FieldRequirement[] = [];
  const personIntent = hasPersonLookupIntent(task);
  const skillIntent = /技能|能力|擅长|专长|技术栈/i.test(task);

  if (personIntent) {
    requirements.push(
      {
        fields: ["user_id", "id", "employee_id", "staff_id", "member_id"],
        weight: 18,
        missingPenalty: 4,
      },
      {
        fields: [
          "full_name",
          "real_name",
          "display_name",
          "username",
          "wx_name",
          "name",
        ],
        weight: 30,
        missingPenalty: 10,
      },
    );
  }

  if (personIntent && /信息|资料|情况|是谁|部门|职位|岗位|mbti|mbit|联系方式|邮箱|微信|技术栈/i.test(task)) {
    requirements.push(
      {
        fields: ["department", "employee_title", "title", "position"],
        weight: 12,
        missingPenalty: 2,
      },
      {
        fields: ["email", "wx_name", "wechat", "phone", "mobile"],
        weight: 8,
        missingPenalty: 1,
      },
      {
        fields: ["mbit", "mbti", "tech_stack", "intro"],
        weight: 8,
        missingPenalty: 1,
      },
    );
  }

  if (skillIntent) {
    requirements.push({
      fields: ["skills", "skill_name", "skill_id", "description"],
      weight: 24,
      missingPenalty: 2,
    });
    if (personIntent) {
      requirements.push({
        fields: ["user_id", "employee_id", "staff_id", "member_id"],
        weight: 16,
        missingPenalty: 6,
      });
    }
  }

  return requirements;
}

function hasPersonLookupIntent(task: string): boolean {
  if (/个人信息|用户信息|员工信息|人员信息|同事|姓名|邮箱|联系方式|联系信息|手机号|电话|微信|mbti|mbit/i.test(task)) {
    return true;
  }
  if (/项目|仓库|周报|日报|月报|考勤|工时|审批|假期|请假|报表|统计|趋势/i.test(task)) {
    return false;
  }
  return hasNamedPersonLookupIntent(task);
}

function hasNamedPersonLookupIntent(task: string): boolean {
  return /[\p{Script=Han}·]{2,6}(?:的)?(?:信息|资料|情况|是谁|技能|能力|擅长|专长|技术栈)/u.test(
    task,
  );
}

function buildOperationFieldNames(
  operation: OpenApiOperationIndexEntry,
): Set<string> {
  const fields = [
    ...operation.parameters.map((parameter) => parameter.name),
    ...operation.requestBodyFields,
    ...operation.mainResponseFields,
    ...inferOperationFieldHints(operation),
  ];
  return new Set(fields.flatMap(normalizeFieldPath));
}

function inferOperationFieldHints(
  operation: OpenApiOperationIndexEntry,
): string[] {
  const descriptor = `${operation.path} ${operation.operationId} ${operation.summary ?? ""}`.toLowerCase();

  if (/^\/user\/user-list$/i.test(operation.path)) {
    return [
      "data[].user_id",
      "data[].username",
      "data[].full_name",
      "data[].wx_name",
      "data[].email",
      "data[].department",
      "data[].employee_title",
      "data[].employee_type",
      "data[].employee_status",
      "data[].intro",
      "data[].mbit",
      "data[].tech_stack",
    ];
  }
  if (/^\/user\/user$/i.test(operation.path)) {
    return [
      "data.user_id",
      "data.username",
      "data.full_name",
      "data.wx_name",
      "data.email",
      "data.department",
      "data.employee_title",
      "data.employee_type",
      "data.employee_status",
      "data.intro",
      "data.mbit",
      "data.tech_stack",
    ];
  }
  if (/^\/user\/user-skill-list$/i.test(operation.path)) {
    return [
      "data[].user_id",
      "data[].skills",
      "data[].skills[].skill_id",
      "data[].skills[].skill_name",
      "data[].skills[].description",
    ];
  }
  if (/^\/user\/user-skill$/i.test(operation.path)) {
    return [
      "data.user_id",
      "data.user_skill_id",
      "data.skill_id",
      "data.skill_name",
      "data.description",
    ];
  }
  if (/^\/user\/skills$/i.test(operation.path)) {
    return ["data[].skill_id", "data[].skill_name", "data[].description"];
  }
  if (/^\/user\/user-intro$/i.test(operation.path)) {
    return ["data[].user_id", "data[].content", "data[].intro"];
  }
  if (/^\/user\/user-category-list$/i.test(operation.path)) {
    return ["data[].category", "data[].user_id_list"];
  }
  if (/user.*(?:list|info|profile)|employee|staff|member/.test(descriptor)) {
    return ["user_id", "full_name", "username", "email"];
  }
  return [];
}

function normalizeFieldPath(fieldPath: string): string[] {
  const pathSegments = fieldPath
    .replace(/\[\]/g, "")
    .split(/[.[\]/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  const lastSegment = pathSegments.at(-1);
  return lastSegment ? [fieldPath.toLowerCase(), lastSegment] : [];
}

function isCompanyProjectInventoryIntent(task: string): boolean {
  const projectInventoryIntent =
    /项目列表|(?:当前)?公司.{0,12}(?:有哪些|有什么|所有|全部).{0,8}项目|(?:哪些|有哪些|所有|全部|列出).{0,12}项目/i.test(
      task,
    );
  const repositoryDiscoveryIntent =
    !/提交|commit|摘要|summary/i.test(task) &&
    /项目.{0,20}(?:github|仓库)|(?:github|仓库).{0,20}项目/i.test(task);
  return projectInventoryIntent || repositoryDiscoveryIntent;
}

function buildSearchTerms(task: string): Set<string> {
  const normalized = task.toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_/-]{2,}/g) ?? []);
  const aliases: Array<{ pattern: RegExp; terms: string[] }> = [
    {
      pattern: /个人信息|用户信息|员工信息|人员信息|同事|用户|员工|人员|姓名|邮箱/,
      terms: [
        "user",
        "employee",
        "staff",
        "member",
        "person",
        "profile",
        "info",
        "directory",
        "full_name",
        "email",
      ],
    },
    {
      pattern: /周报|日报|月报/,
      terms: ["weekly", "report", "daily", "monthly"],
    },
    {
      pattern: /项目|进度|仓库/,
      terms: ["project", "progress", "repository"],
    },
    {
      pattern: /请假|休假|假期|调休/,
      terms: ["leave", "vacation", "holiday"],
    },
    {
      pattern: /考勤|工时|打卡/,
      terms: ["attendance", "worktime", "timesheet"],
    },
    {
      pattern: /审批|申请|流程/,
      terms: ["approval", "application", "workflow"],
    },
    {
      pattern: /统计|汇总|趋势|报表|分析/,
      terms: ["stats", "statistics", "summary", "trend", "analytics"],
    },
  ];
  for (const alias of aliases) {
    if (alias.pattern.test(normalized)) {
      alias.terms.forEach((term) => terms.add(term));
    }
  }
  return terms;
}

function hashOpenApiDocument(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function countOccurrences(value: string, term: string): number {
  if (!term) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(term, offset)) >= 0) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function resolveReference(document: JsonRecord, value: unknown): JsonRecord | null {
  const record = toRecord(value);
  const reference = stringValue(record?.$ref);
  return reference ? toRecord(resolveJsonPointer(document, reference)) : record;
}

function resolveJsonPointer(document: JsonRecord, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    return null;
  }
  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, segment) => toRecord(current)?.[segment], document);
}

function inferSchemaType(schema: JsonRecord | null): string | null {
  const explicit = stringValue(schema?.type);
  if (explicit) {
    return explicit;
  }
  const reference = stringValue(schema?.$ref);
  return reference?.split("/").at(-1) ?? null;
}

function isOpenApiOperationIndex(value: unknown): value is OpenApiOperationIndex {
  const index = toRecord(value);
  return Boolean(
    index &&
      index.version === INDEX_VERSION &&
      typeof index.documentHash === "string" &&
      typeof index.generatedAt === "string" &&
      Array.isArray(index.operations),
  );
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
