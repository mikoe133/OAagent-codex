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

test("prepares the GitHub App private key for the non-root runtime user", async (context) => {
  const fixture = await createFixture(context)
  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
    skipImagePull: true,
  })

  assert.equal(result.status, 0, result.stderr)
  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.match(
    dockerLog,
    /run --rm --user 0:0 --entrypoint \/bin\/sh --mount type=bind,src=.*project-progress-github-app-private-key\.pem,dst=\/run\/project-progress-github-app-private-key\.pem ghcr\.io\/example\/oa-agent:abc123/,
  )
  assert.match(dockerLog, /chown .*project-progress-github-app-private-key\.pem/)
  assert.match(dockerLog, /chmod 0400 .*project-progress-github-app-private-key\.pem/)
})

test("rejects deployment when the GitHub App private key is missing", async (context) => {
  const fixture = await createFixture(context)
  await rm(path.join(fixture.deployDir, ".secrets"), { recursive: true, force: true })

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:abc123",
    webImage: "ghcr.io/example/oa-web:abc123",
    skipImagePull: true,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing GitHub App private key/)
  assert.doesNotMatch(await readFile(fixture.logPath, "utf8"), / up /)
})

test("removes stale release images while preserving both environments' rollback images", async (context) => {
  const fixture = await createFixture(context)
  const currentSha = "a".repeat(40)
  const previousSha = "b".repeat(40)
  const productionSha = "c".repeat(40)
  const productionPreviousSha = "d".repeat(40)
  const staleSha = "e".repeat(40)
  const agentRepository = "ghcr.io/example/oa-agent"
  const webRepository = "ghcr.io/example/oa-web"

  await writeFile(
    path.join(fixture.deployDir, ".deploy.env"),
    `AGENT_IMAGE=${agentRepository}:${previousSha}\nWEB_IMAGE=${webRepository}:${previousSha}\n`,
  )

  const productionDir = path.join(fixture.root, "production")
  await mkdir(productionDir)
  await writeFile(
    path.join(productionDir, ".deploy.env"),
    `AGENT_IMAGE=${agentRepository}:${productionSha}\nWEB_IMAGE=${webRepository}:${productionSha}\n`,
  )
  await writeFile(
    path.join(productionDir, ".deploy.env.previous"),
    `AGENT_IMAGE=${agentRepository}:${productionPreviousSha}\nWEB_IMAGE=${webRepository}:${productionPreviousSha}\n`,
  )
  await writeFile(
    fixture.imagesPath,
    [
      `${agentRepository}:${currentSha}`,
      `${agentRepository}:${previousSha}`,
      `${agentRepository}:${productionSha}`,
      `${agentRepository}:${productionPreviousSha}`,
      `${agentRepository}:${staleSha}`,
      `${agentRepository}:stable`,
      `${webRepository}:${currentSha}`,
      `${webRepository}:${previousSha}`,
      `${webRepository}:${productionSha}`,
      `${webRepository}:${productionPreviousSha}`,
      `${webRepository}:${staleSha}`,
    ].join("\n") + "\n",
  )

  const result = runDeploy(fixture, {
    agentImage: `${agentRepository}:${currentSha}`,
    webImage: `${webRepository}:${currentSha}`,
    skipImagePull: true,
  })

  assert.equal(result.status, 0, result.stderr)
  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.equal(dockerLog.match(/image rm /g)?.length, 2)
  assert.match(dockerLog, new RegExp(`image rm ${agentRepository}:${staleSha}`))
  assert.match(dockerLog, new RegExp(`image rm ${webRepository}:${staleSha}`))
  for (const retainedSha of [currentSha, previousSha, productionSha, productionPreviousSha]) {
    assert.doesNotMatch(dockerLog, new RegExp(`image rm .*:${retainedSha}`))
  }
  assert.doesNotMatch(dockerLog, /image rm .*:stable/)
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

test("restores previous image tags before rejecting an invalid rollback runtime env", async (context) => {
  const fixture = await createFixture(context)
  const previousImages =
    "AGENT_IMAGE=ghcr.io/example/oa-agent:previous\n" +
    "WEB_IMAGE=ghcr.io/example/oa-web:previous\n"
  const previousRuntime = "COMPOSE_PROJECT_NAME=oa-agent-test\nWEB_PORT=3001\n"
  const nextRuntime = "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3003\nWEB_PORT=3001\n"
  await writeFile(path.join(fixture.deployDir, ".deploy.env"), previousImages)
  await writeFile(path.join(fixture.deployDir, ".env"), previousRuntime)
  await writeFile(path.join(fixture.deployDir, ".env.next"), nextRuntime)

  const result = runDeploy(fixture, {
    agentImage: "ghcr.io/example/oa-agent:broken",
    webImage: "ghcr.io/example/oa-web:broken",
    failFirstUp: true,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /rollback runtime environment is invalid/)
  assert.equal(await readFile(path.join(fixture.deployDir, ".deploy.env"), "utf8"), previousImages)
  assert.equal(await readFile(path.join(fixture.deployDir, ".env"), "utf8"), previousRuntime)

  const dockerLog = await readFile(fixture.logPath, "utf8")
  assert.equal(dockerLog.match(/ up /g)?.length, 1)
})

async function createFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oa-deploy-test-"))
  context.after(() => rm(root, { recursive: true, force: true }))

  const binDir = path.join(root, "bin")
  const deployDir = path.join(root, "deployment")
  const logPath = path.join(root, "docker.log")
  const markerPath = path.join(root, "failed-once")
  const imagesPath = path.join(root, "docker-images")
  await Promise.all([mkdir(binDir), mkdir(deployDir)])
  await mkdir(path.join(deployDir, ".secrets"))
  await writeFile(
    path.join(deployDir, ".secrets", "project-progress-github-app-private-key.pem"),
    "test-private-key\n",
  )
  await writeFile(
    path.join(deployDir, ".env"),
    "COMPOSE_PROJECT_NAME=oa-agent-test\nAGENT_PORT=3003\nWEB_PORT=3001\nOA_DOCKER_API_BASE_URL=http://oa.test\n",
  )
  await writeFile(path.join(deployDir, "compose.yml"), "services: {}\n")
  await writeFile(imagesPath, "")

  const dockerPath = path.join(binDir, "docker")
  await writeFile(
    dockerPath,
    `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == "image" && "$2" == "ls" ]]; then
  while IFS= read -r image; do
    if [[ "$image" == "$3:"* ]]; then
      printf '%s\n' "$image"
    fi
  done < "$MOCK_DOCKER_IMAGES"
  exit 0
fi
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

  return { root, binDir, deployDir, logPath, markerPath, imagesPath }
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
        MOCK_DOCKER_IMAGES: fixture.imagesPath,
        MOCK_FAIL_FIRST_UP: failFirstUp ? "1" : "0",
        MOCK_FAIL_FIRST_UP_WITH_PORT_CONFLICT: failFirstUpWithPortConflict ? "1" : "0",
        SKIP_IMAGE_PULL: skipImagePull ? "1" : "0",
      },
    },
  )
}
