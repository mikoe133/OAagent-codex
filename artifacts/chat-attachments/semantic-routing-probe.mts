// Run from repository root: npx tsx artifacts/chat-attachments/semantic-routing-probe.mts
// Sends only synthetic questions and attachment metadata. Does not write to OA/KB.
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../../agent/src/config/config.js';
import { DEFAULT_ROUTER_MODELS } from '../../agent/src/config/modelCatalog.js';
import { buildOpenApiIndex, mergeOpenApiIndexes } from '../../agent/src/infrastructure/oa/openApiIndex.js';
import { resolveKnowledgeBaseContracts } from '../../agent/src/infrastructure/knowledgebase/knowledgeBaseContract.js';
import { createOpenApiSemanticRouter, routeOpenApiRequestRace } from '../../agent/src/infrastructure/oa/openApiRouter.js';
import { attachmentExecutionModel } from '../../agent/src/attachments/attachmentModel.js';
import type { AttachmentRoutingInput } from '../../agent/src/attachments/attachmentIntent.js';

const config = loadConfig();
const kb = await resolveKnowledgeBaseContracts(config);
const index = mergeOpenApiIndexes([buildOpenApiIndex(JSON.parse(await readFile(config.openapiPath, 'utf8'))), kb.read.index, ...(kb.write ? [kb.write.index] : [])]);
const cases = [
  { task: '这个人是谁', image: false, intent: 'analyze', vision: false },
  { task: '这张图里有什么？', image: true, intent: 'analyze', vision: true },
  { task: '把这张图片上传到知识库页面 X', image: true, intent: 'upload', vision: false },
  { task: '不要上传，只告诉我图上写了什么', image: true, intent: 'analyze', vision: true },
  { task: '你好，今天心情不错', image: true, previous: true, intent: 'ignore', vision: false },
  { task: '他有哪些经历', image: false, previous: true, intent: 'analyze', vision: false },
  { task: '图片可以上传到知识库吗？先不要操作', image: true, intent: 'clarify', vision: false },
  { task: '请用 Qwen 看看这幅图的主要内容', image: true, intent: 'analyze', vision: true, model: 'qwen/qwen3.8-max-0902' },
];
const reports = await Promise.all(cases.map(async scenario => {
  const attachments: AttachmentRoutingInput = {
    files: [{ id: 'synthetic-reference', name: scenario.image ? 'sample.png' : '无标题.txt', mime: scenario.image ? 'image/png' : 'text/plain', size: 730 }],
    source: scenario.previous ? 'previous' : 'current', mode: 'auto',
    selectedModel: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', supportsImages: false },
  };
  const started = performance.now();
  const route = await routeOpenApiRequestRace(config, index, {
    task: scenario.task, attachments,
    conversationMemory: scenario.previous ? '用户上轮发来一份人物介绍；已根据附件概括人物背景，等待用户追问。' : null,
  }, DEFAULT_ROUTER_MODELS.map(model => ({ model, router: createOpenApiSemanticRouter({ ...config, modelProvider: 'openrouter', model }, fetch, true) })));
  const execution = route.attachment ? attachmentExecutionModel('openrouter', attachments.selectedModel.model, route.attachment) : null;
  return { task: scenario.task, source: attachments.source, mime: attachments.files[0]!.mime,
    elapsedMs: Math.round(performance.now() - started), decision: route.attachment, catalogs: route.catalogs,
    diagnostics: route.diagnostics, execution,
    passed: route.diagnostics.strategy === 'semantic' && route.attachment?.intent === scenario.intent && route.attachment?.requiresVision === scenario.vision && (!scenario.model || execution?.model === scenario.model),
  };
}));
const report = { date: new Date().toISOString(), scope: 'Live unified semantic router only; synthetic metadata, no attachment bytes or knowledge-base writes.', reports };
await writeFile(new URL('./semantic-routing-probe.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (reports.some(result => !result.passed)) process.exitCode = 1;
