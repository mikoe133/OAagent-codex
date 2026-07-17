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
  assert.match(workflow, /COMPOSE_PROJECT_NAME: oa-agent-test[\s\S]*WEB_PORT: '3001'/)
  assert.match(workflow, /COMPOSE_PROJECT_NAME: oa-agent-prod[\s\S]*WEB_PORT: '3010'/)
  assert.match(workflow, /AGENT_IMAGE=ghcr\.io\/\$\{repository\}-agent:\$\{GITHUB_SHA\}/)
  assert.match(workflow, /WEB_IMAGE=ghcr\.io\/\$\{repository\}-web:\$\{GITHUB_SHA\}/)
})

test("publishes release images and transfers private deployment artifacts", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci-cd.yml"), "utf8")

  assert.match(workflow, /DEPLOY_HOST: \$\{\{ vars\.DEPLOY_HOST \}\}/)
  assert.match(workflow, /uses: docker\/setup-qemu-action@v3/)
  assert.match(workflow, /NEXTTOKEN_API_KEY: \$\{\{ secrets\.NEXTTOKEN_API_KEY \}\}/)
  assert.match(workflow, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/)
  assert.match(workflow, /OA_DOCKER_API_BASE_URL: \$\{\{ vars\.OA_DOCKER_API_BASE_URL \}\}/)
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
})

test("limits container resources and log growth on the shared server", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")

  assert.equal(compose.match(/^    cpus: /gm)?.length, 2)
  assert.equal(compose.match(/^    mem_limit: /gm)?.length, 2)
  assert.equal(compose.match(/^    pids_limit: /gm)?.length, 2)
  assert.equal(compose.match(/^        max-size: 10m$/gm)?.length, 2)
  assert.equal(compose.match(/^        max-file: "3"$/gm)?.length, 2)
})
