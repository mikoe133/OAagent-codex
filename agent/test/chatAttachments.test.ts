import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { AttachmentStore, attachmentIds, validateFile, type StoredAttachment } from '../src/attachments/attachmentStore.js';
import { applyAttachmentDecision, bindAttachmentTurn, finishAttachmentTurn, prepareAttachmentInput, extractAttachment } from '../src/attachments/attachmentContext.js';
import { callKnowledgeBaseApiTool } from '../src/infrastructure/knowledgebase/knowledgeBaseApiTool.js';
import type { AppConfig } from '../src/config/config.js';
import { decodeAttachmentDecision, type AttachmentDecision } from '../src/attachments/attachmentIntent.js';
import { attachmentExecutionModel } from '../src/attachments/attachmentModel.js';

test('attachment analysis routes to Kimi or retains Kimi/Qwen, without changing upload or ordinary chat', () => {
  const selections = [
    ['openrouter', 'z-ai/glm-5.3'],
    ['openrouter', 'deepseek/deepseek-v4.1-flash'], ['nexttoken', 'gpt-5.6-terra'],
    ['openrouter', 'moonshotai/kimi-k3'], ['openrouter', 'qwen/qwen3.8-max-0902'],
  ] as const;
  for (const [provider, model] of selections) {
    for (const intent of ['analyze', 'both', 'upload', 'clarify'] as const) {
      for (const requiresVision of [false, true]) {
        const result = attachmentExecutionModel(provider, model, { intent, requiresVision, visionModel: 'moonshotai/kimi-k3', reason: 'test' });
        const shouldSwitch = requiresVision && ['analyze', 'both'].includes(intent) &&
          !['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902'].includes(model);
        assert.deepEqual(result, shouldSwitch
          ? { provider: 'openrouter', model: 'moonshotai/kimi-k3', switched: true }
          : { provider, model, switched: false });
      }
    }
  }
});

const decision = (intent: AttachmentDecision['intent'], requiresVision = false): AttachmentDecision => ({ intent, requiresVision, visionModel: 'moonshotai/kimi-k3', reason: '路由模型判断' });

