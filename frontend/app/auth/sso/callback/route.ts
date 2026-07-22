import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { resolveOaSessionToken } from "@/lib/server/oa-session"
import { createSsoRedirectUrl } from "@/lib/server/sso-redirect-url"
import {
  clearPendingSsoCookie,
  setAgentSessionCookie,
  setPendingSsoCookie,
} from "@/lib/server/sso-cookies"
import {
  claimSsoHandoff,
  consumePendingSsoHandoff,
  discardPendingSsoHandoff,
} from "@/lib/server/sso-handoff-store"

const CODE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") || ""
  if (!CODE_PATTERN.test(code)) {
    return redirectWithError(request, "invalid_or_expired")
  }

  const claimed = claimSsoHandoff(code)
  if (!claimed) {
    return redirectWithError(request, "invalid_or_expired")
  }

  const currentToken = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!currentToken) {
    return activateIncomingSession(request, claimed.pendingId)
  }

  const current = await resolveOaSessionToken(currentToken)
  if (current.status === "unavailable") {
    discardPendingSsoHandoff(claimed.pendingId)
    return redirectWithError(request, "oa_unavailable")
  }
  if (current.status === "invalid") {
    return activateIncomingSession(request, claimed.pendingId)
  }

  if (current.user.email === claimed.handoff.user.email) {
    discardPendingSsoHandoff(claimed.pendingId)
    return noStoreRedirect(createSsoRedirectUrl(request, "/chat"))
  }

  const response = noStoreRedirect(createSsoRedirectUrl(request, "/auth/sso/choose"))
  const maxAge = Math.max(1, Math.ceil((claimed.handoff.expiresAt - Date.now()) / 1_000))
  setPendingSsoCookie(response, claimed.pendingId, maxAge)
  return response
}

function activateIncomingSession(request: NextRequest, pendingId: string): NextResponse {
  const handoff = consumePendingSsoHandoff(pendingId)
  if (!handoff) {
    return redirectWithError(request, "invalid_or_expired")
  }

  const response = noStoreRedirect(createSsoRedirectUrl(request, "/auth/sso/complete"))
  setAgentSessionCookie(response, handoff.token)
  clearPendingSsoCookie(response)
  return response
}

function redirectWithError(request: NextRequest, error: string): NextResponse {
  const url = createSsoRedirectUrl(request, "/login")
  url.searchParams.set("sso_error", error)
  return noStoreRedirect(url)
}

function noStoreRedirect(url: URL): NextResponse {
  const response = NextResponse.redirect(url)
  response.headers.set("Cache-Control", "no-store")
  response.headers.set("Referrer-Policy", "no-referrer")
  return response
}
