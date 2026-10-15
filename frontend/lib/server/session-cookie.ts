import { SESSION_COOKIE_NAME } from '@/lib/auth'
import { parseCookie } from '../../../agent/src/api/cookies'

export function readSessionToken(request: Request): string | null {
  return parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME)
}
