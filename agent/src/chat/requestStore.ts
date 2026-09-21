import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChatTraceEvent } from './chatTrace.js';
export type PublicResult = { recordId: string; requestId: string; finalResponse: string; provider: string; model: string; knowledgeSources: unknown[] };
export type RequestRecord = {
  recordId: string; requestId: string; fingerprint: string; message: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: string; updatedAt: string; errorCode?: string;
  historySync: 'pending' | 'synced'; result?: PublicResult;
};
export class RequestStore {
  constructor(private directory: string) {}
  key(owner: string, recordId: string, requestId: string) {
    return createHash('sha256').update(JSON.stringify([owner, recordId, requestId])).digest('hex');
  }
  private file(key: string) { return path.join(this.directory, `${key}.json`); }
  async appendTrace(key: string, event: ChatTraceEvent) {
    const file = await open(path.join(this.directory, `${key}.trace.jsonl`), 'a', 0o600);
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); }
    finally { await file.close(); }
    if (event.sequence === 1) await this.sync();
  }
  async readTrace(key: string): Promise<ChatTraceEvent[]> {
    let text: string;
    try { text = await readFile(path.join(this.directory, `${key}.trace.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    // A process interrupted mid-write may leave a partial last line. Only complete
    // records are committed; never discard earlier trace events because of it.
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async read(key: string): Promise<RequestRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.file(key), 'utf8'));
      if (!value || typeof value.fingerprint !== 'string' || !['queued','running','completed','failed','cancelled','unknown'].includes(value.state)) throw new Error('invalid request record');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async create(key: string, value: RequestRecord) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(this.file(key), value); await this.sync();
  }
  async save(key: string, value: RequestRecord) {
    const temporary = `${this.file(key)}.${randomUUID()}.tmp`;
    await this.write(temporary, value); await rename(temporary, this.file(key)); await this.sync();
  }
  async discardUnaccepted(key: string) {
    await unlink(this.file(key));
    await unlink(path.join(this.directory, `${key}.trace.jsonl`)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.sync();
  }
  private async write(filename: string, value: RequestRecord) {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  }
  private async sync() {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
export function fingerprint(payload: unknown) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
