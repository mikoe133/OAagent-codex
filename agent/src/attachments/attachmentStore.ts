import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ChatError } from '../chat/chatScheduler.js';

export type Attachment = { id: string; recordId: string; name: string; mime: string; size: number; createdAt: string };
export type StoredAttachment = Attachment & { path: string };
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TTL = 7 * 24 * 3600 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TYPES: Record<string, string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.doc':'application/msword', '.xls':'application/vnd.ms-excel', '.ppt':'application/vnd.ms-powerpoint', '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.json':'application/json', '.log':'text/plain', '.zip':'application/zip' };
export function validateFile(name: string, bytes: Buffer): string {
  const mime = TYPES[path.extname(name).toLowerCase()];
  if (!mime) throw new ChatError(415, 'unsupported_attachment', '不支持此文件类型，请使用图片、PDF、Office、文本或 ZIP 文件');
  if (!bytes.length || bytes.length > (mime.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) throw new ChatError(413, 'attachment_too_large', '图片限 10 MB，文件限 50 MB，不能上传空文件');
  const signatures: Record<string, boolean> = {
    'image/png': bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'image/gif': /^GIF8[79]a/.test(bytes.subarray(0,6).toString()),
    'image/webp': bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP',
    'application/pdf': bytes.subarray(0,5).toString() === '%PDF-',
  };
  if (signatures[mime] === false) throw new ChatError(415, 'invalid_attachment', '文件内容与扩展名不匹配');
  return mime;
}
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(value).size !== value.length) throw new ChatError(400, 'invalid_attachments', '每条消息最多 5 个附件，附件编号无效');
  return value;
}
export function publicAttachment({ path: _path, ...value }: StoredAttachment): Attachment { return value; }

export class AttachmentStore {
  private pending: Promise<unknown> = Promise.resolve();
  private uploading = 0;
  constructor(private root: string) {}
  private ownerDir(owner: string) { return path.join(this.root, createHash('sha256').update(owner).digest('hex')); }
  private directory(owner: string, recordId: string) {
    if (!/^[1-9]\d*$/.test(recordId)) throw new ChatError(400, 'invalid_record', '会话编号无效');
    return path.join(this.ownerDir(owner), recordId);
  }
  async receive(owner: string, recordId: string, req: IncomingMessage) {
    if (this.uploading >= 4) throw new ChatError(429, 'uploads_busy', '上传繁忙，请稍后重试');
    this.uploading++;
    try {
      let name: string;
      try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { throw new ChatError(400, 'invalid_filename', '文件名编码无效'); }
      if (!name || name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new ChatError(400, 'invalid_filename', '文件名无效');
      if (Number(req.headers['content-length']) > MAX_FILE_BYTES) throw new ChatError(413, 'attachment_too_large', '文件限 50 MB');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new ChatError(413, 'attachment_too_large', '文件限 50 MB');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks), mime = validateFile(name, bytes);
      const next = this.pending.catch(() => {}).then(() => this.save(owner, recordId, name, mime, bytes));
      this.pending = next;
      return await next;
    } finally { this.uploading--; }
  }
  private async save(owner: string, recordId: string, name: string, mime: string, bytes: Buffer) {
    const directory = this.directory(owner, recordId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let total = 0, count = 0;
    // Bound each owner's storage and discard expired files on their next upload.
    for (const record of await readdir(this.ownerDir(owner))) {
      if (!/^[1-9]\d*$/.test(record)) continue;
      for (const file of await readdir(path.join(this.ownerDir(owner), record))) {
        const filename = path.join(this.ownerDir(owner), record, file);
        const info = await stat(filename);
        if (Date.now() - info.mtimeMs > ATTACHMENT_TTL) { await rm(filename, { force: true }); continue; }
        total += info.size;
        if (record === recordId && file.endsWith('.json') && UUID.test(file.slice(0, -5))) count++;
      }
    }
    if (total + bytes.length > 200 * 1024 * 1024 || count >= 50) throw new ChatError(413, 'attachment_quota', '临时附件额度已满（每用户 200 MB、每会话 50 个，保留 7 天）');
    const item: Attachment = { id: randomUUID(), recordId, name, mime, size: bytes.length, createdAt: new Date().toISOString() };
    const base = path.join(directory, item.id);
    const filename = `${base}.data${path.extname(name).toLowerCase()}`;
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    try { await writeFile(`${base}.json`, JSON.stringify(item), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(filename, { force: true }); throw error; }
    return item;
  }
  async get(owner: string, recordId: string, id: string): Promise<StoredAttachment> {
    if (!UUID.test(id)) throw new ChatError(404, 'attachment_not_found', '附件不存在');
    const base = path.join(this.directory(owner, recordId), id);
    try {
      const item: Attachment = JSON.parse(await readFile(`${base}.json`, 'utf8'));
      const filename = `${base}.data${path.extname(item.name).toLowerCase()}`;
      if (Date.now() - Date.parse(item.createdAt) > ATTACHMENT_TTL) throw new Error('expired');
      await stat(filename);
      return { ...item, path: filename };
    } catch { throw new ChatError(404, 'attachment_not_found', '附件不存在或已过期，请重新选择文件'); }
  }
  async deleteSession(owner: string, recordId: string) { await rm(this.directory(owner, recordId), { recursive: true, force: true }); }
}
