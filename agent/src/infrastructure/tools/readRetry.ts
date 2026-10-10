import { setTimeout as delay } from 'node:timers/promises';

const transientNetworkCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);
const transientHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);

export function transportErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 8) return;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return 'cause' in error && error.cause !== error ? transportErrorCode(error.cause, depth + 1) : undefined;
}

export function isTransientNetworkError(error: unknown): boolean {
  return transientNetworkCodes.has(transportErrorCode(error) ?? '');
}

export const isTransientHttpStatus = (status: number) => transientHttpStatuses.has(status);

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/** One retry for safe reads, sharing the original deadline. Ordinary successes never wait. */
export async function withReadRetry<T>(
  operation: (remainingMs: number) => Promise<T>,
  options: {
    readOnly: boolean;
    timeoutMs: number;
    isRetryableError?: (error: unknown) => boolean;
    retryDelay?: (result: T) => number | undefined;
    onRetry?: () => void;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<unknown>;
  },
): Promise<{ value: T; attempts: number }> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? delay;
  const deadline = now() + options.timeoutMs;
  for (let attempt = 1; ; attempt++) {
    let value: T;
    let retryDelay: number | undefined;
    let error: unknown;
    let failed = false;
    try {
      value = await operation(Math.max(1, Math.ceil(deadline - now())));
      retryDelay = options.retryDelay?.(value);
    } catch (caught) {
      error = caught;
      failed = true;
      if ((options.isRetryableError ?? isTransientNetworkError)(caught)) retryDelay = 100;
    }
    // Never turn a timeout into another full timeout, or wait out a long Retry-After in chat.
    if (!options.readOnly || attempt >= 2 || retryDelay === undefined ||
        retryDelay > 1000 || deadline - now() < retryDelay + 250) {
      if (failed) throw error;
      return { value: value!, attempts: attempt };
    }
    await sleep(retryDelay);
    if (deadline - now() < 250) {
      if (failed) throw error;
      return { value: value!, attempts: attempt };
    }
    options.onRetry?.();
  }
}

/** Consume the body within the same abort budget, including on the retry. */
export async function fetchWithReadRetry(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  readOnly: boolean,
  timeoutMs: number,
): Promise<{ response: Response; text: string; attempts: number }> {
  let attempts = 1;
  try {
    const result = await withReadRetry(async remainingMs => {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(remainingMs) });
      return { response, text: await response.text() };
    }, {
      readOnly, timeoutMs, onRetry: () => { attempts++; },
      retryDelay: ({ response }) => isTransientHttpStatus(response.status)
        ? retryAfterMilliseconds(response.headers.get('retry-after')) ?? 100 : undefined,
    });
    return { ...result.value, attempts: result.attempts };
  } catch (cause) {
    const error = new Error('受控请求未成功', { cause });
    error.name = cause instanceof Error ? cause.name : 'Error';
    throw Object.assign(error, { attempts });
  }
}
