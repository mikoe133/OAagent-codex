import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const renderScript = path.join(repoRoot, "scripts", "render-runtime-env.sh")
const obsoleteRuntimeEnvNames = [
  "AGENT_ACTIONS_ENABLED",
  "AGENT_ACTION_TTL_SECONDS",
  "AGENT_DEFAULT_MODE",
  "AGENT_MAX_STEPS",
  "AGENT_TOOL_TIMEOUT_MS",
  "AGENT_TOTAL_TIMEOUT_MS",
  "DATABASE_URL",
  "MODEL_TOOL_MODE",
  "OAAGENT_CLIENT_KEYS",
  "OA_API_token",
  "OA_TOOLS_ALLOW_WRITES",
  "OPENAI_AGENTS_DISABLE_TRACING",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_X_TITLE",
  "TRACE_DIR",
  "TRACE_RETENTION_DAYS",
]

test("keeps obsolete environment settings out of deployable configuration", async () => {
  const [exampleEnv, runtimeEnvRenderer] = await Promise.all([
    readFile(path.join(repoRoot, ".env.example"), "utf8"),
    readFile(renderScript, "utf8"),
  ])

  for (const name of obsoleteRuntimeEnvNames) {
    const assignment = new RegExp(`^${name}=`, "m")
    assert.doesNotMatch(exampleEnv, assignment)
    assert.doesNotMatch(runtimeEnvRenderer, new RegExp(`\\b${name}\\b`))
  }
})

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
    OA_AGENT_AUTOMATION_TOKEN: "test-automation-secret",
    PROJECT_PROGRESS_WORKER_INSTANCE: "oaagent-test-01",
    PROJECT_PROGRESS_LEASE_SECONDS: "300",
    PROJECT_PROGRESS_HEARTBEAT_SECONDS: "60",
    AGENT_PORT: "3003",
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
  assert.match(content, /^OA_PROJECT_SYNC_TOKEN=test-worker-secret$/m)
  assert.match(content, /^OA_PROJECT_SYNC_TOKEN_HEADER=Authorization$/m)
  assert.match(content, /^OA_PROJECT_SYNC_TOKEN_PREFIX=Bearer$/m)
  assert.match(content, /^PROJECT_PROGRESS_GITHUB_TOKEN=test-github-secret$/m)
  assert.match(content, /^PROJECT_PROGRESS_WORKER_INSTANCE=oaagent-test-01$/m)
  assert.match(content, /^PROJECT_PROGRESS_LEASE_SECONDS=300$/m)
  assert.match(content, /^PROJECT_PROGRESS_HEARTBEAT_SECONDS=60$/m)
  assert.match(content, /^PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS=12$/m)
  assert.match(content, /^PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT=20$/m)
  assert.match(content, /^PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE=1200$/m)
  assert.match(content, /^PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS=12000$/m)
  assert.match(content, /^PROJECT_PROGRESS_GITHUB_CONCURRENCY=6$/m)
  assert.match(content, /^PROJECT_PROGRESS_AGENT_CONCURRENCY=2$/m)
  assert.match(content, /^PROJECT_PROGRESS_OA_WRITE_CONCURRENCY=1$/m)
  assert.match(content, /^PROJECT_PROGRESS_WORKSPACE_ROOT=\/app\/\.context\/project-progress-workspaces$/m)
  assert.match(content, /^PROJECT_PROGRESS_WRITE_ENABLED=true$/m)
  assert.match(content, /^PROJECT_PROGRESS_PRODUCTION_WRITES=I_UNDERSTAND_PRODUCTION_WRITES$/m)
  assert.match(content, /^OA_AGENT_SSO_SHARED_SECRET=test-sso-secret$/m)
  assert.match(content, /^OA_AGENT_SSO_TTL_SECONDS=300$/m)
  assert.match(content, /^OA_AGENT_AUTOMATION_TOKEN=test-automation-secret$/m)
  assert.match(content, /^OA_API_TOKEN_HEADER=Cookie$/m)
  assert.match(content, /^OA_API_TOKEN_PREFIX=sessionid=$/m)
  assert.match(content, /^AGENT_BIND_ADDRESS=127\.0\.0\.1$/m)
  assert.match(content, /^AGENT_PORT=3003$/m)
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

test("rejects agent and web services that share a host port", async (context) => {
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
    AGENT_PORT: "3001",
    WEB_PORT: "3001",
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AGENT_PORT and WEB_PORT must use different host ports/)
})

function runRender(outputPath, overrides) {
  return spawnSync("bash", [renderScript, outputPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OA_AUTH_ALIAS: "default",
      OA_PROJECT_SYNC_TOKEN: "test-worker-secret",
      OA_PROJECT_SYNC_TOKEN_HEADER: "Authorization",
      OA_PROJECT_SYNC_TOKEN_PREFIX: "Bearer",
      PROJECT_PROGRESS_GITHUB_TOKEN: "test-github-secret",
      OA_AGENT_AUTOMATION_TOKEN: "test-automation-secret",
      AGENT_BIND_ADDRESS: "127.0.0.1",
      AGENT_PORT: "3003",
      WEB_BIND_ADDRESS: "127.0.0.1",
      ...overrides,
    },
  })
}
