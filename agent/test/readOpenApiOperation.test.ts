import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const execute = promisify(execFile);
const options = { cwd: new URL('..', import.meta.url), timeout: 10_000 };
test('reads only the selected knowledge-base operation and expands request-body references', async () => {
  const { stdout } = await execute(process.execPath, ['scripts/readOpenApiOperation.mjs', '--file', 'knowledgebaseapi/knowledgebaseapi.yaml', '--operationId', 'createKnowledgeBaseNode'], options);
  const result = JSON.parse(stdout);
  assert.equal(result.operationId, 'createKnowledgeBaseNode');
  assert.equal(result.method, 'post');
  const schema = result.requestBody.content['application/json'].schema;
  assert.ok(schema.properties.title);
  assert.ok(schema.required.includes('title'));
  assert.equal(schema.$ref, undefined);
  assert.doesNotMatch(stdout, /uploadKnowledgeBaseAttachment|listKnowledgeBaseChildren/);
});
test('a missing operation fails clearly without dumping the full contract', async () => {
  await assert.rejects(execute(process.execPath, ['scripts/readOpenApiOperation.mjs', '--file', 'knowledgebaseapi/knowledgebaseapi.yaml', '--operationId', 'doesNotExist'], options), (error: any) => error.code === 1 && !error.stdout && /必须唯一且存在/.test(error.stderr));
});

test('includes inherited parameters, honors operation overrides and expands escaped references', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'read-openapi-operation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'contract.json');
  await writeFile(file, JSON.stringify({ openapi: '3.0.3', paths: { '/pages/{id}': {
    parameters: [{ $ref: '#/components/parameters/Page~1Id' }, { name: 'version', in: 'query', required: false, schema: { type: 'integer' } }],
    patch: { operationId: 'updatePage', parameters: [{ name: 'version', in: 'query', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } },
  } }, components: { parameters: { 'Page/Id': { name: 'id', in: 'path', required: true, schema: { type: 'string' } } }, schemas: { Page: { type: 'object', properties: { title: { type: 'string' }, child: { $ref: '#/components/schemas/Page' } } } } } }));
  const { stdout } = await execute(process.execPath, ['scripts/readOpenApiOperation.mjs', '--file', file, '--operationId', 'updatePage'], options);
  const result = JSON.parse(stdout);
  assert.equal(result.parameters.length, 2);
  assert.equal(result.parameters.find((parameter: any) => parameter.name === 'id').required, true);
  assert.equal(result.parameters.find((parameter: any) => parameter.name === 'version').required, true);
  const schema = result.requestBody.content['application/json'].schema;
  assert.equal(schema.properties.title.type, 'string');
  assert.equal(schema.properties.child.$ref, '#/components/schemas/Page', 'recursive references remain bounded');
});
