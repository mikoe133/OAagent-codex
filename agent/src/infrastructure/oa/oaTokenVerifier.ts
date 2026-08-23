import { createHash } from "node:crypto";

export type OaTokenValidationConfig = {
  oaApiBaseUrl: string | null;
  oaAuthAlias: string;
};

export type OaTokenValidationResult =
  | { status: "valid"; principalId: string; oaUserId: string | null }
  | { status: "invalid" }
  | { status: "unavailable" };

type OaUserEnvelope = {
  code?: unknown;
  success?: unknown;
  data?: {
    user_id?: unknown;
    id?: unknown;
    email?: unknown;
  } | null;
};

const VALIDATION_TIMEOUT_MS = 5_000;

export async function validateOaToken(
  config: OaTokenValidationConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OaTokenValidationResult> {
  if (!config.oaApiBaseUrl) {
    return { status: "unavailable" };
  }

  const url = new URL("/user/user", config.oaApiBaseUrl);
  if (config.oaAuthAlias) {
    url.searchParams.set("alias", config.oaAuthAlias);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: buildOaSessionHeaders(token),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return { status: "unavailable" };
  }

  if (!response.ok) {
    return response.status >= 400 && response.status < 500
      ? { status: "invalid" }
      : { status: "unavailable" };
  }

  let payload: OaUserEnvelope;
  try {
    payload = (await response.json()) as OaUserEnvelope;
  } catch {
    return { status: "unavailable" };
  }

  const code = typeof payload.code === "number" ? payload.code : response.status;
  if (payload.success === false || code >= 400) {
    return code < 500 ? { status: "invalid" } : { status: "unavailable" };
  }

  const email =
    typeof payload.data?.email === "string" ? payload.data.email.trim().toLowerCase() : "";
  if (!email) {
    return { status: "unavailable" };
  }

  return {
    status: "valid",
    principalId: createHash("sha256").update(email).digest("hex"),
    oaUserId: stableOaUserId(payload.data?.user_id ?? payload.data?.id),
  };
}

function stableOaUserId(value: unknown): string | null {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(normalized)
    ? normalized
    : null;
}

function buildOaSessionHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Cookie: `sessionid=${encodeURIComponent(token)}`,
  });
}
