import { setTimeout as delay } from "node:timers/promises";

/** Includes the initial attempt. Never retries the enclosing automation run. */
export type SummaryRetryPolicy = { maxAttempts: number; intervalMs: number };
export function summaryRetryPolicy(value?: SummaryRetryPolicy): SummaryRetryPolicy {
  return { maxAttempts: Math.min(10, Math.max(1, Math.trunc(value?.maxAttempts ?? 3))), intervalMs: Math.max(0, value?.intervalMs ?? 1000) };
}
export async function waitForSummaryRetry(policy: SummaryRetryPolicy, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await delay(policy.intervalMs, undefined, { signal });
}

/** Permanent prerequisites and authorization errors cannot be fixed by another model call. */
export function isRetryableSummaryError(error: unknown): boolean {
  const item = error as { status?: number; errorCode?: string; code?: string; name?: string; message?: string } | null;
  const message = [item?.errorCode, item?.code, item?.name, item?.message].filter(Boolean).join(" ");
  if ([400, 401, 403, 404, 422].includes(item?.status ?? 0)) return false;
  if (/\b(?:400|401|403|404|422)\b|AbortError|cancel|lease_lost|stale_fencing|unauthori[sz]ed|forbidden|invalid.?api.?key|insufficient_quota|insufficient.?credits|billing|payment.required|github_identity|not_found|ambiguous|configuration|config.*invalid|missing.*(?:account|token|key|config)|prohibited|未授权|权限|账号|账户|未配置|配置.*(?:无效|缺失)|余额|额度不足|weekly_report_(?:invalid_daily_summary|input_too_large|target_changed|daily_summaries_not_ready|rewrite_api_unavailable)/iu.test(message)) return false;
  return true;
}

/** Audit free text is redacted before it enters a JSON field or correction prompt. */
export function summaryDiagnostic(value: string, secrets: string[] = [], maxChars = 20_000): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret|sessionid)["']?\s*[:=]\s*["']?)[^\s"',;\\}]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s"\\]+/gi, "[URL REDACTED]")
    .slice(0, maxChars);
}
export function summaryErrorReason(error: unknown, secrets: string[] = []): string {
  return summaryDiagnostic(error instanceof Error ? error.message : String(error), secrets, 2000);
}

/** Leave room below the audit API's 256 KiB limit, including JSON escaping and UTF-8. */
export function boundedSummaryAudit(payload: Record<string, unknown>): Record<string, unknown> {
  const limit = 240 * 1024;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= limit) return payload;
  const diagnosticKeys = new Set([
    "reason", "response", "draft_content", "generation_response", "review_response", "review_issues",
  ]);
  const trim = (value: unknown, maxChars: number, diagnostic = false): unknown => {
    if (typeof value === "string") return diagnostic ? value.slice(0, maxChars) : value;
    if (Array.isArray(value)) return value.map((item) => trim(item, maxChars, diagnostic));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trim(item, maxChars, diagnosticKeys.has(key))]),
    );
    return value;
  };
  for (let maxChars = 10_000; ; maxChars = Math.floor(maxChars / 2)) {
    const bounded = { ...(trim(payload, maxChars) as Record<string, unknown>), diagnostics_truncated: true };
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= limit) return bounded;
    // All callers bound attempt/issue counts; this guards against future oversized metadata.
    if (maxChars === 0) throw new Error("summary_audit_metadata_too_large");
  }
}
