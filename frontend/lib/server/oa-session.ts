import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { readServerEnvValue } from "@/lib/server/server-env"

export type OaSessionValidationResult = "valid" | "invalid" | "unavailable"

export type OaSessionUser = {
  id: number | string
  email: string
}

export type OaSessionResolution =
  | { status: "valid"; user: OaSessionUser }
  | { status: "invalid" }
  | { status: "unavailable" }

type OaUserEnvelope = {
  code?: unknown
  success?: unknown
  data?: {
    id?: unknown
    email?: unknown
  } | null
}

const VALIDATION_TIMEOUT_MS = 5_000

export async function validateOaSessionToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OaSessionValidationResult> {
  return (await resolveOaSessionToken(token, fetchImpl)).status
}

export async function resolveOaSessionToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OaSessionResolution> {
  const baseUrl = getOaApiBaseUrl()
  if (!baseUrl) {
    return { status: "unavailable" }
  }

  const url = new URL("/user/user", baseUrl)
  const alias = getOaAuthAlias()
  if (alias) {
    url.searchParams.set("alias", alias)
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch {
    return { status: "unavailable" }
  }

  if (!response.ok) {
    return {
      status: response.status >= 400 && response.status < 500 ? "invalid" : "unavailable",
    }
  }

  let payload: OaUserEnvelope
  try {
    payload = (await response.json()) as OaUserEnvelope
  } catch {
    return { status: "unavailable" }
  }

  const code = typeof payload.code === "number" ? payload.code : response.status
  if (payload.success === false || code >= 400) {
    return { status: code < 500 ? "invalid" : "unavailable" }
  }

  const email =
    typeof payload.data?.email === "string" ? payload.data.email.trim().toLowerCase() : ""
  if (!email) {
    return { status: "unavailable" }
  }

  const id = payload.data?.id
  return {
    status: "valid",
    user: {
      id: typeof id === "number" || typeof id === "string" ? id : email,
      email,
    },
  }
}

function getOaApiBaseUrl(): string | null {
  return (
    readServerEnvValue("OA_API_BASE_URL") ||
    readServerEnvValue("AUTH_API_BASE_URL") ||
    readServerEnvValue("NEXT_PUBLIC_OA_API_BASE_URL") ||
    null
  )
}

function getOaAuthAlias(): string {
  return readServerEnvValue("OA_AUTH_ALIAS") || readServerEnvValue("AUTH_API_ALIAS") || "default"
}
