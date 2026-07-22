import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { resolveOaSessionToken } from "@/lib/server/oa-session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value || ""
  if (!token) {
    return noStoreJson({ error: "unauthenticated" }, 401)
  }

  const resolution = await resolveOaSessionToken(token)
  if (resolution.status === "invalid") {
    return noStoreJson({ error: "invalid_session" }, 401)
  }
  if (resolution.status === "unavailable") {
    return noStoreJson({ error: "oa_unavailable" }, 503)
  }

  return noStoreJson({ user: resolution.user }, 200)
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}
