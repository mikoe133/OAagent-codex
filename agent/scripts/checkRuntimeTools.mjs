#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const sample = 'openapi: 3.0.3\ninfo:\n  title: 运行工具检查\n  version: "1"\n';
const nodeSmoke = (module, method) => `const doc = require(${JSON.stringify(module)}).${method}(${JSON.stringify(sample)}); if (doc.openapi !== '3.0.3' || doc.info.title !== '运行工具检查') throw new Error('YAML parsing failed');`;
const pythonSmoke = `import yaml\ndoc = yaml.safe_load(${JSON.stringify(sample)})\nassert doc['openapi'] == '3.0.3' and doc['info']['title'] == '运行工具检查'`;

// Build-time smoke checks only. Do not call this in the per-message path.
// Injectable I/O lets tests simulate missing dependencies without modifying PATH.
export async function checkRuntimeTools({ nodeOnly = false, execute = executeFile, readCertificate = readFile } = {}) {
  const command = (program, args) => execute(program, args, { cwd: agentRoot, timeout: 5000, maxBuffer: 64 * 1024 });
  const probes = [
    ['Node yaml', () => command(process.execPath, ['-e', nodeSmoke('yaml', 'parse')])],
    ['Node js-yaml', () => command(process.execPath, ['-e', nodeSmoke('js-yaml', 'load')])],
  ];
  if (!nodeOnly) {
    for (const [name, program] of [['curl', 'curl'], ['python3', 'python3'], ['jq', 'jq'], ['ripgrep', 'rg'], ['wget', 'wget']]) {
      probes.push([name, () => command(program, ['--version'])]);
    }
    probes.push(['Python PyYAML', () => command('python3', ['-c', pythonSmoke])]);
    probes.push(['ca-certificates', async () => {
      const certificate = await readCertificate('/etc/ssl/certs/ca-certificates.crt', 'utf8');
      if (!certificate.includes('-----BEGIN CERTIFICATE-----')) throw new Error('CA bundle missing');
    }]);
  }
  const checks = await Promise.all(probes.map(async ([name, probe]) => {
    try { await probe(); return { name, status: 'success' }; }
    catch { return { name, status: 'error', summary: `${name} 不可用或检查失败` }; }
  }));
  const ok = checks.every(check => check.status === 'success');
  return { ok, status: ok ? 'success' : 'error', summary: ok ? '运行工具检查通过' : '运行镜像依赖不完整，不能发布', checks,
    next_actions: ok ? [] : ['修复失败项并重新构建运行镜像；不要在聊天中安装依赖或循环重试。'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--node-only')) {
    console.error('Usage: node scripts/checkRuntimeTools.mjs [--node-only]');
    process.exitCode = 1;
  } else {
    const result = await checkRuntimeTools({ nodeOnly: args.includes('--node-only') });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
