export const SESSION_COOKIE_NAME = "sessionid"
export const AUTH_TOKEN_STORAGE_KEY = "oa-auth-token"
export const AUTH_USER_STORAGE_KEY = "oa-auth-user"

const ACCOUNT_SCOPED_STORAGE_KEYS = ["chat-agent-session-id", "chat-messages"]

export type AuthUser = {
  id: number | string
  email: string
}

export type LoginRequest = {
  email: string
  password: string
  remember: boolean
}

export type LoginResponseData = {
  id?: number | string
  email?: string
  token?: string
}

type AuthEnvelope<TData> = {
  code?: number
  message?: string
  data?: TData | null
  success?: boolean
  detail?: unknown
}

export type LoginSession = {
  user: AuthUser
  token?: string
  message: string
}

export class LoginError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "LoginError"
    this.status = status
  }
}

export async function loginWithPassword(input: LoginRequest): Promise<LoginSession> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email.trim(),
      password: input.password,
      remember: input.remember,
    }),
  })

  const payload = await readJson<AuthEnvelope<LoginResponseData>>(response)
  const failedByEnvelope = payload.success === false || isErrorCode(payload.code)

  if (!response.ok || failedByEnvelope) {
    throw new LoginError(resolveErrorMessage(payload, response.status), response.status)
  }

  const data = payload.data
  if (!data || typeof data !== "object") {
    throw new LoginError("Login succeeded but user information was missing.", response.status)
  }

  const email = typeof data.email === "string" && data.email.trim() ? data.email : input.email.trim()
  const id = typeof data.id === "number" || typeof data.id === "string" ? data.id : email
  const token = typeof data.token === "string" && data.token.trim() ? data.token.trim() : undefined

  return {
    user: {
      id,
      email,
    },
    token,
    message: payload.message || "Signed in successfully.",
  }
}

export function persistLoginSession(session: LoginSession, remember: boolean): void {
  if (typeof window === "undefined") {
    return
  }

  const primaryStorage = remember ? window.localStorage : window.sessionStorage
  const secondaryStorage = remember ? window.sessionStorage : window.localStorage

  primaryStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(session.user))
  secondaryStorage.removeItem(AUTH_USER_STORAGE_KEY)

  // The OA token is set as an httpOnly cookie by /api/auth/login.
  // Clear any legacy client-side copies so scripts cannot read the token.
  primaryStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  secondaryStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

export function persistSsoSession(user: AuthUser): void {
  if (typeof window === "undefined") {
    return
  }

  for (const storage of [window.localStorage, window.sessionStorage]) {
    storage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    storage.removeItem(AUTH_USER_STORAGE_KEY)
    for (const key of ACCOUNT_SCOPED_STORAGE_KEYS) {
      storage.removeItem(key)
    }
  }

  window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user))
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    return {
      success: false,
      message: response.statusText || "Login service returned an invalid response.",
    } as T
  }
}

function isErrorCode(code: number | undefined): boolean {
  return typeof code === "number" && code >= 400
}

function resolveErrorMessage(payload: AuthEnvelope<LoginResponseData>, status: number): string {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message
  }

  const detailMessage = resolveDetailMessage(payload.detail)
  if (detailMessage) {
    return detailMessage
  }

  if (status === 400) {
    return "Account or password is incorrect."
  }

  if (status === 422) {
    return "Please enter a valid email and password."
  }

  if (status >= 500) {
    return "Login service is unavailable. Please try again later."
  }

  return "Sign in failed. Please try again."
}

function resolveDetailMessage(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) {
    return detail
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          const message = (item as { msg?: unknown }).msg
          return typeof message === "string" ? message : null
        }
        return null
      })
      .filter((item): item is string => Boolean(item))

    return messages.length > 0 ? messages.join("; ") : null
  }

  return null
}
