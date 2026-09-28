import { logChatDiagnostic, SOURCE_HEADER, TRACE_HEADER, traceId,
  type DiagnosticRoute, type DiagnosticEvent, type DiagnosticPhase } from '@/lib/chat-diagnostics'

export class ChatRequestDiagnostics {
  readonly id: string
  phase: DiagnosticPhase = 'local'
  private readonly started = performance.now()
  constructor(private request: Request, private route: DiagnosticRoute) {
    this.id = traceId(request.headers.get(TRACE_HEADER))
  }
  log(event: DiagnosticEvent, status?: number): void {
    logChatDiagnostic({ scope: 'web', event, route: this.route, traceId: this.id,
      method: this.request.method, status, phase: this.phase, durationMs: performance.now() - this.started })
  }
  async fetch(input: string | URL | Request, init?: RequestInit, phase: DiagnosticPhase = 'agent'): Promise<Response> {
    this.phase = phase
    try {
      // Keep the ID in Web logs and return it to the browser. Do not send new
      // headers to external services whose tracing contract is not defined.
      const response = await fetch(input, init)
      this.log('upstream_response', response.status)
      if (response.ok) this.phase = 'local'
      return response
    } catch (error) {
      this.log(this.request.signal.aborted ? 'aborted' : 'network_failed')
      throw error
    }
  }
}

export function observeChatRoute<T extends Request>(route: DiagnosticRoute,
  handler: (request: T, diagnostics: ChatRequestDiagnostics) => Promise<Response>) {
  return async (request: T): Promise<Response> => {
    const diagnostics = new ChatRequestDiagnostics(request, route)
    diagnostics.log('request_started')
    try {
      const response = await handler(request, diagnostics)
      response.headers.set(TRACE_HEADER, diagnostics.id)
      if (!response.ok) response.headers.set(SOURCE_HEADER, diagnostics.phase)
      diagnostics.log('response_received', response.status)
      return response
    } catch (error) {
      diagnostics.log('handler_failed')
      throw error
    }
  }
}
