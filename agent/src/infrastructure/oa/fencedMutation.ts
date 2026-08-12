import { createHash } from "node:crypto";

export type FencedMutationContext = {
  runId: string;
  runMutationToken: string;
  fencingToken: number;
};

const DEFINITIVE_LEASE_LOSS_ERROR_CODES = new Set([
  "invalid_lease_token",
  "lease_expired",
  "invalid_run_mutation_token",
  "stale_fencing_token",
  "lease_fenced",
  "run_not_active",
]);

export function isDefinitiveLeaseLossErrorCode(
  errorCode: string | null,
): boolean {
  return errorCode !== null && DEFINITIVE_LEASE_LOSS_ERROR_CODES.has(errorCode);
}

export function isDefinitiveLeaseLossError(error: unknown): error is {
  status: 409;
  errorCode: string;
} {
  return isRecord(error) &&
    error.status === 409 &&
    typeof error.errorCode === "string" &&
    isDefinitiveLeaseLossErrorCode(error.errorCode);
}

export function buildFencedMutationBody(
  context: FencedMutationContext,
  operation: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const payloadForDigest = Object.fromEntries(
    Object.entries(body).filter(([key]) =>
      key !== "lease_token" &&
      key !== "run_mutation_token" &&
      key !== "idempotency_key"
    ),
  );
  const idempotencyKey = `sha256:${canonicalSha256({
    operation,
    payload: payloadForDigest,
    run_id: context.runId,
  })}`;
  return {
    ...body,
    run_id: context.runId,
    run_mutation_token: context.runMutationToken,
    fencing_token: context.fencingToken,
    idempotency_key: idempotencyKey,
  };
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(toCanonicalJson(value)))
    .digest("hex");
}

function toCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON 不支持非有限数字。");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : toCanonicalJson(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        result[key] = toCanonicalJson(item);
      }
    }
    return result;
  }
  throw new TypeError(`Canonical JSON 不支持类型:${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
