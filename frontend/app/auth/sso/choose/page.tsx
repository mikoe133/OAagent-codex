import { redirect } from "next/navigation"
import { cookies } from "next/headers"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { resolveOaSessionToken } from "@/lib/server/oa-session"
import { SSO_PENDING_COOKIE_NAME } from "@/lib/server/sso-cookies"
import { getPendingSsoHandoff } from "@/lib/server/sso-handoff-store"

export const dynamic = "force-dynamic"

export default async function SsoChoosePage() {
  const cookieStore = await cookies()
  const pendingId = cookieStore.get(SSO_PENDING_COOKIE_NAME)?.value || ""
  const handoff = getPendingSsoHandoff(pendingId)
  const currentToken = cookieStore.get(SESSION_COOKIE_NAME)?.value || ""

  if (!handoff || !currentToken) {
    redirect("/login?sso_error=invalid_or_expired")
  }

  const current = await resolveOaSessionToken(currentToken)
  if (current.status !== "valid") {
    redirect("/login?sso_error=invalid_or_expired")
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-stone-100 px-6 text-stone-950">
      <section className="w-full max-w-md border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-stone-500">OA Agent</p>
        <h1 className="mt-2 text-2xl font-semibold">选择使用的账号</h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          OA Agent 当前已登录一个账号。请选择继续当前账号，或切换到刚才从 OA 带入的账号。
        </p>

        <div className="mt-6 divide-y divide-stone-200 border border-stone-200">
          <AccountRow label="当前 Agent 账号" email={current.user.email} />
          <AccountRow label="OA 带入账号" email={handoff.user.email} />
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <form action="/api/auth/sso/decision" method="post">
            <input type="hidden" name="decision" value="keep-current" />
            <button
              type="submit"
              className="w-full border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
            >
              继续当前账号
            </button>
          </form>
          <form action="/api/auth/sso/decision" method="post">
            <input type="hidden" name="decision" value="use-oa" />
            <button
              type="submit"
              className="w-full bg-stone-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700"
            >
              使用 OA 账号
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}

function AccountRow({ label, email }: { label: string; email: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-stone-500">{label}</span>
      <span className="truncate text-right text-sm font-medium text-stone-900">{email}</span>
    </div>
  )
}
