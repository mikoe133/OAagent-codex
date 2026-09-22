import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
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
  for (const service of ['agent', 'web']) await writeFile(path.join(dir, `${service}.tar.gz`), gzipSync(`${service} image`))
  await writeFile(path.join(dir, 'bin', 'ssh'), `#!/bin/bash
set -eu
count=0
if [[ -f "$FIXTURE/count" ]]; then count=$(cat "$FIXTURE/count"); fi
count=$((count + 1))
echo "$count" > "$FIXTURE/count"
printf '%s\\n' "$@" > "$FIXTURE/options"
cat > "$FIXTURE/input-$count"
if [[ "$MODE" == fail || ( "$MODE" == retry && "$count" -eq 1 ) ]]; then exit 255; fi
if [[ "$MODE" == docker ]]; then exit 1; fi
`, { mode: 0o700 })
  await writeFile(path.join(dir, 'bin', 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o700 })
  return { dir, run: () => spawnSync('bash', [script, dir], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`,
      DEPLOY_USER: 'deploy', DEPLOY_HOST: 'example.test', DEPLOY_PORT: '22', FIXTURE: dir, MODE: mode },
  }) }
}

test('loads compressed archives with SSH keepalive and retries the same complete archive after disconnect', async t => {
  const f = await fixture(t, 'retry')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '3')
  for (const attempt of [1, 2]) assert.deepEqual(await readFile(path.join(f.dir, `input-${attempt}`)), await readFile(path.join(f.dir, 'agent.tar.gz')))
  assert.deepEqual(await readFile(path.join(f.dir, 'input-3')), await readFile(path.join(f.dir, 'web.tar.gz')))
  const options = await readFile(path.join(f.dir, 'options'), 'utf8')
  assert.match(options, /ServerAliveInterval=15/)
  assert.match(options, /ServerAliveCountMax=4/)
  assert.match(options, /StrictHostKeyChecking=yes/)
  assert.match(options, /docker\nload/)
})

test('stops after three SSH failures without proceeding to the next image', async t => {
  const f = await fixture(t, 'fail')
  assert.equal(f.run().status, 255)
  assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '3')
  assert.deepEqual(await readFile(path.join(f.dir, 'input-3')), await readFile(path.join(f.dir, 'agent.tar.gz')))
})

test('surfaces docker load failures without retrying them as network errors', async t => {
  const f = await fixture(t, 'docker')
  assert.equal(f.run().status, 1)
  assert.equal((await readFile(path.join(f.dir, 'count'), 'utf8')).trim(), '1')
})

test('rejects corrupt or missing archives before contacting the server', async t => {
  for (const mode of ['corrupt', 'missing']) {
    const f = await fixture(t)
    if (mode === 'corrupt') await writeFile(path.join(f.dir, 'web.tar.gz'), 'invalid gzip')
    else await rm(path.join(f.dir, 'web.tar.gz'))
    assert.notEqual(f.run().status, 0)
    await assert.rejects(readFile(path.join(f.dir, 'count')), { code: 'ENOENT' })
  }
})
