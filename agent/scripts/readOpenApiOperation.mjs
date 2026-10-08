#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { stringifyJsonLineSafe } from './jsonLineSafe.mjs';

try {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const file = value('--file'), operationId = value('--operationId');
  if (!file || !operationId) throw new Error('Usage: node scripts/readOpenApiOperation.mjs --file <当前接口文档> --operationId <operationId>');
  const document = parse(await readFile(file, 'utf8'));
  const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  const found = [];
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (httpMethods.has(method) && operation?.operationId === operationId) found.push({ path, method, operation, sharedParameters: methods.parameters });
    }
  }
  if (found.length !== 1) throw new Error(`operationId 必须唯一且存在: ${operationId}`);
  function expand(value, seen = new Set(), depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return value;
    if (Array.isArray(value)) return value.map(item => expand(item, seen, depth + 1));
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/') && !seen.has(value.$ref)) {
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document);
      if (!target) throw new Error(`缺少引用: ${value.$ref}`);
      return expand({ ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) }, new Set([...seen, value.$ref]), depth + 1);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, seen, depth + 1)]));
  }
  const { path, method, operation, sharedParameters } = found[0];
  // Path-level parameters apply to the operation too. Expand references before
  // merging; an operation's same-name/location parameter overrides its parent.
  const parameters = new Map();
  for (const parameter of [...(Array.isArray(sharedParameters) ? sharedParameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
    const resolved = expand(parameter);
    parameters.set(JSON.stringify([resolved.in, resolved.name]), resolved);
  }
  const result = { operationId, path, method, ...expand(operation), ...(parameters.size ? { parameters: [...parameters.values()] } : {}) };
  if (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024) throw new Error('接口定义过大，请读取更小的定义范围');
  console.log(stringifyJsonLineSafe(result, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : '读取接口定义失败');
  process.exitCode = 1;
}
