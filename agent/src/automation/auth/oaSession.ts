import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { inflateSync } from "node:zlib";

const MAX_SESSION_PAYLOAD_BYTES = 1024 * 1024;

export type VerifiedOaSession = {
  userId: number;
  payload: Record<string, unknown>;
  signedAtSeconds: number;
};

export type VerifyOaSessionOptions = {
  secret: string;
  maxAgeSeconds: number;
  nowSeconds?: number;
};

export class OaSessionError extends Error {
  constructor(
    readonly code: "invalid_session" | "expired_session",
    message: string,
  ) {
    super(message);
    this.name = "OaSessionError";
  }
}

/** Verifies an extracted OA session token, including itsdangerous zlib payloads. */
export function verifyOaSession(
  signedSession: string,
  options: VerifyOaSessionOptions,
): VerifiedOaSession {
  const normalized = signedSession.trim();
  const compressed = normalized.startsWith(".");
  const parts = (compressed ? normalized.slice(1) : normalized).split(".");
  if (parts.length !== 3) {
    throw invalidSession();
  }
  const [payloadBase64, timestampBase64, receivedSignature] = parts;
  if (!payloadBase64 || !timestampBase64 || !receivedSignature) {
    throw invalidSession();
  }

  // The compression marker is part of the signed value, not just a payload hint.
  const value = `${compressed ? "." : ""}${payloadBase64}.${timestampBase64}`;
  const derivedKey = createHash("sha1")
    .update("itsdangerous.Signersigner", "utf8")
    .update(options.secret, "utf8")
    .digest();
  const expectedSignature = toBase64Url(
    createHmac("sha1", derivedKey).update(value, "utf8").digest(),
  );
  if (!constantTimeTextEqual(receivedSignature, expectedSignature)) {
    throw invalidSession();
  }

  const signedAtSeconds = decodeTimestamp(timestampBase64);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (options.maxAgeSeconds > 0) {
    const age = nowSeconds - signedAtSeconds;
    if (age < 0 || age > options.maxAgeSeconds) {
      throw new OaSessionError("expired_session", "OA session 已过期");
    }
  }

  let payload: unknown;
  try {
    const bytes = Buffer.from(fromBase64Url(payloadBase64), "base64");
    const decoded = compressed
      ? inflateSync(bytes, { maxOutputLength: MAX_SESSION_PAYLOAD_BYTES })
      : bytes;
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalidSession();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidSession();
  }
  const record = payload as Record<string, unknown>;
  const userId = record.user_id;
  if (!Number.isInteger(userId) || Number(userId) < 1) {
    throw invalidSession();
  }

  return {
    userId: Number(userId),
    payload: record,
    signedAtSeconds,
  };
}

function decodeTimestamp(value: string): number {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(fromBase64Url(value), "base64");
  } catch {
    throw invalidSession();
  }
  if (bytes.length === 0 || bytes.length > 8) {
    throw invalidSession();
  }
  let timestamp = 0;
  for (const byte of bytes) {
    timestamp = timestamp * 256 + byte;
  }
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidSession();
  }
  return timestamp;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function fromBase64Url(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/");
}

function invalidSession(): OaSessionError {
  return new OaSessionError("invalid_session", "OA session 无效");
}

