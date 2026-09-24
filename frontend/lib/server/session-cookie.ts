import { SESSION_COOKIE_NAME } from '@/lib/auth'

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get('cookie')?.split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))
  if (!cookie) return null

  // NextResponse.cookies.set URI-encodes values. Decode exactly once before
  // forwarding the original OA token, preserving embedded/trailing '=' signs.
  try {
    return decodeURIComponent(cookie.slice(SESSION_COOKIE_NAME.length + 1)) || null
  } catch {
    return null
  }
}
