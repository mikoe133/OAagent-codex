import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/config.js';
import { buildOpenApiIndex, mergeOpenApiIndexes } from '../src/infrastructure/oa/openApiIndex.js';
import { createOpenApiSemanticRouter, routeOpenApiRequest, routeOpenApiRequestRace } from '../src/infrastructure/oa/openApiRouter.js';
import { applyAttachmentRoute } from '../src/attachments/attachmentRouting.js';
import { attachmentUploadForm, bindAttachmentTurn, finishAttachmentTurn, prepareAttachmentInput } from '../src/attachments/attachmentContext.js';
import type { AttachmentDecision, AttachmentRoutingInput } from '../src/attachments/attachmentIntent.js';
import type { StoredAttachment } from '../src/attachments/attachmentStore.js';
import { buildRuntimeContext } from '../src/application/runCodexAgent.js';
import { formatSemanticRouteTraceMessage } from '../src/application/agentService.js';

const config = {
  projectRoot: process.cwd(), openapiPath: '/test/openapi.json', modelProvider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash',
  modelProviders: { openrouter: { name: 'OpenRouter', apiKey: 'test', baseUrl: 'https://router.test/v1', envKey: 'OPENROUTER_API_KEY' } },
} as AppConfig;
const index = mergeOpenApiIndexes([
  buildOpenApiIndex({ paths: { '/people': { get: { operationId: 'getPeople', tags: ['people'], responses: {} } } } }),
  buildOpenApiIndex({ paths: { '/attachments': { post: { operationId: 'uploadAttachment', tags: ['attachments'], responses: {} } } } }, 'knowledge_base_write'),
]);
const selectedModel = { provider: config.modelProvider, model: config.model, supportsImages: false };
const metadata = (image = false): AttachmentRoutingInput => ({
  files: [{ id: 'opaque-id', name: image ? 'picture.png' : '无标题.txt', mime: image ? 'image/png' : 'text/plain', size: 730 }],
  mode: 'auto', source: 'current', selectedModel,
});
const decision = (intent: AttachmentDecision['intent'] = 'analyze', requiresVision = false): AttachmentDecision => ({
  intent, requiresVision, visionModel: 'moonshotai/kimi-k3', reason: '根据本轮语义判断附件用途',
});
const response = (attachment: AttachmentDecision) => JSON.stringify({
  catalogs: [], tags: [], operationIds: [], searchTerms: [], accessMode: 'read', attachment,
});

test('one structured router request classifies contextual document analysis and supplies actual text without switching', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'semantic-attachment-'));
  const file: StoredAttachment = { ...metadata().files[0]!, path: path.join(directory, 'bytes'), recordId: '1', createdAt: new Date().toISOString() };
  let calls = 0;
  try {
    await writeFile(file.path, '李明是负责移动端开发的工程师。');
    bindAttachmentTurn('contextual-text', [file]);
    const router = createOpenApiSemanticRouter(config, async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.ok(body.response_format.json_schema.schema.required.includes('attachment'));
      assert.equal(body.response_format.json_schema.schema.properties.catalogs.minItems, 0);
      const prompt = body.messages[0].content;
      const payload = JSON.parse(prompt.split('<router_input>\n')[1].split('\n</router_input>')[0]);
      assert.equal(payload.task, '这个人是谁');
      assert.deepEqual(payload.attachments, metadata());
      assert.doesNotMatch(prompt, /semantic-attachment-|李明是/);
      return Response.json({ choices: [{ message: { content: response(decision()) } }] });
    }, true);
    const route = await routeOpenApiRequest(config, index, { task: '这个人是谁', attachments: metadata() }, router);
    assert.equal(calls, 1);
    assert.equal(route.diagnostics.strategy, 'semantic');
    assert.deepEqual(route.catalogs, []);
    const execution = applyAttachmentRoute('contextual-text', config.modelProvider, config.model, route.attachment!);
    assert.equal(execution.switched, false);
    const input = await prepareAttachmentInput('这个人是谁', 'contextual-text', execution.provider, execution.model);
    assert.match(String(input), /李明是负责移动端开发的工程师/);
    assert.doesNotMatch(String(input), new RegExp(directory));
    await assert.rejects(attachmentUploadForm('contextual-text', file.id), /明确要求/);
    const runtime = buildRuntimeContext(config, { selectedApiCatalogs: route.catalogs, openApiCandidates: route.candidates });
    assert.match(runtime, /无需外部接口/);
    assert.doesNotMatch(runtime, /callOaApi|OA 完整接口文档/);
    assert.match(formatSemanticRouteTraceMessage(route), /无需外部接口/);
  } finally { finishAttachmentTurn('contextual-text'); await rm(directory, { recursive: true, force: true }); }
});

