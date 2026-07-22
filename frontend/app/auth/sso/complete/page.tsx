import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { resolveOaSessionToken } from "@/lib/server/oa-session"

import { SsoCompleteClient } from "./sso-complete-client"

export const dynamic = "force-dynamic"

export default async function SsoCompletePage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value || ""
  if (!token) {
    redirect("/login?sso_error=invalid_or_expired")
  }

  const resolution = await resolveOaSessionToken(token)
  if (resolution.status !== "valid") {
    redirect(
      resolution.status === "unavailable"
        ? "/login?sso_error=oa_unavailable"
        : "/login?sso_error=incoming_session_invalid",
    )
  }

  return <SsoCompleteClient user={resolution.user} />
}
