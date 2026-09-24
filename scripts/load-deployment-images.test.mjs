import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./load-deployment-images.sh', import.meta.url))
async function fixture(t, mode = 'success') {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-transfer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'bin'))
  const deployPath = path.join(dir, "server path's")
  for (const service of ['agent', 'web']) await writeFile(path.join(dir, `${service}.tar.gz`), gzipSync(`${service} image`))
  const commands = {
    // macOS sha256sum does not implement GNU checksum-file verification.
    ...(process.platform === 'darwin' ? { sha256sum: 'exec shasum -a 256 "$@"\n' } : {}),
    ssh: `printf '%s\\n' "$@" >> "$FIXTURE/ssh-options"
# Execute the actual remote command, including checksum checks and time limits.
test "\${!#}" = -s
bash -s
`,
    timeout: `printf '%s\\n' "$*" >> "$FIXTURE/timeouts"
shift 2
"$@"
`,
    rsync: `printf '%s\\n' "$@" >> "$FIXTURE/rsync-options"
count=0
if [[ -f "$FIXTURE/count" ]]; then count=$(cat "$FIXTURE/count"); fi
count=$((count + 1))
echo "$count" > "$FIXTURE/count"
source="\${@: -2:1}"
destination="\${!#}"
# --protect-args transmits the remote filename without shell interpretation.
destination="\${destination#*:}"
if [[ "$MODE" == disk ]]; then exit 11; fi
if [[ "$MODE" == fail || ( "$MODE" == retry && "$count" -eq 1 ) || ( "$MODE" == stall && "$count" -eq 1 ) ]]; then
  head -c 10 "$source" > "$destination"
  if [[ "$MODE" == stall ]]; then exit 30; fi
  exit 255
fi
if [[ ( "$MODE" == retry || "$MODE" == stall ) && "$count" -eq 2 ]]; then
  test "$(wc -c < "$destination" | tr -d ' ')" = 10
  echo resumed > "$FIXTURE/resumed"
fi
cp "$source" "$destination"
if [[ "$MODE" == corrupt-remote ]]; then printf corrupt > "$destination"; fi
`,
    docker: `if [[ "$1" == info ]]; then
  if [[ "$MODE" == daemon ]]; then exit 124; fi
  echo "$FIXTURE"
  exit 0
fi
test "$1" = load
test "$2" = --input
cat "$3" >> "$FIXTURE/loaded"
echo load >> "$FIXTURE/load-count"
if [[ "$MODE" == docker ]]; then exit 1; fi
if [[ "$MODE" == load-timeout ]]; then exit 124; fi
`,
    sleep: 'exit 0\n',
  }
  for (const [name, body] of Object.entries(commands)) {
    await writeFile(path.join(dir, 'bin', name), `#!/bin/bash\nset -eu\n${body}`, { mode: 0o700 })
  }
  return { dir, deployPath, run: () => spawnSync('bash', [script, dir], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`,
      DEPLOY_USER: 'deploy', DEPLOY_HOST: 'example.test', DEPLOY_PORT: '22', DEPLOY_PATH: deployPath, FIXTURE: dir, MODE: mode },
  }) }
}

for (const mode of ['success', 'retry', 'stall']) {
  test(`uploads, verifies, and loads both archives (${mode})`, async t => {
    const f = await fixture(t, mode)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(await readFile(path.join(f.dir, 'loaded')), Buffer.concat(await Promise.all(
      ['agent', 'web'].map(service => readFile(path.join(f.dir, `${service}.tar.gz`))),
    )))
    assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), mode === 'success' ? '2' : '3')
    if (mode !== 'success') assert.equal((await readFile(path.join(f.dir, 'resumed'), 'utf8')).trim(), 'resumed')
    const options = await readFile(path.join(f.dir, 'rsync-options'), 'utf8')
    for (const option of ['--partial', '--append-verify', '--protect-args', '--timeout=120', '--info=progress2']) assert.ok(options.includes(option))
    const ssh = await readFile(path.join(f.dir, 'ssh-options'), 'utf8')
    for (const option of ['ServerAliveInterval=15', 'ServerAliveCountMax=4', 'StrictHostKeyChecking=yes']) assert.ok(ssh.includes(option))
    const timeouts = await readFile(path.join(f.dir, 'timeouts'), 'utf8')
    assert.match(timeouts, /--kill-after=10s 1[12][0-9]{2}s rsync/)
    assert.match(timeouts, /--kill-after=10s 300s docker load --input/)
    assert.deepEqual(await readdir(path.join(f.deployPath, '.deployment-images')), [])
    assert.ok(result.stdout.indexOf('Uploading agent') < result.stdout.indexOf('Verifying agent'))
    assert.ok(result.stdout.indexOf('Verifying agent') < result.stdout.indexOf('Loading agent'))
  })
}

test('stops after three network failures and retains the partial file without loading it', async t => {
  const f = await fixture(t, 'fail')
  assert.equal(f.run().status, 255)
  assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '3')
  assert.equal((await readdir(path.join(f.deployPath, '.deployment-images'))).length, 1)
  await assert.rejects(readFile(path.join(f.dir, 'load-count')), { code: 'ENOENT' })
})

test('fails immediately on upload disk errors', async t => {
  const f = await fixture(t, 'disk')
  assert.equal(f.run().status, 11)
  assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '1')
  await assert.rejects(readFile(path.join(f.dir, 'load-count')), { code: 'ENOENT' })
})

for (const [mode, status] of [['docker', 1], ['load-timeout', 124]]) {
  test(`surfaces ${mode} without retransmitting or proceeding to web`, async t => {
    const f = await fixture(t, mode)
    const result = f.run()
    assert.equal(result.status, status, result.stderr)
    assert.match(result.stderr, /Upload is complete; check Docker daemon logs/)
    assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '1')
    assert.equal((await readFile(path.join(f.dir, 'load-count'), 'utf8')).trim(), 'load')
    assert.equal((await readdir(path.join(f.deployPath, '.deployment-images'))).length, 1)
  })
}

test('rejects a corrupted upload before Docker loads it', async t => {
  const f = await fixture(t, 'corrupt-remote')
  assert.notEqual(f.run().status, 0)
  await assert.rejects(readFile(path.join(f.dir, 'load-count')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(path.join(f.deployPath, '.deployment-images')), [])
})

test('detects an unresponsive Docker daemon before uploading', async t => {
  const f = await fixture(t, 'daemon')
  assert.equal(f.run().status, 124)
  await assert.rejects(readFile(path.join(f.dir, 'count')), { code: 'ENOENT' })
})

test('rejects corrupt or missing archives before contacting the server', async t => {
  for (const mode of ['corrupt', 'missing']) {
    const f = await fixture(t)
    if (mode === 'corrupt') await writeFile(path.join(f.dir, 'web.tar.gz'), 'invalid gzip')
    else await rm(path.join(f.dir, 'web.tar.gz'))
    assert.notEqual(f.run().status, 0)
    await assert.rejects(readFile(path.join(f.dir, 'ssh-options')), { code: 'ENOENT' })
  }
})
