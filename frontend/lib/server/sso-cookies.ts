import type { NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"

export const SSO_PENDING_COOKIE_NAME = "oa-agent-sso-pending"

const baseCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
  path: "/",
}

export function setAgentSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE_NAME, token, baseCookieOptions)
}

export function setPendingSsoCookie(
  response: NextResponse,
  pendingId: string,
  maxAge: number,
): void {
  response.cookies.set(SSO_PENDING_COOKIE_NAME, pendingId, {
    ...baseCookieOptions,
    maxAge,
  })
}

export function clearPendingSsoCookie(response: NextResponse): void {
  response.cookies.set(SSO_PENDING_COOKIE_NAME, "", {
    ...baseCookieOptions,
    maxAge: 0,
  })
}
