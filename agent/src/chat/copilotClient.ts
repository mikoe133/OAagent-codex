import type { AppConfig } from '../config/config.js';
import { ChatError } from './chatScheduler.js';
export type CopilotRecord = { id: string | number; user_id: string | number; record: Record<string, unknown>; created_at?: unknown; updated_at?: unknown };
export class CopilotClient {
  constructor(private config: AppConfig, private token: string, private userId: string) {}
  async call(method: string, endpoint: string, query: Record<string, string> = {}, body?: unknown): Promise<any> {
    if (!this.config.oaApiBaseUrl) throw new ChatError(503, 'oa_unavailable', 'OA 未配置');
    const url = new URL(endpoint, this.config.oaApiBaseUrl);
    url.searchParams.set('alias', this.config.oaAuthAlias);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, { method, headers: { Authorization: `Bearer ${this.token}`, Cookie: `sessionid=${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    } catch { throw new ChatError(503, 'oa_unavailable', 'OA Copilot 暂不可用'); }
    if (response.status === 404 && endpoint === '/copilot/record')
      throw new ChatError(404, 'record_not_found', '当前会话已失效或不属于当前账号，请重新打开会话或新建对话');
    if (!response.ok) throw new ChatError([401,403,404].includes(response.status) ? response.status : 502, 'oa_record_error', 'OA Copilot 请求失败');
    let envelope: any;
    try { envelope = await response.json(); } catch { throw new ChatError(502, 'oa_invalid_response', 'OA 返回无效数据'); }
    if (envelope?.success === false || (typeof envelope?.code === 'number' && envelope.code >= 400))
      throw new ChatError(502, 'oa_record_error', 'OA Copilot 请求失败');
    return envelope?.data;
  }
  validate(value: any): CopilotRecord {
    if (!value || (typeof value.id === 'number' && !Number.isSafeInteger(value.id)) || !/^[1-9]\d*$/.test(String(value.id)) || !value.record || typeof value.record !== 'object' || Array.isArray(value.record))
      throw new ChatError(502, 'oa_invalid_response', 'OA 会话记录格式无效');
    if (String(value.user_id) !== this.userId) throw new ChatError(404, 'record_not_found', '会话不存在');
    return value;
  }
  async get(recordId: string) {
    const value = this.validate(await this.call('GET', '/copilot/record', { record_id: recordId }));
    if (String(value.id) !== recordId) throw new ChatError(502, 'oa_invalid_response', 'OA 会话编号不匹配');
    return value;
  }
  async create(title: string) {
    return this.validate(await this.call('POST', '/copilot/record', {}, { schema: 'oa-agent-chat/v1', title, summary: null, messages: [] }));
  }
  async save(recordId: string, body: Record<string, unknown>) {
    return this.validate(await this.call('PATCH', '/copilot/record', { record_id: recordId }, body));
  }
  async list(page: number, size: number) {
    const value = await this.call('GET', '/copilot/list', { page: String(page), size: String(size) });
    if (!Array.isArray(value?.items)) throw new ChatError(502, 'oa_invalid_response', 'OA 列表格式无效');
    return { ...value, items: value.items.map((item: unknown) => this.validate(item)) };
  }
}
