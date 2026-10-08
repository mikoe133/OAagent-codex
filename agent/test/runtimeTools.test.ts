import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { checkRuntimeTools } from '../scripts/checkRuntimeTools.mjs';

const execute = promisify(execFile);
const certificate = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';

test('the production Node parsers load through the same require API used by model commands', async () => {
  const result = await execute(process.execPath, ['scripts/checkRuntimeTools.mjs', '--node-only'], { cwd: new URL('..', import.meta.url), timeout: 10_000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check: any) => check.name), ['Node yaml', 'Node js-yaml']);
});

test('full image validation checks every required tool, both YAML alternatives and CA trust', async () => {
  const commands: Array<{ program: string; args: string[]; timeout: number }> = [];
  const result = await checkRuntimeTools({
    execute: async (program: string, args: string[], options: any) => { commands.push({ program, args, timeout: options.timeout }); },
    readCertificate: async (file: string) => { assert.equal(file, '/etc/ssl/certs/ca-certificates.crt'); return certificate; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check: any) => check.name), ['Node yaml', 'Node js-yaml', 'curl', 'python3', 'jq', 'ripgrep', 'wget', 'Python PyYAML', 'ca-certificates']);
  assert.equal(commands.length, 8);
  assert.ok(commands.every(command => command.timeout === 5000));
  assert.ok(commands.some(command => command.program === 'python3' && command.args[0] === '-c' && command.args[1].includes('yaml.safe_load')));
});

test('missing dependencies fail clearly, without retrying or leaking process output', async () => {
  let pythonAttempts = 0;
  const result = await checkRuntimeTools({
    execute: async (program: string, args: string[]) => {
      if (program === 'python3' && args[0] === '-c') { pythonAttempts++; throw new Error('private environment or stderr'); }
    },
    readCertificate: async () => '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(pythonAttempts, 1);
  assert.deepEqual(result.checks.filter((check: any) => check.status === 'error').map((check: any) => check.name), ['Python PyYAML', 'ca-certificates']);
  assert.doesNotMatch(JSON.stringify(result), /private environment|stderr/);
  assert.match(result.next_actions[0], /重新构建.*不要在聊天中/);
});
