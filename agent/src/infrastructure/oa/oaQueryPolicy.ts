import { randomUUID } from "node:crypto";
import type { StoredOaResponse } from "./oaResponseNavigator.js";

export type OaQueryMode = "single_step" | "multi_step" | "unknown";

export type OaQueryPolicy = {
  mode: OaQueryMode;
  exactPersonName: string | null;
};

export type OaIdentityMatch = {
  query: string;
  status: "matched" | "not_found" | "insufficient";
  scannedCandidates: number;
  matched: number;
  matchedBy?: Array<{
    itemIndex: number;
    fields: string[];
  }>;
};

type OaToolResultLike = {
  ok: boolean;
  coverage?: {
    status?: string;
  };
  warnings?: string[];
  data?: unknown;
  identityMatch?: OaIdentityMatch;
  error?: {
    code: string;
    message: string;
  };
};

type OaTurnState = {
  policy: OaQueryPolicy;
  callCount: number;
  requiresAdditionalCall: boolean;
  requestResults: Map<string, Promise<unknown>>;
  responses: Map<string, StoredOaResponse>;
};

const WRITE_PATTERN =
  /新增|创建|添加|增加|修改|更新|编辑|维护|配置|设置|补充|替换|清空|删除|移除|保存|提交|上传|导入|审批|通过|驳回|拒绝|重置|变更|写入|发布|归档|恢复|分配|调整/i;
const MULTI_STEP_PATTERN =
  /统计|汇总|分析|趋势|同比|环比|占比|排名|分布|平均|总计|对比|比较|综合|关联|跨(?:模块|系统|部门)|周报|日报|月报|列表|列出|全部|所有|批量|分页|下一页|上一页|第\s*\d+\s*页|导出|下载|分别|逐个|每个|各(?:个|部门|人员|项目)|以及|并且|同时|然后|再查|再看/i;
const PERSON_INFO_SUFFIX =
  "(?:个人)?(?:信息|资料|情况|联系方式|联系信息|邮箱|手机号|电话)";
const GENERIC_PERSON_TERMS = new Set([
  "个人",
  "人员",
  "用户",
  "员工",
  "同事",
  "成员",
  "姓名",
  "大家",
  "全部",
  "所有",
  "某人",
  "某个人",
  "这个人",
  "那个人",
  "他的",
  "她的",
  "他们",
  "项目",
  "部门",
  "团队",
  "公司",
  "系统",
  "业务",
  "工作",
  "任务",
  "审批",
  "考勤",
  "工时",
  "假期",
]);
const MAX_SINGLE_STEP_OA_CALLS = 3;
const turnStates = new Map<string, OaTurnState>();

export function resolveOaQueryPolicy(task: string): OaQueryPolicy {
  const normalized = normalizeTask(task);
  if (!normalized) {
    return { mode: "unknown", exactPersonName: null };
  }

  if (WRITE_PATTERN.test(normalized) || MULTI_STEP_PATTERN.test(normalized)) {
    return { mode: "multi_step", exactPersonName: null };
  }

  if (isExactSelfLookup(normalized)) {
    return { mode: "single_step", exactPersonName: null };
  }

  const exactPersonName = extractExactPersonName(normalized);
  if (exactPersonName) {
    return { mode: "single_step", exactPersonName };
  }

  return { mode: "unknown", exactPersonName: null };
}

export function beginOaTurn(sessionId: string, policy: OaQueryPolicy): void {
  turnStates.set(sessionId, {
    policy,
    callCount: 0,
    requiresAdditionalCall: true,
    requestResults: new Map(),
    responses: new Map(),
  });
}

export function finishOaTurn(sessionId: string): void {
  turnStates.delete(sessionId);
}

export function getActiveOaQueryPolicy(
  sessionId: string | null | undefined,
): OaQueryPolicy | null {
  return sessionId ? turnStates.get(sessionId)?.policy ?? null : null;
}

export function getCachedOaApiResult(
  sessionId: string | null | undefined,
  requestKey: string,
): Promise<unknown> | undefined {
  const state = sessionId ? turnStates.get(sessionId) : null;
  return state?.requestResults.get(requestKey);
}

