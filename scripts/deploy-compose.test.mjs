import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const deployScript = path.join(repoRoot, "scripts", "deploy-compose.sh")

test("deploys immutable agent and web image tags", async (context) => {
  const fixture = await createFixture(context)
  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    await readFile(path.join(fixture.deployDir, ".deploy.env"), "utf8"),
    "AGENT_IMAGE=ghcr.io/example/oa-agent:abc123\nWEB_IMAGE=ghcr.io/example/oa-web:abc123\n",
  )

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.match(dockerLog, /pull agent web/)
  assert.match(dockerLog, /up -d --no-build --remove-orphans --wait --wait-timeout 180/)
})

test("restores the previous image tags when the new deployment fails", async (context) => {
  const fixture = await createFixture(context)
  const previous =
    "AGENT_IMAGE=ghcr.io/example/oa-agent:previous\n" +
    "WEB_IMAGE=ghcr.io/example/oa-web:previous\n"
  await writeFile(path.join(fixture.deployDir, ".deploy.env"), previous)

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:broken",
    webImage: "ghcr.io/example/oa-web:broken",
    failFirstUp: true,
  })

  assert.notEqual(result.status, 0)
  assert.equal(
    await readFile(path.join(fixture.deployDir, ".deploy.env"), "utf8"),
    previous,
  )

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.equal(dockerLog.match(/ up /g)?.length, 2)
  assert.equal(dockerLog.match(/ pull /g)?.length, 2)
})

async function createFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oa-deploy-test-"))
  context.after(() => rm(root, { recursive: true, force: true }))

  const binDir = path.join(root, "bin")
  const deployDir = path.join(root, "deployment")
  const logPath = path.join(root, "docker.log")
  const markerPath = path.join(root, "failed-once")
  await Promise.all([mkdir(binDir), mkdir(deployDir)])
  await writeFile(path.join(deployDir, ".env"), "AGENT_API_TOKEN=test-token\n")
  await writeFile(path.join(deployDir, "compose.yml"), "services: {}\n")

  const dockerPath = path.join(binDir, "docker")
  await writeFile(
    dockerPath,
    `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ " $* " == *" up "* ]] && [[ "\${MOCK_FAIL_FIRST_UP:-0}" == "1" ]] && [[ ! -e "$MOCK_DOCKER_MARKER" ]]; then
  touch "$MOCK_DOCKER_MARKER"
  exit 42
fi
`,
  )
  await chmod(dockerPath, 0o755)

  return { binDir, deployDir, logPath, markerPath }
}

function runDeploy(fixture, { agentImage, webImage, failFirstUp = false }) {
  return spawnSync(
    "bash",
    [deployScript, fixture.deployDir, agentImage, webImage],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        MOCK_DOCKER_LOG: fixture.logPath,
        MOCK_DOCKER_MARKER: fixture.markerPath,
        MOCK_FAIL_FIRST_UP: failFirstUp ? "1" : "0",
      },
    },
  )
}
