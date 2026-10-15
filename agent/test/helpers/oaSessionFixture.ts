import { createHash, createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";

export function signOaSessionPayload(payload: string, signedAtSeconds = 1_800_000_000): string {
  const timestamp = Buffer.alloc(4);
  timestamp.writeUInt32BE(signedAtSeconds);
  const value = `${payload}.${timestamp.toString("base64url")}`;
  const key = createHash("sha1").update("itsdangerous.Signersigner").update("dummy").digest();
  return `${value}.${createHmac("sha1", key).update(value).digest("base64url")}`;
}

export function createSignedOaSession(payload: unknown, compressed = false, signedAtSeconds?: number): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return signOaSessionPayload(
    compressed ? `.${deflateSync(bytes).toString("base64url")}` : bytes.toString("base64"),
    signedAtSeconds,
  );
}
