import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"

type LoginBody = {
  email?: unknown
  password?: unknown
  remember?: unknown
}

type UpstreamPayload = {
  code?: number
  message?: string
  data?: {
    token?: unknown
  } | null
  success?: boolean
  detail?: unknown
}

const REMEMBER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export const runtime = "nodejs"

export async function POST(request: Request) {
  const body = await readLoginBody(request)
  const email = typeof body.email === "string" ? body.email.trim() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const remember = typeof body.remember === "boolean" ? body.remember : true

  if (!email || !password) {
    return NextResponse.json(
      {
        code: 422,
        message: "Email and password are required.",
        data: null,
        success: false,
      },
      { status: 422 },
    )
  }

  const authApiBaseUrl = getAuthApiBaseUrl()
  if (!authApiBaseUrl) {
    return NextResponse.json(
      {
        code: 500,
        message: "Login service is not configured. Set OA_API_BASE_URL for the frontend server.",
        data: null,
        success: false,
      },
      { status: 500 },
    )
  }

  const url = new URL("/auth/login", authApiBaseUrl)
  const alias = getAuthAlias()
  if (alias) {
    url.searchParams.set("alias", alias)
  }

  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(request),
      body: JSON.stringify({
        email,
        password,
        remember,
      }),
      cache: "no-store",
    })

    const payload = await readUpstreamPayload(upstreamResponse)
    const response = NextResponse.json(payload, { status: upstreamResponse.status })
    const token = extractToken(payload)

    if (upstreamResponse.ok && token) {
      const cookieOptions = {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        ...(remember ? { maxAge: REMEMBER_MAX_AGE_SECONDS } : {}),
      }

      response.cookies.set(SESSION_COOKIE_NAME, token, cookieOptions)
    }

    return response
  } catch {
    return NextResponse.json(
      {
        code: 502,
        message: "Login service is unreachable. Please try again later.",
        data: null,
        success: false,
      },
      { status: 502 },
    )
  }
}

async function readLoginBody(request: Request): Promise<LoginBody> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === "object" ? (body as LoginBody) : {}
  } catch {
    return {}
  }
}

function getAuthApiBaseUrl(): string | null {
  return (
    process.env.OA_API_BASE_URL?.trim() ||
    process.env.AUTH_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_OA_API_BASE_URL?.trim() ||
    readSharedEnvValue("OA_API_BASE_URL") ||
    null
  )
}

function getAuthAlias(): string {
  return process.env.OA_AUTH_ALIAS?.trim() || process.env.AUTH_API_ALIAS?.trim() || "default"
}

function buildUpstreamHeaders(request: Request): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  })
  const cookie = request.headers.get("cookie")

  if (cookie) {
    headers.set("Cookie", cookie)
  }

  return headers
}

async function readUpstreamPayload(response: Response): Promise<UpstreamPayload> {
  const contentType = response.headers.get("content-type") || ""
  const text = await response.text()

  if (contentType.includes("application/json") && text) {
    try {
      const payload = JSON.parse(text) as unknown
      if (payload && typeof payload === "object") {
        return payload as UpstreamPayload
      }
    } catch {
      return {
        code: response.status,
        message: "Login service returned an invalid JSON response.",
        data: null,
        success: false,
      }
    }
  }

  return {
    code: response.status,
    message: text || response.statusText || "Login service returned an invalid response.",
    data: null,
    success: response.ok,
  }
}

function extractToken(payload: UpstreamPayload): string | null {
  const token = payload.data?.token
  return typeof token === "string" && token.trim() ? token.trim() : null
}

function readSharedEnvValue(key: string): string | null {
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
    if (separatorIndex < 0) {
      continue
    }

    const name = line.slice(0, separatorIndex).trim()
    if (name !== key) {
      continue
    }

    return unquoteEnvValue(line.slice(separatorIndex + 1).trim())
  }

  return null
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}
