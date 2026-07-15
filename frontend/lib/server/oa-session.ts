import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { SESSION_COOKIE_NAME } from "@/lib/auth"

export type OaSessionValidationResult = "valid" | "invalid" | "unavailable"

type OaUserEnvelope = {
  code?: unknown
  success?: unknown
  data?: {
    email?: unknown
  } | null
}

const VALIDATION_TIMEOUT_MS = 5_000

export async function validateOaSessionToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OaSessionValidationResult> {
  const baseUrl = getOaApiBaseUrl()
  if (!baseUrl) {
    return "unavailable"
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
        Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch {
    return "unavailable"
  }

  if (!response.ok) {
    return response.status >= 400 && response.status < 500 ? "invalid" : "unavailable"
  }

  let payload: OaUserEnvelope
  try {
    payload = (await response.json()) as OaUserEnvelope
  } catch {
    return "unavailable"
  }

  const code = typeof payload.code === "number" ? payload.code : response.status
  if (payload.success === false || code >= 400) {
    return code < 500 ? "invalid" : "unavailable"
  }

  return typeof payload.data?.email === "string" && payload.data.email.trim() ? "valid" : "unavailable"
}

function getOaApiBaseUrl(): string | null {
  return (
    readEnvValue("OA_API_BASE_URL") ||
    readEnvValue("AUTH_API_BASE_URL") ||
    readEnvValue("NEXT_PUBLIC_OA_API_BASE_URL") ||
    null
  )
}

function getOaAuthAlias(): string {
  return readEnvValue("OA_AUTH_ALIAS") || readEnvValue("AUTH_API_ALIAS") || "default"
}

function readEnvValue(key: string): string | null {
  const direct = process.env[key]?.trim()
  if (direct) {
    return direct
  }

  const cwd = process.cwd()
  const candidates = [
    resolve(cwd, ".env.local"),
    resolve(cwd, ".env"),
    resolve(cwd, "..", ".env.local"),
    resolve(cwd, "..", ".env"),
  ]

  for (const filePath of candidates) {
    const value = readEnvFileValue(filePath, key)
    if (value) {
      return value
    }
  }

  return null
}

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }

  let lines: string[]
  try {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/)
  } catch {
    return null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex < 0 || line.slice(0, separatorIndex).trim() !== key) {
      continue
    }

    return line.slice(separatorIndex + 1).trim().replace(/^(['"])(.*)\1$/, "$2") || null
  }

  return null
}
