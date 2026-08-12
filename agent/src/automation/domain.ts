import { createHash, timingSafeEqual } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

export const ACTIVE_RUN_STATUSES = new Set(["pending", "claimed", "running"]);
export const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "partial_failed",
  "failed",
  "configuration_error",
  "skipped",
  "cancelled",
]);

const RUN_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pending: new Set(["claimed", "failed", "cancelled"]),
  claimed: new Set(["running", "configuration_error", "failed", "cancelled"]),
  running: new Set([
    "succeeded",
    "partial_failed",
    "failed",
    "configuration_error",
    "cancelled",
  ]),
};

const SENSITIVE_DATA_KEYS = new Set([
  "key",
  "token",
  "access_token",
  "api_key",
  "authorization",
  "cookie",
  "sessionid",
  "password",
  "secret",
  "private_key",
  "headers",
  "request_headers",
  "response_headers",
  "x-api-key",
]);

export class AutomationDomainError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AutomationDomainError";
  }
}

export function calculateNextRunAt(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  validateTimezone(timezone);
  try {
    return CronExpressionParser.parse(cronExpression, {
      currentDate: after,
      tz: timezone,
    })
      .next()
      .toDate();
  } catch {
    throw new AutomationDomainError("invalid_cron_expression");
  }
}

export function calculatePreviousRunAt(
  cronExpression: string,
  timezone: string,
  before: Date,
): Date {
  validateTimezone(timezone);
  try {
    return CronExpressionParser.parse(cronExpression, {
      currentDate: before,
      tz: timezone,
    })
      .prev()
      .toDate();
  } catch {
    throw new AutomationDomainError("invalid_cron_expression");
  }
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new AutomationDomainError("invalid_timezone");
  }
}

export function ensureRunTransition(
  currentStatus: string,
  newStatus: string,
): void {
  if (currentStatus === newStatus && TERMINAL_RUN_STATUSES.has(currentStatus)) {
    return;
  }
  if (!RUN_TRANSITIONS[currentStatus]?.has(newStatus)) {
    throw new AutomationDomainError("invalid_run_transition");
  }
}

export function digestLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyLeaseToken(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digestLeaseToken(token), "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_DATA_KEYS.has(key.toLocaleLowerCase())
          ? "***"
          : redactSensitiveData(item),
      ]),
    );
  }
  return value;
}

export function sanitizeErrorSummary(
  value: string | null | undefined,
  maxLength = 1000,
): string | null {
  if (value == null) {
    return null;
  }
  const blocked = new RegExp(
    [
      "\\bauthorization\\b",
      "\\bcookie\\b",
      "\\bsessionid\\b",
      "\\bapi[_-]?key\\b",
      "\\baccess[_-]?token\\b",
      "\\bprivate[_-]?key\\b",
      "\\bpassword\\b",
      "\\bsecret\\b",
      "\\btraceback\\b",
      "\\bselect\\s+.+\\s+from\\b",
      "\\binsert\\s+into\\b",
      "\\bupdate\\s+.+\\s+set\\b",
      "\\bdelete\\s+from\\b",
      "\\bsqlalchemy\\b",
    ].join("|"),
    "i",
  );
  const safe = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !blocked.test(line))
    .join(" ")
    .slice(0, maxLength);
  return safe || "sensitive_error_removed";
}