export function cacheOaApiResult(
  sessionId: string | null | undefined,
  requestKey: string,
  result: Promise<unknown>,
): void {
  const state = sessionId ? turnStates.get(sessionId) : null;
  state?.requestResults.set(requestKey, result);
}

export function clearCachedOaApiResult(
  sessionId: string | null | undefined,
  requestKey: string,
): void {
  const state = sessionId ? turnStates.get(sessionId) : null;
  state?.requestResults.delete(requestKey);
}

export function storeOaResponse(
  sessionId: string | null | undefined,
  response: StoredOaResponse,
): string | null {
  const state = sessionId ? turnStates.get(sessionId) : null;
  if (!state) {
    return null;
  }
  const responseId = `oa_resp_${randomUUID()}`;
  state.responses.set(responseId, response);
  return responseId;
}

export function getStoredOaResponse(
  sessionId: string | null | undefined,
  responseId: string,
): StoredOaResponse | null {
  const state = sessionId ? turnStates.get(sessionId) : null;
  return state?.responses.get(responseId) ?? null;
}

export function reserveOaApiCall(sessionId: string | null | undefined): {
  allowed: boolean;
  mode: OaQueryMode | null;
} {
  const state = sessionId ? turnStates.get(sessionId) : null;
  if (!state) {
    return { allowed: true, mode: null };
  }

  if (state.policy.mode !== "single_step") {
    state.callCount += 1;
    return { allowed: true, mode: state.policy.mode };
  }

  if (
    state.callCount >= MAX_SINGLE_STEP_OA_CALLS ||
    (state.callCount >= 1 && !state.requiresAdditionalCall)
  ) {
    return { allowed: false, mode: state.policy.mode };
  }

  state.callCount += 1;
  return { allowed: true, mode: state.policy.mode };
}

export function recordOaApiCallResult(
  sessionId: string | null | undefined,
  result: OaToolResultLike,
): void {
  const state = sessionId ? turnStates.get(sessionId) : null;
  if (!state || state.policy.mode !== "single_step") {
    return;
  }

  if (state.policy.exactPersonName) {
    state.requiresAdditionalCall = exactIdentityLookupNeedsMore(result);
    return;
  }

  state.requiresAdditionalCall =
    requiresAdditionalOaCall(result) || containsIdentityOnlyRecord(result.data);
}

function exactIdentityLookupNeedsMore(result: OaToolResultLike): boolean {
  if (!result.ok) {
    return true;
  }

  if (result.identityMatch?.status === "matched") {
    return (
      requiresAdditionalOaCall(result) || containsIdentityOnlyRecord(result.data)
    );
  }
  if (result.identityMatch?.status === "not_found") {
    return true;
  }
  if (result.identityMatch?.status === "insufficient") {
    return true;
  }

  return (
    requiresAdditionalOaCall(result) || containsIdentityOnlyRecord(result.data)
  );
}

export function requiresAdditionalOaCall(result: OaToolResultLike): boolean {
  if (
    result.coverage?.status === "partial" ||
    result.coverage?.status === "unknown"
  ) {
    return true;
  }
  if (
    result.warnings?.some((warning) =>
      /截断|分页|继续查询|更多数据|超过\s*\d+\s*项/i.test(warning),
    )
  ) {
    return true;
  }

  if (
    result.error &&
    /missing.*(?:id|identifier|required)|required.*(?:id|identifier)|缺少.*(?:id|标识|编号|必填)|需要.*(?:id|标识|编号)/i.test(
      `${result.error.code} ${result.error.message}`,
    )
  ) {
    return true;
  }

  return containsIncompleteResult(result.data);
}