test('attachment route validates structured model output and rejects impossible vision decisions', () => {
  const input = { files: [{ id: '1', name: 'a.txt', mime: 'text/plain', size: 3 }], source: 'current' as const, mode: 'auto' as const, selectedModel: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', supportsImages: false } };
  assert.deepEqual(decodeAttachmentDecision(decision('analyze'), input), decision('analyze'));
  for (const value of [null, {}, { ...decision('analyze'), visionModel: 'untrusted/model' }, decision('analyze', true), decision('upload', true)]) {
    assert.throws(() => decodeAttachmentDecision(value, input), /invalid attachment/);
  }
});

test('attachment storage validates signatures, size, names, ownership, session and IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'attachments-'));
  const store = new AttachmentStore(directory);
  const request = (name: string, data = 'hello') => Object.assign(Readable.from([Buffer.from(data)]), { headers: { 'x-file-name': encodeURIComponent(name) } }) as unknown as IncomingMessage;
  try {
    const file = await store.receive('alice', '1', request('资料.txt'));
    assert.equal(file.name, '资料.txt'); assert.equal('path' in file, false);
    assert.equal((await store.get('alice', '1', file.id)).size, 5);
    await assert.rejects(store.get('bob', '1', file.id), /不存在/);
    await assert.rejects(store.get('alice', '2', file.id), /不存在/);
    await assert.rejects(store.get('alice', '1', '../x'), /不存在/);
    await assert.rejects(store.receive('alice', '1', request('../a.txt')), /文件名/);
    await assert.rejects(store.receive('alice', '1', request('a.png')), /内容与扩展名/);
    assert.throws(() => validateFile('x.svg', Buffer.from('<svg/>')), /不支持/);
    assert.throws(() => validateFile('x.txt', Buffer.alloc(50 * 1024 * 1024 + 1)), /50 MB/);
    assert.throws(() => attachmentIds([file.id, file.id]), /编号无效/);
    await store.deleteSession('alice', '1');
    await assert.rejects(store.get('alice', '1', file.id), /不存在/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vision inputs only reach verified models; raw uploads skip parsing and clarification never sends pixels', async () => {
  const file: StoredAttachment = { id: 'image-id', recordId: '1', name: 'a.png', mime: 'image/png', size: 100, createdAt: new Date().toISOString(), path: '/private/image.png' };
  try {
    bindAttachmentTurn('vision', [file]);
    applyAttachmentDecision('vision', decision('analyze', true));
    for (const model of ['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902']) {
      const input = await prepareAttachmentInput('task', 'vision', 'openrouter', model);
      assert.ok(Array.isArray(input)); assert.deepEqual(input[1], { type: 'local_image', path: file.path });
    }
    for (const model of ['z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash']) {
      const input = await prepareAttachmentInput('task', 'vision', 'openrouter', model);
      assert.equal(typeof input, 'string'); assert.match(String(input), /当前模型不支持图片输入/); assert.doesNotMatch(String(input), /private\/image/);
    }
    applyAttachmentDecision('vision', decision('upload'));
    assert.equal(typeof await prepareAttachmentInput('task', 'vision', 'openrouter', 'moonshotai/kimi-k3'), 'string');
    applyAttachmentDecision('vision', decision('clarify'));
    assert.equal(typeof await prepareAttachmentInput('task', 'vision', 'openrouter', 'moonshotai/kimi-k3'), 'string');
  } finally { finishAttachmentTurn('vision'); }
});

test('KB multipart sends server-owned bytes and identity, and blocks writes without upload intent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'attachment-form-'));
  const file: StoredAttachment = { id: 'file-id', recordId: '1', name: '说明.txt', mime: 'text/plain', size: 5, createdAt: new Date().toISOString(), path: path.join(directory, 'bytes') };
  const config = { projectRoot: path.resolve('agent'), knowledgeBaseOpenapiPath: path.resolve('agent/knowledgebaseapi/knowledgebaseapi.yaml'), knowledgeBaseApiBaseUrl: 'https://kb.test/api/agent/v1', knowledgeBaseApiToken: 'secret' } as AppConfig;
  // Tests can run from either the workspace root or the agent workspace.
  if (process.cwd().endsWith('/agent')) { config.projectRoot = process.cwd(); config.knowledgeBaseOpenapiPath = path.resolve('knowledgebaseapi/knowledgebaseapi.yaml'); }
  const input = { sessionId: 'form', operationId: 'uploadKnowledgeBaseAttachment', pathParams: { id: 'page-1' }, attachmentId: file.id, confirmed: true };
  let calls = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    calls++;
    assert.ok(init?.body instanceof FormData);
    const bytes = init.body.get('file') as File;
    assert.equal(bytes.name, '说明.txt'); assert.equal(await bytes.text(), 'hello');
    assert.equal(init.body.get('kind'), 'file');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-oa-user-id'), '19'); assert.equal(headers.get('authorization'), 'Bearer secret');
    assert.equal(headers.get('content-type'), null); assert.ok(headers.get('idempotency-key'));
    return Response.json({ attachment: { id: 'saved' } }, { status: 201 });
  };
  try {
    await writeFile(file.path, 'hello');
    bindAttachmentTurn('form', [file]);
    applyAttachmentDecision('form', decision('analyze'));
    assert.equal((await callKnowledgeBaseApiTool(config, input, '19', mockFetch)).error?.code, 'attachment_write_not_authorized');
    applyAttachmentDecision('form', decision('upload'));
    assert.equal((await callKnowledgeBaseApiTool(config, { ...input, attachmentId: 'other-file' }, '19', mockFetch)).ok, false);
    assert.equal((await callKnowledgeBaseApiTool(config, input, '19', mockFetch)).ok, true);
    assert.equal(calls, 1);
    finishAttachmentTurn('form');
    assert.equal((await callKnowledgeBaseApiTool(config, input, '19', mockFetch)).ok, false);
  } finally { finishAttachmentTurn('form'); await rm(directory, { recursive: true, force: true }); }
});

test('text extraction reports truncation and unsupported formats explicitly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'extract-'));
  const file = { name: 'notes.txt', path: path.join(directory, 'file') } as StoredAttachment;
  try {
    await writeFile(file.path, 'hello'); assert.equal(await extractAttachment(file), 'hello');
    await writeFile(file.path, 'x'.repeat(24001)); assert.match(await extractAttachment(file), /已截断/);
    assert.match(await extractAttachment({ ...file, name: 'sheet.xlsx' }), /暂不支持内容解析/);
    await writeFile(file.path, Buffer.from([255])); assert.match(await extractAttachment(file), /UTF-8/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('bounded document worker extracts PDF and DOCX and rejects malformed files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'documents-'));
  try {
    const pdfPath = fileURLToPath(new URL('./fixtures/attachments/text.pdf', import.meta.url));
    assert.match(await extractAttachment({ name: 'text.pdf', path: pdfPath } as StoredAttachment), /Hello attachment PDF/);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello attachment DOCX 中文资料</w:t></w:r></w:p></w:body></w:document>');
    const docxPath = path.join(directory, 'text.docx');
    await writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));
    assert.match(await extractAttachment({ name: 'text.docx', path: docxPath } as StoredAttachment), /Hello attachment DOCX 中文资料/);
    await writeFile(docxPath, 'not a zip');
    assert.match(await extractAttachment({ name: 'text.docx', path: docxPath } as StoredAttachment), /解析失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
