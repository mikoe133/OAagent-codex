import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("maps test and main branches to their deployment environments", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci-cd.yml"), "utf8")

  assert.match(workflow, /push:\n    branches:\n      - main\n      - test/)
  assert.match(workflow, /^  deploy-test:$/m)
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/test' && github\.event_name != 'pull_request'$/m)
  assert.match(workflow, /^      name: test$/m)
  assert.match(workflow, /^  deploy-production:$/m)
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'$/m)
  assert.match(workflow, /^      name: production$/m)
  assert.equal(workflow.match(/^    needs: images$/gm)?.length, 2)
  assert.doesNotMatch(workflow, /^    needs: deploy-test$/m)
  assert.match(workflow, /oa-agent-test[\s\S]*oa-agent-prod/)
  assert.match(workflow, /COMPOSE_PROJECT_NAME: oa-agent-test[\s\S]*AGENT_PORT: '3003'[\s\S]*WEB_PORT: '3001'/)
  assert.match(workflow, /COMPOSE_PROJECT_NAME: oa-agent-prod[\s\S]*AGENT_PORT: '3011'[\s\S]*WEB_PORT: '3010'/)
  assert.match(workflow, /AGENT_IMAGE=ghcr\.io\/\$\{repository\}-agent:\$\{GITHUB_SHA\}/)
  assert.match(workflow, /WEB_IMAGE=ghcr\.io\/\$\{repository\}-web:\$\{GITHUB_SHA\}/)
})