function normalizeTask(task: string): string {
  return task
    .trim()
    .replace(/^[“”"'\s]+|[“”"'\s]+$/g, "")
    .replace(
      /^(?:(?:请|麻烦|帮我|给我|能否|可以|我想|我要)\s*)?(?:查询一下|查看一下|查找一下|搜索一下|获取一下|了解一下|查一下|看一下|查询|查找|查看|搜索|获取|了解|看看|查下|看下|查|看)\s*/,
      "",
    )
    .trim();
}

function isExactSelfLookup(task: string): boolean {
  return new RegExp(
    `^(?:我|我的|本人|自己|当前用户|当前登录用户)(?:的)?${PERSON_INFO_SUFFIX}(?:是什么|有哪些)?[？?。.]?$`,
    "i",
  ).test(task);
}

function extractExactPersonName(task: string): string | null {
  const explicitIdentityMatch =
    task.match(/^谁是\s*(.+?)[？?。.]?$/iu) ??
    task.match(/^(.+?)\s*是谁[？?。.]?$/iu);
  const explicitIdentity = explicitIdentityMatch?.[1]?.trim() ?? "";
  if (isExactIdentityValue(explicitIdentity)) {
    return explicitIdentity;
  }

  const match =
    task.match(
      new RegExp(
        `^([\\p{Script=Han}·]{2,4}?)的${PERSON_INFO_SUFFIX}(?:是什么|有哪些)?[？?。.]?$`,
        "iu",
      ),
    ) ??
    task.match(
      new RegExp(
        `^([\\p{Script=Han}·]{2,4}?)${PERSON_INFO_SUFFIX}(?:是什么|有哪些)?[？?。.]?$`,
        "iu",
      ),
    ) ??
    task.match(
      new RegExp(
        `^(.+?)(?:的)?${PERSON_INFO_SUFFIX}(?:是什么|有哪些)?[？?。.]?$`,
        "iu",
      ),
    );
  const identity = match?.[1]?.trim() ?? "";
  return isExactIdentityValue(identity) ? identity : null;
}

function isExactIdentityValue(value: string): boolean {
  if (!value || GENERIC_PERSON_TERMS.has(value)) {
    return false;
  }
  if (/^[\p{Script=Han}·]{2,4}$/u.test(value)) {
    return true;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    return value.length <= 254;
  }
  return (
    value.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9._+@ -]*[A-Za-z0-9]$/u.test(value)
  );
}

function containsIncompleteResult(value: unknown, depth = 0): boolean {
  if (typeof value === "string") {
    return /缺少.*(?:id|标识|编号)|需要.*(?:id|标识|编号)|missing.*(?:id|identifier)/i.test(
      value,
    );
  }
  if (depth > 8 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsIncompleteResult(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (record.__truncated === true) {
    return true;
  }
  for (const [key, item] of Object.entries(record)) {
    if (/^(?:has_?next|has_?more|more)$/i.test(key) && item === true) {
      return true;
    }
    if (/^(?:next_?page|next_?cursor|next)$/i.test(key) && item != null && item !== false) {
      return true;
    }
  }

  const total = numericField(record, ["total", "total_count", "totalCount"]);
  const immediateArrays = Object.values(record).filter(Array.isArray);
  if (
    total !== null &&
    immediateArrays.some((items) => total > items.length)
  ) {
    return true;
  }

  return Object.values(record).some((item) =>
    containsIncompleteResult(item, depth + 1),
  );
}

function numericField(
  record: Record<string, unknown>,
  names: string[],
): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function containsIdentityOnlyRecord(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsIdentityOnlyRecord(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const populatedEntries = Object.entries(record).filter(
    ([, item]) => item !== null && item !== undefined && item !== "",
  );
  const hasIdentifier = populatedEntries.some(([key]) =>
    /^(?:id|uuid|user_?id|employee_?id|staff_?id|member_?id)$/i.test(key),
  );
  const businessEntries = populatedEntries.filter(
    ([key]) =>
      !/^(?:id|uuid|user_?id|employee_?id|staff_?id|member_?id|full_?name|real_?name|display_?name|user_?name|employee_?name|chinese_?name|name|code|message|success)$/i.test(
        key,
      ),
  );
  if (hasIdentifier && businessEntries.length === 0) {
    return true;
  }

  return Object.values(record).some((item) =>
    containsIdentityOnlyRecord(item, depth + 1),
  );
}