test('race winner controls Qwen image execution and trace; existing Kimi selection stays selected', async () => {
  const file = { ...metadata(true).files[0]!, path: '/server/private/picture.png', recordId: '1', createdAt: new Date().toISOString() };
  const chosen = { ...decision('analyze', true), visionModel: 'qwen/qwen3.8-max-0902' as const };
  let aborted = false;
  try {
    bindAttachmentTurn('image-route', [file]);
    const route = await routeOpenApiRequestRace(config, index, { task: '用 Qwen 看看图中是什么', attachments: metadata(true) }, [
      { model: 'slow', router: async (_prompt, options) => new Promise((_, reject) => options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) },
      { model: 'fast', router: async () => response(chosen) },
    ]);
    assert.equal(aborted, true);
    assert.equal(route.diagnostics.winningModel, 'fast');
    const execution = applyAttachmentRoute('image-route', config.modelProvider, config.model, route.attachment!);
    assert.equal(execution.model, chosen.visionModel);
    assert.match(execution.events[1]!.message, /切换为 Qwen 3.8 Max 模型用作文件解析/);
    const input = await prepareAttachmentInput('看图', 'image-route', execution.provider, execution.model);
    assert.ok(Array.isArray(input));
    assert.deepEqual(input[1], { type: 'local_image', path: file.path });
    const retained = applyAttachmentRoute('image-route', 'openrouter', 'moonshotai/kimi-k3', chosen);
    assert.equal(retained.switched, false);
    assert.equal(retained.events.length, 1);
  } finally { finishAttachmentTurn('image-route'); }
});

test('invalid or missing model decisions fail closed after bounded repair', async () => {
  for (const invalid of [undefined, decision('analyze', true), decision('upload'), { ...decision(), intent: 'guess' }, { ...decision(), intent: ['analyze'] }]) {
    let calls = 0;
    const route = await routeOpenApiRequest(config, index, { task: '这个人是谁', attachments: metadata() }, async () => {
      calls++; return response(invalid as AttachmentDecision);
    });
    assert.equal(calls, 2);
    assert.equal(route.diagnostics.strategy, 'fallback');
    assert.deepEqual(route.catalogs, []);
    assert.deepEqual(route.candidates, []);
    assert.equal(route.attachment?.intent, 'clarify');
    assert.equal(route.attachment?.requiresVision, false);
    bindAttachmentTurn('failed-route', [{ ...metadata().files[0]!, path: '/not/read', recordId: '1', createdAt: '' }]);
    try {
      const execution = applyAttachmentRoute('failed-route', config.modelProvider, config.model, route.attachment!, true);
      assert.equal(execution.switched, false);
      assert.equal(execution.events[0]!.status, 'failed');
      await assert.rejects(attachmentUploadForm('failed-route', 'opaque-id'), /明确要求/);
      assert.match(String(await prepareAttachmentInput('task', 'failed-route', execution.provider, execution.model)), /clarify/);
    } finally { finishAttachmentTurn('failed-route'); }
  }
});

test('upload-only uses write route without vision; ignored prior files never provide bytes or upload authorization', async () => {
  const upload = await routeOpenApiRequest(config, index, { task: '存到知识库页面 X', attachments: metadata(true) }, async () => JSON.stringify({
    catalogs: ['knowledge_base_write'], tags: ['attachments'], operationIds: ['uploadAttachment'], searchTerms: ['attachment upload'], accessMode: 'write', attachment: decision('upload'),
  }));
  assert.equal(upload.diagnostics.strategy, 'semantic');
  assert.equal(upload.attachment?.intent, 'upload');
  assert.equal(applyAttachmentRoute('upload-route', config.modelProvider, config.model, upload.attachment!).switched, false);
  const prior = { ...metadata(true), source: 'previous' as const };
  const ignored = await routeOpenApiRequest(config, index, { task: '你好', attachments: prior }, async () => response(decision('ignore')));
  bindAttachmentTurn('ignore-route', [{ ...prior.files[0]!, path: '/must/not/read', recordId: '1', createdAt: '' }], 'auto', undefined, 'previous');
  try {
    applyAttachmentRoute('ignore-route', config.modelProvider, config.model, ignored.attachment!);
    assert.equal(await prepareAttachmentInput('你好', 'ignore-route', config.modelProvider, config.model), '你好');
    await assert.rejects(attachmentUploadForm('ignore-route', 'opaque-id'), /明确要求/);
  } finally { finishAttachmentTurn('ignore-route'); }
});
