"use client"

import type React from "react"

import { ArrowRight, Loader2, LockKeyhole, Mail } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { Alert } from "@/components/ui/hero-alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import TextType from "@/components/text/TextType"
import { LoginError, loginWithPassword, persistLoginSession } from "@/lib/auth"

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    const validationMessage = validateLoginForm(email, password)
    if (validationMessage) {
      setErrorMessage(validationMessage)
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const session = await loginWithPassword({
        email,
        password,
        remember,
      })

      persistLoginSession(session, remember)
      router.replace(getSafeNextPath())
    } catch (error) {
      setErrorMessage(error instanceof LoginError ? error.message : "Sign in failed. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main
      className="relative min-h-dvh overflow-x-hidden bg-stone-950 text-slate-950"
      style={{
        backgroundImage: "url('/images/gradient-background.jpg')",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "cover",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_18%,rgba(255,255,255,0.42),transparent_34%),linear-gradient(135deg,rgba(15,23,42,0.18),rgba(255,255,255,0.06)_48%,rgba(15,23,42,0.28))]" />

      <section className="relative z-10 flex min-h-dvh w-full flex-col lg:flex-row">
        <div className="flex min-h-[38dvh] min-w-0 flex-1 items-center px-6 py-10 sm:px-10 lg:min-h-dvh lg:px-16 xl:px-20">
          <div className="min-w-0 max-w-xl text-white drop-shadow-[0_2px_18px_rgba(15,23,42,0.35)]">
            <div className="mb-6 inline-flex h-10 items-center rounded-lg border border-white/35 bg-white/15 px-4 text-sm font-medium tracking-wide shadow-sm backdrop-blur-xl">
              RWKVOS
            </div>
            <h1 className="break-words text-3xl font-semibold leading-tight sm:text-4xl md:text-6xl">
              Sign in to continue.
            </h1>
            <TextType
              className="mt-5 max-w-md text-base leading-7 text-white/78 md:text-lg"
              text={["Welcome to RWKVOS!", "Continue your conversation with the AI assistant."]}
              typingSpeed={75}
              pauseDuration={1500}
              showCursor
              cursorCharacter="_"
              deletingSpeed={50}
              cursorBlinkDuration={0.5}
            />
          </div>
        </div>

        <aside className="flex min-h-[62dvh] w-full min-w-0 items-center justify-center border-t border-white/35 bg-white/20 px-6 py-10 shadow-[0_-24px_80px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-3xl sm:px-10 lg:min-h-dvh lg:w-1/3 lg:border-l lg:border-t-0 lg:bg-white/18 lg:px-8 lg:shadow-[-24px_0_80px_rgba(15,23,42,0.18),inset_1px_0_0_rgba(255,255,255,0.45)] xl:px-10">
          <div className="w-full max-w-sm">
            <div className="mb-8">
              <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-700/75">Login</p>
              <h2 className="mt-2 text-3xl font-semibold text-slate-950">Welcome back</h2>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              {errorMessage ? (
                <Alert
                  status="danger"
                  className="border border-red-200/70 bg-red-50/85 shadow-sm backdrop-blur-xl"
                >
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description className="text-red-900">{errorMessage}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-800">
                  Email
                </Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setErrorMessage(null)
                    }}
                    placeholder="you@example.com"
                    required
                    aria-invalid={Boolean(errorMessage)}
                    className="h-12 rounded-lg  bg-white/45 pl-10 text-slate-950
                     placeholder:text-slate-600/70
                     focus-visible:border-white/70 focus-visible:ring-white/55"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-800">
                  Password
                </Label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setErrorMessage(null)
                    }}
                    placeholder="Enter password"
                    required
                    aria-invalid={Boolean(errorMessage)}
                    className="h-12 rounded-lg  bg-white/45 pl-10 text-slate-950
                    placeholder:text-slate-600/70
                    focus-visible:border-white/70 focus-visible:ring-white/55"
                    />
                </div>
              </div>

              <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <label className="flex items-center gap-2 text-slate-800">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    className="size-4 rounded border-white/60 bg-white/45 accent-slate-950"
                  />
                  Remember me
                </label>
                {/* <span className="font-medium text-slate-700/80">Use your OA account</span> */}
              </div>

              <Button
                type="submit"
                size="lg"
                disabled={isSubmitting}
                className="h-12 w-full rounded-lg bg-slate-950 text-white shadow-[0_14px_28px_rgba(15,23,42,0.28)] hover:bg-slate-950 active:bg-slate-950 disabled:bg-slate-950 disabled:text-white disabled:opacity-100"
              >
                {isSubmitting ? (
                  <>
                    Signing in...
                    <Loader2 className="size-4 animate-spin" />
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </form>
          </div>
        </aside>
      </section>
    </main>
  )
}

function validateLoginForm(email: string, password: string): string | null {
  const trimmedEmail = email.trim()

  if (!trimmedEmail || !password) {
    return "Please enter your email and password."
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return "Please enter a valid email address."
  }

  return null
}

function getSafeNextPath(): string {
  if (typeof window === "undefined") {
    return "/chat"
  }

  const nextPath = new URLSearchParams(window.location.search).get("next")
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "/chat"
  }

  try {
    const url = new URL(nextPath, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname === "/login") {
      return "/chat"
    }

    return `${url.pathname}${url.search}${url.hash}` || "/chat"
  } catch {
    return "/chat"
  }
}