test("publishes release images and transfers private deployment artifacts", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci-cd.yml"), "utf8")

  assert.equal(workflow.match(/DEPLOY_HOST: \$\{\{ secrets\.DEPLOY_HOST \}\}/g)?.length, 2)
  assert.equal(workflow.match(/DEPLOY_USER: \$\{\{ secrets\.DEPLOY_USER \}\}/g)?.length, 2)
  assert.doesNotMatch(workflow, /DEPLOY_(?:HOST|USER): \$\{\{ vars\./)
  assert.match(workflow, /uses: docker\/setup-qemu-action@v3/)
  assert.match(workflow, /NEXTTOKEN_API_KEY: \$\{\{ secrets\.NEXTTOKEN_API_KEY \}\}/)
  assert.match(workflow, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/)
  assert.equal(workflow.match(/OA_PROJECT_SYNC_TOKEN: \$\{\{ secrets\.OA_PROJECT_SYNC_TOKEN \}\}/g)?.length, 2)
  assert.equal(workflow.match(/PROJECT_PROGRESS_GITHUB_TOKEN: \$\{\{ secrets\.PROJECT_PROGRESS_GITHUB_TOKEN \}\}/g)?.length, 2)
  assert.equal(workflow.match(/PROJECT_PROGRESS_GITHUB_CONCURRENCY: \$\{\{ vars\.PROJECT_PROGRESS_GITHUB_CONCURRENCY \|\| '6' \}\}/g)?.length, 2)
  assert.equal(workflow.match(/PROJECT_PROGRESS_AGENT_CONCURRENCY: \$\{\{ vars\.PROJECT_PROGRESS_AGENT_CONCURRENCY \|\| '2' \}\}/g)?.length, 2)
  assert.equal(workflow.match(/PROJECT_PROGRESS_OA_WRITE_CONCURRENCY: \$\{\{ vars\.PROJECT_PROGRESS_OA_WRITE_CONCURRENCY \|\| '1' \}\}/g)?.length, 2)
  assert.equal(workflow.match(/AGENT_BIND_ADDRESS: \$\{\{ vars\.AGENT_BIND_ADDRESS \|\| '127\.0\.0\.1' \}\}/g)?.length, 2)
  assert.match(workflow, /OA_DOCKER_API_BASE_URL: \$\{\{ vars\.OA_DOCKER_API_BASE_URL \}\}/)
  assert.equal(workflow.match(/OA_AGENT_SSO_SHARED_SECRET: \$\{\{ secrets\.OA_AGENT_SSO_SHARED_SECRET \}\}/g)?.length, 2)
  assert.equal(workflow.match(/OA_AGENT_AUTOMATION_TOKEN: \$\{\{ secrets\.OA_AGENT_AUTOMATION_TOKEN \}\}/g)?.length, 2)
  assert.equal(workflow.match(/OA_AGENT_SSO_TTL_SECONDS: \$\{\{ vars\.OA_AGENT_SSO_TTL_SECONDS \}\}/g)?.length, 2)
  assert.equal(workflow.match(/OA_DOCKER_API_BASE_URL OA_AGENT_SSO_SHARED_SECRET OA_AGENT_SSO_TTL_SECONDS OA_AGENT_AUTOMATION_TOKEN OA_PROJECT_SYNC_TOKEN PROJECT_PROGRESS_GITHUB_TOKEN; do/g)?.length, 2)
  assert.match(workflow, /bash scripts\/render-runtime-env\.sh/)
  assert.match(workflow, /push: \$\{\{ github\.event_name != 'pull_request' && \(github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/test'\) \}\}/)
  assert.match(workflow, /uses: actions\/upload-artifact@v4/)
  assert.equal(workflow.match(/uses: actions\/download-artifact@v4/g)?.length, 2)
  assert.equal(workflow.match(/gzip -dc "\$archive" \| ssh .* docker load/g)?.length, 2)
  assert.equal(workflow.match(/SKIP_IMAGE_PULL=1 bash -s/g)?.length, 2)
  assert.doesNotMatch(workflow, /GHCR_PULL_TOKEN/)
  assert.doesNotMatch(workflow, /docker login ghcr\.io/)
})

test("allows the server env to isolate Compose projects", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")
  assert.match(compose, /^name: \$\{COMPOSE_PROJECT_NAME:-oa-agent\}$/m)
  assert.match(compose, /\$\{AGENT_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{AGENT_PORT:-3001\}:3000/)
})

test("injects SSO configuration into the web container at runtime", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8")
  const webService = compose.slice(compose.indexOf("  web:"), compose.indexOf("\nvolumes:"))

  assert.match(webService, /^      OA_AGENT_SSO_SHARED_SECRET: \$\{OA_AGENT_SSO_SHARED_SECRET\}$/m)
  assert.match(webService, /^      OA_AGENT_SSO_TTL_SECONDS: \$\{OA_AGENT_SSO_TTL_SECONDS\}$/m)
  assert.doesNotMatch(dockerfile, /OA_AGENT_SSO_(?:SHARED_SECRET|TTL_SECONDS)/)
})

test("limits container resources and log growth on the shared server", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")

  assert.equal(compose.match(/^    cpus: /gm)?.length, 3)
  assert.equal(compose.match(/^    mem_limit: /gm)?.length, 3)
  assert.equal(compose.match(/^    pids_limit: /gm)?.length, 3)
  assert.equal(compose.match(/^        max-size: 10m$/gm)?.length, 3)
  assert.equal(compose.match(/^        max-file: "3"$/gm)?.length, 3)
  const workerService = compose.slice(
    compose.indexOf("  project-progress-worker:"),
    compose.indexOf("\n  web:"),
  )
  assert.match(workerService, /^    cpus: 2\.0$/m)
  assert.match(workerService, /^    mem_limit: 3g$/m)
  assert.match(workerService, /^    pids_limit: 256$/m)
})

test("uses Docker as the Codex command isolation boundary", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")

  assert.match(compose, /^      CODEX_SANDBOX_MODE: danger-full-access$/m)
  assert.match(compose, /^      - no-new-privileges:true$/m)
  assert.match(compose, /^    cap_drop:\n      - ALL$/m)
})

test("provides Python for Codex commands in the agent runtime image", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8")
  const agentRuntime = dockerfile.slice(
    dockerfile.indexOf("FROM ${NODE_IMAGE} AS agent-runtime"),
    dockerfile.indexOf("FROM manifests AS web-build"),
  )

  assert.match(agentRuntime, /apt-get install[\s\S]*\bpython3\b/)
})
