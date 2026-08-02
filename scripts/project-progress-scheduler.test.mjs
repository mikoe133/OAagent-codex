import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("runs the production worker continuously as an isolated Compose service", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")
  const worker = compose.slice(
    compose.indexOf("  project-progress-worker:"),
    compose.indexOf("\n  web:"),
  )

  assert.match(worker, /command:\n      - node\n      - agent\/dist\/runtime\/projectProgressWorker\.js/)
  assert.match(worker, /PROJECT_PROGRESS_STATE_DB: \/app\/\.context\/project-progress\.sqlite/)
  assert.match(worker, /restart: unless-stopped/)
  assert.doesNotMatch(worker, /ports:|expose:/)
  assert.doesNotMatch(worker, /(?:TOKEN|API_KEY): [^$]/)
})

test("keeps the legacy systemd timer in one-shot mode", async () => {
  const service = await readFile(
    new URL("../deploy/systemd/oa-agent-project-progress.service", import.meta.url),
    "utf8",
  )
  assert.match(
    service,
    /project-progress-worker node agent\/dist\/runtime\/projectProgressWorker\.js --once/,
  )
})

test("polls OA-owned schedules every minute with single-instance protection", async () => {
  const timer = await readFile(
    path.join(repoRoot, "deploy/systemd/oa-agent-project-progress.timer"),
    "utf8",
  )
  const service = await readFile(
    path.join(repoRoot, "deploy/systemd/oa-agent-project-progress.service"),
    "utf8",
  )

  assert.match(timer, /OnBootSec=30s/)
  assert.match(timer, /OnUnitActiveSec=1min/)
  assert.match(timer, /Persistent=false/)
  assert.match(service, /flock --nonblock/)
  assert.match(service, /Restart=on-failure/)
  assert.match(service, /RestartSec=1min/)
  assert.match(service, /StartLimitBurst=5/)
  assert.match(service, /SyslogIdentifier=oa-agent-project-progress/)
  assert.doesNotMatch(service, /(?:TOKEN|API_KEY)=/)
})
