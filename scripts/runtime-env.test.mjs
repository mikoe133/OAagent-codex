import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const renderScript = path.join(repoRoot, "scripts", "render-runtime-env.sh")

test("renders a private runtime env for one isolated Compose environment", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-runtime-env-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, ".env")

  const result = runRender(outputPath, {
    COMPOSE_PROJECT_NAME: "oa-agent-test",
    NEXTTOKEN_API_KEY: "test-nexttoken-secret",
    NEXTTOKEN_API_BASE_URL: "https://next-token.cc",
    OPENROUTER_API_KEY: "test-openrouter-secret",
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OA_DOCKER_API_BASE_URL: "https://oa-test.example.com",
    OA_AGENT_SSO_SHARED_SECRET: "test-sso-secret",
    OA_AGENT_SSO_TTL_SECONDS: "300",
    WEB_PORT: "3001",
  })

  assert.equal(result.status, 0, result.stderr)
  const content = await readFile(outputPath, "utf8")
  assert.match(content, /^COMPOSE_PROJECT_NAME=oa-agent-test$/m)
  assert.match(content, /^NEXTTOKEN_API_KEY=test-nexttoken-secret$/m)
  assert.match(content, /^NEXTTOKEN_API_BASE_URL=https:\/\/next-token\.cc$/m)
  assert.match(content, /^OPENROUTER_API_KEY=test-openrouter-secret$/m)
  assert.match(content, /^OPENROUTER_API_BASE_URL=https:\/\/openrouter\.ai\/api\/v1$/m)
  assert.match(content, /^OA_DOCKER_API_BASE_URL=https:\/\/oa-test\.example\.com$/m)
  assert.match(content, /^OA_AGENT_SSO_SHARED_SECRET=test-sso-secret$/m)
  assert.match(content, /^OA_AGENT_SSO_TTL_SECONDS=300$/m)
  assert.match(content, /^OA_API_TOKEN_HEADER=Cookie$/m)
  assert.match(content, /^OA_API_TOKEN_PREFIX=sessionid=$/m)
  assert.match(content, /^WEB_BIND_ADDRESS=127\.0\.0\.1$/m)
  assert.match(content, /^WEB_PORT=3001$/m)
  assert.doesNotMatch(content, /^AGENT_API_TOKEN=/m)
  assert.doesNotMatch(content, /^OA_API_TOKEN=/m)

  const metadata = await stat(outputPath)
  assert.equal(metadata.mode & 0o777, 0o600)
})

test("rejects deployment values that could inject another env entry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-runtime-env-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, ".env")

  const result = runRender(outputPath, {
    COMPOSE_PROJECT_NAME: "oa-agent-test",
    NEXTTOKEN_API_KEY: "secret\nAGENT_API_TOKEN=injected",
    NEXTTOKEN_API_BASE_URL: "https://next-token.cc",
    OPENROUTER_API_KEY: "test-openrouter-secret",
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OA_DOCKER_API_BASE_URL: "https://oa-test.example.com",
    OA_AGENT_SSO_SHARED_SECRET: "test-sso-secret",
    OA_AGENT_SSO_TTL_SECONDS: "300",
    WEB_PORT: "3001",
  })

  assert.notEqual(result.status, 0)
})

test("rejects multiline OpenRouter credentials", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-runtime-env-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, ".env")

  const result = runRender(outputPath, {
    COMPOSE_PROJECT_NAME: "oa-agent-test",
    NEXTTOKEN_API_KEY: "test-nexttoken-secret",
    NEXTTOKEN_API_BASE_URL: "https://next-token.cc",
    OPENROUTER_API_KEY: "secret\nAGENT_API_TOKEN=injected",
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OA_DOCKER_API_BASE_URL: "https://oa-test.example.com",
    OA_AGENT_SSO_SHARED_SECRET: "test-sso-secret",
    OA_AGENT_SSO_TTL_SECONDS: "300",
    WEB_PORT: "3001",
  })

  assert.notEqual(result.status, 0)
})

test("rejects multiline SSO credentials", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-runtime-env-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, ".env")

  const result = runRender(outputPath, {
    COMPOSE_PROJECT_NAME: "oa-agent-test",
    NEXTTOKEN_API_KEY: "test-nexttoken-secret",
    NEXTTOKEN_API_BASE_URL: "https://next-token.cc",
    OPENROUTER_API_KEY: "test-openrouter-secret",
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OA_DOCKER_API_BASE_URL: "https://oa-test.example.com",
    OA_AGENT_SSO_SHARED_SECRET: "secret\nINJECTED=value",
    OA_AGENT_SSO_TTL_SECONDS: "300",
    WEB_PORT: "3001",
  })

  assert.notEqual(result.status, 0)
})

test("rejects an invalid SSO TTL", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-runtime-env-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, ".env")

  const result = runRender(outputPath, {
    COMPOSE_PROJECT_NAME: "oa-agent-test",
    NEXTTOKEN_API_KEY: "test-nexttoken-secret",
    NEXTTOKEN_API_BASE_URL: "https://next-token.cc",
    OPENROUTER_API_KEY: "test-openrouter-secret",
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OA_DOCKER_API_BASE_URL: "https://oa-test.example.com",
    OA_AGENT_SSO_SHARED_SECRET: "test-sso-secret",
    OA_AGENT_SSO_TTL_SECONDS: "0",
    WEB_PORT: "3001",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /OA_AGENT_SSO_TTL_SECONDS must be a positive integer/)
})

function runRender(outputPath, overrides) {
  return spawnSync("bash", [renderScript, outputPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OA_AUTH_ALIAS: "default",
      WEB_BIND_ADDRESS: "127.0.0.1",
      ...overrides,
    },
  })
}
