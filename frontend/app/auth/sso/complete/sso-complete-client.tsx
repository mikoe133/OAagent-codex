"use client"

import { useEffect, useState } from "react"

import { persistSsoSession, type AuthUser } from "@/lib/auth"

export function SsoCompleteClient({ user }: { user: AuthUser }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    try {
      persistSsoSession(user)
      window.location.replace("/chat")
    } catch {
      setFailed(true)
    }
  }, [user])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-stone-100 px-6 text-stone-950">
      <section className="w-full max-w-sm border border-stone-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold">
          {failed ? "无法完成登录" : "正在进入 OA Agent"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          {failed ? "浏览器无法保存账号状态，请检查隐私设置后重试。" : user.email}
        </p>
        {failed ? (
          <a
            href="/login"
            className="mt-5 inline-flex bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
          >
            返回登录
          </a>
        ) : null}
      </section>
    </main>
  )
}
