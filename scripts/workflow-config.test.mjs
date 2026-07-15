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
  assert.match(workflow, /AGENT_IMAGE=ghcr\.io\/\$\{repository\}-agent:\$\{GITHUB_SHA\}/)
  assert.match(workflow, /WEB_IMAGE=ghcr\.io\/\$\{repository\}-web:\$\{GITHUB_SHA\}/)
})

test("uses repository configuration and the scoped GitHub token for deployment", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci-cd.yml"), "utf8")

  assert.match(workflow, /DEPLOY_HOST: \$\{\{ vars\.DEPLOY_HOST \}\}/)
  assert.match(workflow, /uses: docker\/setup-qemu-action@v3/)
  assert.match(workflow, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/)
  assert.match(workflow, /OA_DOCKER_API_BASE_URL: \$\{\{ vars\.OA_DOCKER_API_BASE_URL \}\}/)
  assert.match(workflow, /GHCR_PULL_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(workflow, /bash scripts\/render-runtime-env\.sh/)
  assert.match(workflow, /push: \$\{\{ github\.event_name != 'pull_request' && \(github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/test'\) \}\}/)
  assert.doesNotMatch(workflow, /secrets\.GHCR_PULL_TOKEN/)
})

test("allows the server env to isolate Compose projects", async () => {
  const compose = await readFile(path.join(repoRoot, "compose.yml"), "utf8")
  assert.match(compose, /^name: \$\{COMPOSE_PROJECT_NAME:-oa-agent\}$/m)
})
