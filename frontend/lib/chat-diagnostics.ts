export const CHAT_DIAGNOSTICS_KEY = 'oa-chat-diagnostics'
export const TRACE_HEADER = 'x-oa-trace-id'
export const SOURCE_HEADER = 'x-oa-error-source'
export type DiagnosticRoute = '/api/chat' | '/api/chat/sessions' | '/api/chat/requests' | '/api/auth/me'
export type DiagnosticEvent = 'request_started' | 'response_received' | 'upstream_response' | 'network_failed' | 'aborted' | 'request_recovered' |
  'login_redirect' | 'prepare_failed' | 'stream_completed' | 'stream_failed' | 'stream_incomplete' | 'handler_failed'
export type DiagnosticPhase = 'local' | 'agent' | 'oa_auth'
type Diagnostic = {
  scope: 'browser' | 'web'
  event: DiagnosticEvent
  route: DiagnosticRoute
  traceId: string
  method?: string
  status?: number
  durationMs?: number
  phase?: DiagnosticPhase
}

export function traceId(value?: string | null): string {
  if (value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return value
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  // HTTP test environments may not expose randomUUID. This ID is only for
  // log correlation, never authentication or authorization.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16)
    return (character === 'x' ? random : (random & 3) | 8).toString(16)
  })
}

// Deliberately project an allowlist: never serialize Request, Error, headers,
// user identity, URLs with query parameters, request bodies or response bodies.
export function logChatDiagnostic(input: Diagnostic): void {
  const entry = {
    timestamp: new Date().toISOString(),
    scope: input.scope, event: input.event, route: input.route, traceId: input.traceId,
    method: ['GET', 'POST', 'PATCH', 'DELETE'].includes(input.method || '') ? input.method : undefined,
    status: input.status,
    durationMs: input.durationMs === undefined ? undefined : Math.max(0, Math.round(input.durationMs)),
    phase: input.phase,
  }
  try {
    const failed = (input.status ?? 0) >= 400 || ['network_failed', 'prepare_failed', 'stream_failed', 'stream_incomplete', 'handler_failed'].includes(input.event)
    const write = failed ? console.warn : console.info
    write.call(console, '[oa-chat]', JSON.stringify(entry))
  } catch { /* Diagnostics must never interrupt a chat. */ }
  if (input.scope === 'browser' && typeof window !== 'undefined') {
    try {
      let previous: unknown = []
      try { previous = JSON.parse(window.sessionStorage.getItem(CHAT_DIAGNOSTICS_KEY) || '[]') } catch { /* reset corrupt storage */ }
      const entries = Array.isArray(previous) ? previous.slice(-99) : []
      window.sessionStorage.setItem(CHAT_DIAGNOSTICS_KEY, JSON.stringify([...entries, entry]))
    } catch { /* Storage may be disabled or full. */ }
  }
}

export function diagnosticRoute(url: string): DiagnosticRoute {
  const pathname = url.split('?')[0]
  return pathname === '/api/chat/sessions' || pathname === '/api/chat/requests' || pathname === '/api/auth/me'
    ? pathname : '/api/chat'
}

export async function fetchChatWithDiagnostics(url: string, init: RequestInit = {}): Promise<Response> {
  const route = diagnosticRoute(url)
  const headers = new Headers(init.headers)
  const id = traceId(headers.get(TRACE_HEADER))
  headers.set(TRACE_HEADER, id)
  const context = { scope: 'browser' as const, route, traceId: id, method: init.method || 'GET' }
  const started = performance.now()
  logChatDiagnostic({ ...context, event: 'request_started' })
  try {
    const response = await fetch(url, { ...init, headers })
    const source = response.headers.get(SOURCE_HEADER)
    logChatDiagnostic({ ...context, event: 'response_received', status: response.status,
      durationMs: performance.now() - started,
      phase: source === 'agent' || source === 'local' || source === 'oa_auth' ? source : undefined })
    return response
  } catch (error) {
    logChatDiagnostic({ ...context, event: init.signal?.aborted ? 'aborted' : 'network_failed', durationMs: performance.now() - started })
    throw error
  }
}

export function redirectToChatLogin(response: Response, route: DiagnosticRoute): void {
  logChatDiagnostic({ scope: 'browser', route, traceId: traceId(response.headers.get(TRACE_HEADER)),
    event: 'login_redirect', status: response.status })
  window.location.assign(`/login?next=${encodeURIComponent('/chat')}`)
}
