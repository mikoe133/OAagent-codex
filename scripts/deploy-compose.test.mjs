import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
  assert.equal((await stat(path.join(fixture.deployDir, ".deploy.env"))).mode & 0o777, 0o600)

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.match(dockerLog, /pull agent web/)
  assert.match(dockerLog, /up -d --no-build --remove-orphans --wait --wait-timeout 180/)
})

test("uses preloaded images without contacting the registry", async (context) => {
  const fixture = await createFixture(context)
  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
    skipImagePull: true,
  })

  assert.equal(result.status, 0, result.stderr)
  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.doesNotMatch(dockerLog, / pull /)
  assert.match(dockerLog, / up /)
})

test("retries a transient Docker port binding failure without removing volumes", async (context) => {
  const fixture = await createFixture(context)
  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
    failFirstUpWithPortConflict: true,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /port binding failed; resetting this Compose project before one retry/)

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.equal(dockerLog.match(/ up /g)?.length, 2)
  assert.equal(dockerLog.match(/ down --remove-orphans --timeout 30/g)?.length, 1)
  assert.doesNotMatch(dockerLog, / down .* (?:-v|--volumes)(?: |$)/)
})

test("rejects a runtime env without an explicit agent port", async (context) => {
  const fixture = await createFixture(context)
  await writeFile(
    path.join(fixture.deployDir, ".env"),
    "COMPOSE_PROJECT_NAME=oa-agent-test\nWEB_PORT=3001\n",
  )

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing AGENT_PORT in runtime environment/)
  assert.doesNotMatch(await readFile(fixture.logPath, "utf8"), / up /)
})

test("rejects agent and web services that share a host port", async (context) => {
  const fixture = await createFixture(context)
  await writeFile(
    path.join(fixture.deployDir, ".env"),
    "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3001\nWEB_PORT=3001\n",
  )

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AGENT_PORT and WEB_PORT must use different host ports/)
  assert.doesNotMatch(await readFile(fixture.logPath, "utf8"), / up /)
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
  assert.equal((await stat(path.join(fixture.deployDir, ".deploy.env"))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(fixture.deployDir, ".deploy.env.previous"))).mode & 0o777, 0o600)

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.equal(dockerLog.match(/ up /g)?.length, 2)
  assert.equal(dockerLog.match(/ pull /g)?.length, 2)
})

test("promotes a staged runtime env only when deployment succeeds", async (context) => {
  const fixture = await createFixture(context)
  const previousRuntime = "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3003\nWEB_PORT=3001\n"
  const nextRuntime = "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3013\nWEB_PORT=3011\n"
  await writeFile(path.join(fixture.deployDir, ".env"), previousRuntime)
  await writeFile(path.join(fixture.deployDir, ".env.next"), nextRuntime)

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:next",
    webImage: "ghcr.io/example/oa-web:next",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(path.join(fixture.deployDir, ".env"), "utf8"), nextRuntime)
  assert.equal(await readFile(path.join(fixture.deployDir, ".env.previous"), "utf8"), previousRuntime)
  assert.equal((await stat(path.join(fixture.deployDir, ".env"))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(fixture.deployDir, ".env.previous"))).mode & 0o777, 0o600)
})

test("restores the previous runtime env when deployment fails", async (context) => {
  const fixture = await createFixture(context)
  const previousRuntime = "COMPOSE_PROJECT_NAME=oa-agent-prod\nAGENT_PORT=3001\nWEB_PORT=3000\n"
  const nextRuntime = "COMPOSE_PROJECT_NAME=oa-agent-prod\nAGENT_PORT=3011\nWEB_PORT=3010\n"
  await writeFile(path.join(fixture.deployDir, ".env"), previousRuntime)
  await writeFile(path.join(fixture.deployDir, ".env.next"), nextRuntime)

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:broken",
    webImage: "ghcr.io/example/oa-web:broken",
    failFirstUp: true,
  })

  assert.notEqual(result.status, 0)
  assert.equal(await readFile(path.join(fixture.deployDir, ".env"), "utf8"), previousRuntime)
  assert.equal((await stat(path.join(fixture.deployDir, ".env"))).mode & 0o777, 0o600)
})

async function createFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oa-deploy-test-"))
  context.after(() => rm(root, { recursive: true, force: true }))

  const binDir = path.join(root, "bin")
  const deployDir = path.join(root, "deployment")
  const logPath = path.join(root, "docker.log")
  const markerPath = path.join(root, "failed-once")
  await Promise.all([mkdir(binDir), mkdir(deployDir)])
  await writeFile(
    path.join(deployDir, ".env"),
    "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3003\nWEB_PORT=3001\nOA_DOCKER_API_BASE_URL=http://oa.test\n",
  )
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
if [[ " $* " == *" up "* ]] && [[ "\${MOCK_FAIL_FIRST_UP_WITH_PORT_CONFLICT:-0}" == "1" ]] && [[ ! -e "$MOCK_DOCKER_MARKER" ]]; then
  touch "$MOCK_DOCKER_MARKER"
  echo "Error response from daemon: failed to bind host port: address already in use" >&2
  exit 42
fi
`,
  )
  await chmod(dockerPath, 0o755)

  return { binDir, deployDir, logPath, markerPath }
}

function runDeploy(fixture, {
  agentImage,
  webImage,
  failFirstUp = false,
  failFirstUpWithPortConflict = false,
  skipImagePull = false,
}) {
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
        MOCK_FAIL_FIRST_UP_WITH_PORT_CONFLICT: failFirstUpWithPortConflict ? "1" : "0",
        SKIP_IMAGE_PULL: skipImagePull ? "1" : "0",
      },
    },
  )
}
