import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatLatencyTrace } from '../infrastructure/observability/chatLatency.js';
import type { AppConfig } from '../config/config.js';
import type { AgentService, SendMessageInput } from '../application/agentService.js';
import type { SessionStore } from '../infrastructure/persistence/sessionStore.js';
import { getDefaultModel, resolveRequestedModel, resolveRequestedProvider, resolveRequestedRouterModel, ROUTER_MODEL_CATALOG } from '../config/modelCatalog.js';
import { ChatError, ChatScheduler } from './chatScheduler.js';
import { CopilotClient, type CopilotRecord } from './copilotClient.js';
import { RequestStore, fingerprint, type RequestRecord } from './requestStore.js';
import { ChatTraceRecorder } from './chatTrace.js';

type Principal = { principalId: string; oaUserId: string | null };
type Active = { cancel: () => void; done: Promise<void>; listeners: Set<(event: Record<string, unknown>) => void> };
const json = (res: ServerResponse, status: number, value: unknown) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
};
function publicSession(value: CopilotRecord) {
  const { agentSessionId: _session, threadId: _thread, ...record } = value.record;
  return { ...record, recordId: String(value.id), createdAt: value.record.createdAt ?? value.created_at, updatedAt: value.updated_at };
}
function bounded(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new ChatError(400, 'invalid_pagination', '分页参数无效');
  return number;
}
export class PublicChatApi {
  private records: RequestStore;
  private active = new Map<string, Active>();
  private admission: Promise<unknown> = Promise.resolve();
  constructor(private config: AppConfig, private service: AgentService, private sessions: SessionStore,
    readonly scheduler = new ChatScheduler()) {
    this.records = new RequestStore(sessions.requestStorePath);
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, token: string, principal: Principal, latency?: ChatLatencyTrace) {
    if (url.pathname !== '/v1/sessions' && !url.pathname.startsWith('/v1/sessions/')) return false;
    try {
      if (!principal.oaUserId) throw new ChatError(503, 'oa_identity_unavailable', 'OA 未返回用户 ID');
      await this.route(req, res, url, token, principal as Principal & { oaUserId: string }, latency);
    } catch (error) {
      const failure = error instanceof ChatError ? error : new ChatError(503, 'chat_storage_unavailable', '会话服务暂不可用，请保留原请求编号');
      if (failure.status === 429 || failure.status === 503) res.setHeader('Retry-After', failure.code === 'user_rate_limited' ? '60' : '3');
      json(res, failure.status, { code: failure.code, error: failure.message });
    }
    return true;
  }
  private async route(req: IncomingMessage, res: ServerResponse, url: URL, token: string, principal: Principal & { oaUserId: string }, latency?: ChatLatencyTrace) {
    const client = new CopilotClient(this.config, token, principal.oaUserId);
    const method = req.method;
    if (url.pathname === '/v1/sessions') {
      if (method === 'POST') {
        const body = await readBody(req);
        if ('sessionId' in body || 'recordId' in body) throw new ChatError(400, 'oa_generated_id', '会话编号由 OA 分配，不接受自定义 ID');
        if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 200)) throw new ChatError(400, 'invalid_title', '标题须为不超过 200 字的字符串');
        const record = await client.create(body.title?.trim() || 'New Section');
        res.setHeader('Location', `/v1/sessions/${record.id}`); json(res, 201, publicSession(record)); return;
      }
      if (method === 'GET') {
        const page = bounded(url.searchParams.get('page'), 1, 1000000), size = bounded(url.searchParams.get('size'), 20, 100);
        const result = await client.list(page, size);
        json(res, 200, { sessions: result.items.map(publicSession), page, size, total: result.total }); return;
      }
      throw new ChatError(405, 'method_not_allowed', '不支持该方法');
    }
    const match = url.pathname.match(/^\/v1\/sessions\/([1-9]\d*)(?:\/(messages(?:\/stream)?|requests\/([A-Za-z0-9_.:-]{1,120})(?:\/(cancel|sync))?))?$/);
    if (!match) throw new ChatError(404, 'not_found', '接口或 OA 会话编号不存在');
    const recordId = match[1]!, action = match[2], requestId = match[3], operation = match[4];
    const record = await client.get(recordId); // OA ownership validation on every operation, including replays.
    const owner = JSON.stringify([this.config.oaApiBaseUrl, this.config.oaAuthAlias, principal.principalId]);
    const sessionKey = JSON.stringify([owner, recordId]);
    if (!action) {
      if (method === 'GET') { json(res, 200, publicSession(record)); return; }
      if (method === 'DELETE') {
        await this.exclusive(async () => {
          if (this.scheduler.busy(sessionKey)) throw new ChatError(409, 'session_busy', '请先取消或等待当前请求结束');
          await client.call('DELETE', '/copilot/record', { record_id: recordId });
        });
        json(res, 200, { recordId, deleted: true }); return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        await this.exclusive(async () => {
          if (this.scheduler.busy(sessionKey)) throw new ChatError(409, 'session_busy', '请等待对话结束后更新会话');
          const latest = await client.get(recordId);
          const next = { ...latest.record };
          if (body.title !== undefined) {
            if (typeof body.title !== 'string' || body.title.length > 200) throw new ChatError(400, 'invalid_title', '标题无效');
            next.title = body.title;
          }
          if (body.feedback !== undefined) {
            if (!body.feedback || typeof body.feedback !== 'object' || Array.isArray(body.feedback)) throw new ChatError(400, 'invalid_feedback', '反馈格式无效');
            next.messages = (Array.isArray(next.messages) ? next.messages : []).map((message: any) => {
              const value = body.feedback[message.id];
              return ['like','dislike',null].includes(value) ? { ...message, feedback: value } : message;
            });
          }
          if (Object.keys(body).some(key => !['title','feedback'].includes(key))) throw new ChatError(400, 'invalid_patch', '仅支持标题和消息反馈，不允许覆盖消息历史');
          json(res, 200, publicSession(await client.save(recordId, next)));
        }); return;
      }
    }
    if (action === 'messages' && method === 'GET') {
      const all = Array.isArray(record.record.messages) ? record.record.messages : [];
      const size = bounded(url.searchParams.get('limit'), 20, 100);
      const raw = url.searchParams.get('cursor');
      const offset = raw === null ? 0 : Number(raw);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ChatError(400, 'invalid_cursor', '游标无效');
      json(res, 200, { recordId, messages: all.slice(offset, offset + size), nextCursor: offset + size < all.length ? String(offset + size) : null }); return;
    }
    if (requestId) {
      const key = this.records.key(owner, recordId, requestId);
      const value = await this.read(key);
      if (!value) throw new ChatError(404, 'request_not_found', '请求不存在');
      if (method === 'GET' && !operation) { json(res, 200, publicRequest(value)); return; }
      if (method === 'POST' && operation === 'cancel') {
        this.active.get(key)?.cancel();
        json(res, 202, { recordId, requestId, cancellationRequested: this.active.has(key), state: value.state }); return;
      }
      if (method === 'POST' && operation === 'sync') {
        if (!['completed', 'failed', 'cancelled'].includes(value.state)) throw new ChatError(409, 'result_unavailable', '请求尚未结束，暂无可同步的历史');
        await this.exclusive(async () => {
          if (this.scheduler.busy(sessionKey)) throw new ChatError(409, 'session_busy', '会话仍有任务执行，请稍后重试');
          await this.sync(client, key, value);
        });
        json(res, 200, publicRequest(await this.read(key))); return;
      }
    }
    if ((action === 'messages' || action === 'messages/stream') && method === 'POST') {
      const body = await readBody(req);
      const keyHeader = req.headers['idempotency-key'];
      const messageKey = keyHeader ?? body.requestId;
      if (typeof messageKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(messageKey) || (body.requestId !== undefined && body.requestId !== messageKey))
        throw new ChatError(400, 'invalid_request_id', '必须提供 Idempotency-Key；与 requestId 同时提供时须一致');
      const input = selection(this.config, body);
      const digest = fingerprint({ recordId, ...input });
      const key = this.records.key(owner, recordId, messageKey);
      const streaming = action.endsWith('/stream');
      let fresh = false;
      await this.exclusive(async () => {
        const existing = await this.read(key);
        if (existing) {
          if (existing.fingerprint !== digest) throw new ChatError(409, 'idempotency_conflict', '编号已用于不同的请求参数');
          return;
        }
        const now = new Date().toISOString();
        const value: RequestRecord = { recordId, requestId: messageKey, fingerprint: digest, message: input.message,
          state: 'queued', createdAt: now, updatedAt: now, historySync: 'pending' };
        await this.records.create(key, value);
        const trace = new ChatTraceRecorder(this.records, key);
        const listeners = new Set<(event: Record<string, unknown>) => void>();
        let job;
        try {
          job = this.scheduler.submit(owner, sessionKey, async signal => {
            try {
              await trace.record({ type: 'run.queued' });
              value.state = 'running'; value.updatedAt = new Date().toISOString(); await this.records.save(key, value);
              // Read the latest OA record inside the per-session execution slot.
              const latest = await client.get(recordId);
              const legacyId = latest.record.agentSessionId;
              const owned = await this.sessions.listForOwner(principal.principalId);
              const internalId = typeof legacyId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(legacyId) && owned.some(item => item.sessionId === legacyId)
                ? legacyId : `oa-${fingerprint([this.config.oaApiBaseUrl, this.config.oaAuthAlias, recordId])}`;
              if (!await this.sessions.bindOaToken(internalId, token, principal.principalId, principal.oaUserId)) throw new ChatError(403, 'forbidden', '内部会话归属不匹配');
              signal.throwIfAborted();
              const emit = (event: Record<string, unknown>) => { for (const listener of listeners) listener(event); };
              await this.service.streamMessage({ ...input, sessionId: internalId, oaApiToken: token, oaUserId: principal.oaUserId, latency }, async event => {
                if (event.type === 'run.failed') throw new Error('agent_failed');
                await trace.record(event);
                if (event.type === 'run.completed') {
                  value.result = { recordId, requestId: messageKey, finalResponse: event.result.finalResponse,
                    provider: event.result.provider, model: event.result.model, knowledgeSources: event.result.knowledgeSources };
                  value.state = 'completed'; value.updatedAt = new Date().toISOString();
                  await this.records.save(key, value); // Commit before attempting OA history sync.
                } else {
                  const { sessionId: _sid, ...publicEvent } = event;
                  if (event.type !== 'thread.started') emit({ ...publicEvent, recordId, requestId: messageKey });
                }
              }, signal).catch(error => { throw signal.aborted ? signal.reason : error; });
              if (!value.result) throw new Error('agent_result_missing');
              try { await this.sync(client, key, value); } catch { /* result remains available; explicit sync retry */ }
            } catch (error) {
              if (value.state !== 'completed') {
                await this.fail(key, value, trace, signal.aborted ? signal.reason : error);
                // Keep the session slot until the failure history has been saved.
                try { await this.sync(client, key, value); } catch { /* explicit sync retry */ }
              }
              throw error;
            }
          });
        } catch (error) { await this.records.discardUnaccepted(key); throw error; }
        const entry: Active = { ...job, listeners };
        this.active.set(key, entry);
        entry.done = job.done.catch(async error => {
          // Queued cancellation/timeout never enters the task. Preserve its trace
          // locally; explicit sync waits until the session is idle.
          if (value.state === 'queued' || value.state === 'running') await this.fail(key, value, trace, error);
        }).finally(() => { this.active.delete(key); });
        // A persistence failure is observed by HTTP/query without an unhandled rejection.
        void entry.done.catch(() => {});
        fresh = true;
      });
      res.setHeader('Idempotency-Key', messageKey); res.setHeader('Idempotency-Replayed', String(!fresh));
      res.setHeader('Location', `/v1/sessions/${recordId}/requests/${messageKey}`);
      const active = this.active.get(key);
      if (!fresh && active) {
        res.setHeader('Retry-After', '3'); json(res, 409, { recordId, requestId: messageKey, code: 'idempotency_pending', state: (await this.read(key))?.state }); return;
      }
      if (streaming) { latency?.mark("stream_connected"); await this.stream(res, key, recordId, messageKey, active, latency); return; }
      await active?.done;
      const value = await this.read(key);
      latency?.finish({ status: value?.state === 'completed' ? 'completed' : 'failed', provider: value?.result?.provider, model: value?.result?.model });
      json(res, value?.state === 'completed' ? 200 : 409, publicRequest(value)); return;
    }
    throw new ChatError(405, 'method_not_allowed', '不支持该方法');
  }
  private async read(key: string) {
    const value = await this.records.read(key);
    if (value && ['running','queued'].includes(value.state) && !this.active.has(key)) value.state = 'unknown';
    if (!value) return null;
    const traceEvents = await this.records.readTrace(key);
    return { ...value, traceEvents };
  }
  private async fail(key: string, value: RequestRecord, trace: ChatTraceRecorder, error: unknown) {
    value.state = error instanceof ChatError && error.code === 'cancelled' ? 'cancelled' : 'failed';
    value.errorCode = error instanceof ChatError ? error.code : 'agent_failed';
    value.updatedAt = new Date().toISOString();
    await trace.record({ type: 'run.failed', status: value.state, error: value.errorCode });
    await this.records.save(key, value);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.admission.catch(() => {}).then(operation); this.admission = next; return next;
  }
  private async sync(client: CopilotClient, key: string, value: RequestRecord) {
    if (!['completed', 'failed', 'cancelled'].includes(value.state)) return;
    const traceEvents = await this.records.readTrace(key);
    const latest = await client.get(value.recordId);
    const messages = Array.isArray(latest.record.messages) ? latest.record.messages : [];
    const additions = [
      { id: `${value.requestId}:user`, requestId: value.requestId, role: 'user', content: value.message, createdAt: value.createdAt },
      { id: `${value.requestId}:assistant`, requestId: value.requestId, role: 'assistant', content: value.result?.finalResponse ?? '',
        createdAt: value.updatedAt, status: value.state === 'cancelled' ? 'stopped' : value.state,
        durationMs: Math.max(0, Date.parse(value.updatedAt) - Date.parse(value.createdAt)),
        ...(value.errorCode ? { error: value.errorCode } : {}),
        ...(value.result ? { model: value.result.model, provider: value.result.provider } : {}),
        knowledgeSources: value.result?.knowledgeSources ?? [], traceEvents },
    ];
    const combined = [...messages];
    for (const message of additions) {
      const index = combined.findIndex((item: any) => item.id === message.id);
      if (index < 0) combined.push(message);
      else if (message.role === 'assistant') combined[index] = { ...combined[index], ...message };
    }
    await client.save(value.recordId, { ...latest.record, messages: combined,
      ...(value.result ? { summary: value.result.finalResponse.slice(0, 3000) } : {}) });
    value.historySync = 'synced';
    // read() enriches public responses with the journal; keep metadata snapshots
    // small when /sync was invoked with an enriched record.
    const { traceEvents: _trace, ...metadata } = value as RequestRecord & { traceEvents?: unknown };
    await this.records.save(key, metadata);
  }
  private async stream(res: ServerResponse, key: string, recordId: string, requestId: string, active?: Active, latency?: ChatLatencyTrace) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const emit = (event: Record<string, unknown>) => {
      if (res.destroyed || res.writableEnded) return;
      // Disconnect a stalled consumer without aborting the background execution.
      if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    emit({ type: 'run.queued', recordId, requestId });
    active?.listeners.add(emit);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
    const cleanup = () => { clearInterval(heartbeat); active?.listeners.delete(emit); };
    res.once('close', cleanup);
    try {
      await active?.done;
      const value = await this.read(key);
      latency?.finish({ status: value?.state === 'completed' ? 'completed' : 'failed', provider: value?.result?.provider, model: value?.result?.model });
      emit(value?.state === 'completed'
        ? { type: 'run.completed', recordId, requestId, result: { ...value.result, traceEvents: value.traceEvents }, historySync: value.historySync }
        : { type: 'run.failed', recordId, requestId, error: value?.errorCode ?? 'outcome_unknown', state: value?.state, traceEvents: value?.traceEvents });
    } catch { emit({ type: 'run.failed', recordId, requestId, error: 'result_unavailable' }); }
    finally { cleanup(); if (!res.destroyed) res.end(); }
  }
}
function publicRequest(value: RequestRecord | null) {
  if (!value) return { code: 'request_not_found' };
  const { fingerprint: _digest, ...result } = value;
  return result;
}
async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  const buffers: Buffer[] = []; let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk); length += buffer.length;
    if (length > 128 * 1024) { req.resume(); throw new ChatError(413, 'body_too_large', '请求体超过 128 KiB'); }
    buffers.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(buffers).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ChatError(400, 'invalid_json', '请求体必须是 JSON 对象'); }
}
function selection(config: AppConfig, body: Record<string, any>): Omit<SendMessageInput, 'sessionId'> & { message: string } {
  if (typeof body.message !== 'string' || !body.message.trim()) throw new ChatError(400, 'invalid_message', 'message 必须是非空字符串');
  for (const key of ['provider','model','routerModel']) if (body[key] !== undefined && typeof body[key] !== 'string') throw new ChatError(400, 'invalid_model', '模型参数必须是字符串');
  if (body.developerMode !== undefined && typeof body.developerMode !== 'boolean') throw new ChatError(400, 'invalid_developer_mode', 'developerMode 必须为布尔值');
  try {
    const provider = resolveRequestedProvider(body.provider, config.modelProvider);
    return { message: body.message.trim(), provider, model: resolveRequestedModel(provider, body.model, provider === config.modelProvider ? config.model : getDefaultModel(provider)),
      developerMode: body.developerMode === true,
      routerModel: body.routerModel !== undefined ? resolveRequestedRouterModel(body.routerModel) : body.developerMode ? ROUTER_MODEL_CATALOG[0] : null };
  } catch { throw new ChatError(400, 'invalid_model', '模型不在白名单内'); }
}
