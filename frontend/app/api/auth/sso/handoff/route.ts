import { timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

import { resolveOaSessionToken } from "@/lib/server/oa-session"
import { readServerEnvValue } from "@/lib/server/server-env"
import { createSsoHandoff } from "@/lib/server/sso-handoff-store"

type HandoffBody = {
  oaToken?: unknown
}

const MAX_REQUEST_BYTES = 16 * 1024

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const sharedSecret = readServerEnvValue("OA_AGENT_SSO_SHARED_SECRET") || ""
  if (!sharedSecret) {
    return noStoreJson({ error: "sso_not_configured" }, 503)
  }

  if (!matchesBearerSecret(request.headers.get("authorization"), sharedSecret)) {
    return noStoreJson({ error: "unauthorized" }, 401)
  }

  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10)
  if (contentLength > MAX_REQUEST_BYTES) {
    return noStoreJson({ error: "request_too_large" }, 413)
  }

  const body = await readBody(request)
  const oaToken = typeof body.oaToken === "string" ? body.oaToken.trim() : ""
  if (!oaToken || oaToken.length > MAX_REQUEST_BYTES) {
    return noStoreJson({ error: "invalid_token" }, 400)
  }

  const resolution = await resolveOaSessionToken(oaToken)
  if (resolution.status === "invalid") {
    return noStoreJson({ error: "invalid_token" }, 401)
  }
  if (resolution.status === "unavailable") {
    return noStoreJson({ error: "oa_authentication_unavailable" }, 503)
  }

  return noStoreJson(createSsoHandoff(oaToken, resolution.user), 201)
}

function matchesBearerSecret(authorization: string | null, expectedSecret: string): boolean {
  const actualSecret = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ""
  const actual = Buffer.from(actualSecret)
  const expected = Buffer.from(expectedSecret)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBody(request: Request): Promise<HandoffBody> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === "object" ? (body as HandoffBody) : {}
  } catch {
    return {}
  }
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}
