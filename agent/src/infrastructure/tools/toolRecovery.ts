import { createHash } from 'node:crypto';
import { isTransientHttpStatus, isTransientNetworkError, retryAfterMilliseconds, transportErrorCode } from './readRetry.js';

export type ToolRecovery = {
  category: 'parameters' | 'authentication' | 'permission' | 'confirmation' | 'transient' | 'configuration' | 'execution';
  action: 'correct_parameters' | 'refresh_metadata' | 'authenticate' | 'wait_for_confirmation' | 'stop_for_turn';
  retryable: boolean;
  instruction: string;
  retryAfterSeconds?: number;
};
export type ToolError = {
  code: string;
  message: string;
  details?: unknown;
  recovery?: ToolRecovery;
};
type ToolResult = { ok: boolean; status?: number; error?: { code: string; message: string } };
type Failure = { ok: false; status?: number; error: ToolError };
const failedRequests = new Map<string, Map<string, Failure>>();

export const beginToolRecoveryTurn = (sessionId: string) => failedRequests.set(sessionId, new Map());
export const finishToolRecoveryTurn = (sessionId: string) => { failedRequests.delete(sessionId); };

export function recoveryForError(code: string, status?: number): ToolRecovery {
  if (code === 'confirmation_required') return {
    category: 'confirmation', action: 'wait_for_confirmation', retryable: false,
    instruction: '操作尚未执行。生成具体操作的确认卡片后结束本轮，等待用户确认；不要自行补 confirmed=true 或重复请求。',
  };
  if (status === 401 || /(?:user|session|identity|token)_required$/.test(code)) return {
    category: 'authentication', action: 'authenticate', retryable: false,
    instruction: '当前登录身份不可用。停止依赖该身份的操作，请用户重新登录；不要猜测身份、读取凭据或换接口绕过。',
  };
  if (status === 403 || /forbidden|not_authorized|permission_required|controlled_headers_not_allowed/.test(code)) return {
    category: 'permission', action: 'stop_for_turn', retryable: false,
    instruction: '停止这一受限操作并说明权限限制；不得更换身份、删除权限条件或换工具绕过。',
  };
  if (code === 'metadata_version_changed') return {
    category: 'configuration', action: 'refresh_metadata', retryable: false,
    instruction: '只重新读取所需实体的当前定义和版本，再更新查询；保持原业务对象、筛选和期间。',
  };
  if (isTransientHttpStatus(status ?? 0) || code === 'network_temporarily_unavailable' || code === 'database_temporarily_unavailable' || code === 'request_timeout') return {
    category: 'transient', action: 'stop_for_turn', retryable: true,
    instruction: '工具已按原时间预算处理可安全重试的读取。本轮不要再次发送相同请求或 sleep 轮询；保留查询条件，说明已有结果与缺口。写操作结果不确定时不得自动重发。',
  };
  if (status === 400 || status === 422 || /^(?:invalid_|missing_|operation_mismatch$|query_rejected$|ambiguous_operation$)/.test(code)) return {
    category: 'parameters', action: 'correct_parameters', retryable: false,
    instruction: '按错误位置及当前接口定义修正参数；保持用户要求的对象、筛选和期间，不猜测业务值。同一请求重复失败时停止，不扫描源码或反复试错。',
  };
  if (/not_configured|metadata_|unsupported_|profile_unavailable|identity_unmappable/.test(code)) return {
    category: 'configuration', action: 'stop_for_turn', retryable: false,
    instruction: '所需能力或定义当前不可用。说明具体缺口，本轮停止相关调用；不要安装依赖、轮询或改走其他接口绕过。',
  };
  return {
    category: 'execution', action: 'stop_for_turn', retryable: false,
    instruction: '请求未成功。保留业务条件并说明已有结果与缺口；不要对相同请求反复重试。写操作结果不确定时先核验，不能直接重发。',
  };
}

export function withToolRecovery<T extends ToolResult>(result: T): T {
  if (result.ok) return result;
  const error = result.error ?? { code: 'upstream_request_failed', message: `上游请求未成功${result.status ? `（HTTP ${result.status}）` : ''}。` };
  const existing = 'recovery' in error && error.recovery && typeof error.recovery === 'object' ? error.recovery : {};
  return { ...result, error: { ...error, recovery: { ...recoveryForError(error.code, result.status), ...existing } } };
}

export function toolRequestFailure(error: unknown): Failure {
  const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
  const code = timeout ? 'request_timeout' : isTransientNetworkError(error) ? 'network_temporarily_unavailable' : 'tool_request_failed';
  const reason = transportErrorCode(error);
  const attempts = error && typeof error === 'object' && 'attempts' in error ? error.attempts : undefined;
  return withToolRecovery({ ok: false, error: {
    code, message: timeout ? '受控工具请求超时。' : '受控工具请求未成功。',
    ...(reason ? { details: { reason } } : {}),
  }, ...(attempts === 2 ? { execution: { attempts, recovered: false } } : {}) });
}

export function httpToolFailure(response: Response): Failure {
  const recovery = recoveryForError('upstream_request_failed', response.status);
  const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'));
  return { ok: false, status: response.status, error: {
    code: 'upstream_request_failed', message: `上游请求未成功（HTTP ${response.status}）。`,
    recovery: { ...recovery, ...(retryAfter === undefined ? {} : { retryAfterSeconds: Math.ceil(retryAfter / 1000) }) },
  } };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]),
  );
  return value;
}

/** Only remember failures within the active turn; successful reads are never cached here. */
export async function runControlledTool<T extends ToolResult>(
  tool: string, sessionId: unknown, input: unknown, execute: () => Promise<T>,
): Promise<T> {
  const failures = typeof sessionId === 'string' ? failedRequests.get(sessionId) : undefined;
  const key = failures ? createHash('sha256').update(tool).update(JSON.stringify(canonicalValue(input))).digest('hex') : '';
  const previous = failures?.get(key);
  if (previous) return { ...previous, error: { ...previous.error, recovery: {
    ...previous.error.recovery!, action: 'stop_for_turn', retryable: false,
    instruction: '本轮相同参数的请求已失败，已阻止重复执行。停止这一请求；需要修正参数时依据原错误调整，其他不依赖此结果的操作可继续。',
  } } } as unknown as T;
  let result: T;
  try { result = withToolRecovery(await execute()); }
  catch (error) { result = toolRequestFailure(error) as T; }
  if (!result.ok && result.error?.code !== 'confirmation_required' && failures && failures.size < 128) {
    failures.set(key, { ok: false, ...(result.status === undefined ? {} : { status: result.status }), error: result.error! as ToolError });
  }
  return result;
}
