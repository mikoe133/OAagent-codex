import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProjectProgressConfig } from "../src/config/projectProgressConfig.js";

describe("loadProjectProgressConfig", () => {
  it("uses dedicated OA worker authentication settings", () => {
    const config = loadProjectProgressConfig(
      {
        OA_API_BASE_URL: "https://oa.example.test",
        AUTOMATION_API_BASE_URL: "https://automation.example.test",
        PROJECT_SYNC_API_BASE_URL: "https://project-sync.example.test",
        OA_AUTH_ALIAS: "production",
        OA_API_TOKEN_HEADER: "Cookie",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        OA_PROJECT_SYNC_TOKEN_HEADER: "X-Worker-Token",
        OA_PROJECT_SYNC_TOKEN_PREFIX: "Token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
      },
      "/srv/oa-agent",
    );

    assert.equal(config.oa.baseUrl, "https://project-sync.example.test");
    assert.equal(config.automation.baseUrl, "https://automation.example.test");
    assert.equal(config.oa.tokenHeader, "X-Worker-Token");
    assert.equal(config.oa.tokenPrefix, "Token");
    assert.equal(config.oa.token, "worker-token");
    assert.equal(config.stateDatabasePath, "/srv/oa-agent/.context/project-progress.sqlite");
    assert.equal(config.writeEnabled, false);
    assert.equal(config.writeAuthorization, "disabled");
    assert.equal(config.automation.leaseSeconds, 300);
    assert.equal(config.automation.heartbeatSeconds, 10);
    assert.deepEqual(config.concurrency, {
      github: 6,
      agent: 2,
      oaWrite: 1,
    });
    assert.equal(
      config.workspaceRoot,
      "/srv/oa-agent/.context/project-progress-workspaces",
    );
    assert.deepEqual(config.agent, {
      maxCandidateCommits: 50,
      maxDetailCalls: 12,
      maxFilesPerCommit: 20,
      maxFilenameChars: 240,
      maxPatchCharsPerFile: 1_200,
      maxTotalPatchChars: 12_000,
    });
  });

  it("can run the worker with split automation and project sync base urls", () => {
    const config = loadProjectProgressConfig(
      {
        AUTOMATION_API_BASE_URL: "https://automation-node.example.test",
        PROJECT_SYNC_API_BASE_URL: "https://old-oa.example.test",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        OA_AGENT_AUTOMATION_TOKEN: "automation-token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
      },
      "/srv/oa-agent",
    );

    assert.equal(config.automation.baseUrl, "https://automation-node.example.test");
    assert.equal(config.oa.baseUrl, "https://old-oa.example.test");
  });

  it("keeps OA_API_BASE_URL as the compatibility fallback", () => {
    const config = loadProjectProgressConfig(
      {
        OA_API_BASE_URL: "https://legacy-oa.example.test",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
      },
      "/srv/oa-agent",
    );

    assert.equal(config.automation.baseUrl, "https://legacy-oa.example.test");
    assert.equal(config.oa.baseUrl, "https://legacy-oa.example.test");
  });

  it("rejects test writes without an explicit unsafe acknowledgement", () => {
    assert.throws(
      () => loadProjectProgressConfig({
        OA_API_BASE_URL: "http://127.0.0.1:3002",
        PROJECT_PROGRESS_WRITE_ENABLED: "true",
      }, "/tmp"),
      /UNSAFE_TEST_WRITES/,
    );
  });

  it("allows explicitly acknowledged writes only through a loopback OA service", () => {
    const environment = {
      OA_API_BASE_URL: "http://127.0.0.1:3002",
      OA_PROJECT_SYNC_TOKEN: "worker-token",
      PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
      NEXTTOKEN_API_KEY: "model-token",
      PROJECT_PROGRESS_WRITE_ENABLED: "true",
      PROJECT_PROGRESS_UNSAFE_TEST_WRITES: "I_UNDERSTAND_TEST_ONLY",
    };

    const config = loadProjectProgressConfig(environment, "/tmp");
    assert.equal(config.writeEnabled, true);
    assert.equal(config.writeAuthorization, "unsafe-test");
    assert.throws(
      () => loadProjectProgressConfig(
        { ...environment, OA_API_BASE_URL: "https://oa.example.com" },
        "/tmp",
      ),
      /loopback/,
    );
  });

  it("allows production writes only with the production acknowledgement", () => {
    const environment = {
      OA_API_BASE_URL: "https://oa.example.com",
      OA_PROJECT_SYNC_TOKEN: "worker-token",
      PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
      NEXTTOKEN_API_KEY: "model-token",
      PROJECT_PROGRESS_WRITE_ENABLED: "true",
      PROJECT_PROGRESS_PRODUCTION_WRITES: "I_UNDERSTAND_PRODUCTION_WRITES",
    };

    const config = loadProjectProgressConfig(environment, "/tmp");
    assert.equal(config.writeAuthorization, "production");
    assert.throws(
      () => loadProjectProgressConfig({
        ...environment,
        PROJECT_PROGRESS_UNSAFE_TEST_WRITES: "I_UNDERSTAND_TEST_ONLY",
      }, "/tmp"),
      /只能选择一种写入确认/,
    );
  });

  it("selects an OA-configured OpenRouter model and validated parameters", () => {
    const config = loadProjectProgressConfig(
      {
        OA_API_BASE_URL: "https://oa.example.com",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "nexttoken-key",
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_API_BASE_URL: "https://openrouter.example/v1",
      },
      "/tmp",
      {
        modelProvider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        modelParameters: {
          reasoning_effort: "high",
          max_output_tokens: 1_024,
        },
      },
    );

    assert.deepEqual(config.model, {
      provider: "openrouter",
      apiBaseUrl: "https://openrouter.example/v1",
      apiKey: "openrouter-key",
      model: "moonshotai/kimi-k3",
      parameters: {
        reasoning_effort: "high",
        max_output_tokens: 1_024,
      },
    });
  });

  it("rejects unavailable worker models instead of silently switching", () => {
    assert.throws(
      () => loadProjectProgressConfig(
        {
          OA_API_BASE_URL: "https://oa.example.com",
          OA_PROJECT_SYNC_TOKEN: "worker-token",
          PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
          OPENROUTER_API_KEY: "openrouter-key",
        },
        "/tmp",
        {
          modelProvider: "openrouter",
          modelId: "gpt-5.6-terra",
        },
      ),
      /不支持模型/,
    );
  });

  it("validates booleans, headers, and required credentials", () => {
    assert.throws(
      () => loadProjectProgressConfig({ PROJECT_PROGRESS_WRITE_ENABLED: "yes" }, "/tmp"),
      /true 或 false/,
    );
    assert.throws(
      () => loadProjectProgressConfig({
        OA_API_BASE_URL: "http://127.0.0.1:3002",
        OA_PROJECT_SYNC_TOKEN_HEADER: "bad header",
      }, "/tmp"),
      /合法 header/,
    );
    assert.throws(
      () => loadProjectProgressConfig({ OA_API_BASE_URL: "http://127.0.0.1:3002" }, "/tmp"),
      /OA_PROJECT_SYNC_TOKEN/,
    );
    assert.throws(
      () => loadProjectProgressConfig({
        OA_API_BASE_URL: "http://127.0.0.1:3002",
        PROJECT_PROGRESS_LEASE_SECONDS: "60",
        PROJECT_PROGRESS_HEARTBEAT_SECONDS: "60",
      }, "/tmp"),
      /必须小于租约秒数/,
    );
    assert.throws(
      () => loadProjectProgressConfig({
        OA_API_BASE_URL: "http://127.0.0.1:3002",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
        PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE: "2000",
        PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS: "1000",
      }, "/tmp"),
      /不能小于单文件 Patch 上限/,
    );
    assert.throws(
      () => loadProjectProgressConfig({
        OA_API_BASE_URL: "http://127.0.0.1:3002",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
        PROJECT_PROGRESS_OA_WRITE_CONCURRENCY: "2",
      }, "/tmp"),
      /OA_WRITE_CONCURRENCY.*必须为 1/,
    );
  });

  it("loads explicit repository concurrency and workspace settings", () => {
    const config = loadProjectProgressConfig({
      OA_API_BASE_URL: "https://oa.example.test",
      OA_PROJECT_SYNC_TOKEN: "worker-token",
      PROJECT_PROGRESS_GITHUB_TOKEN: "github-token",
      NEXTTOKEN_API_KEY: "model-token",
      PROJECT_PROGRESS_GITHUB_CONCURRENCY: "8",
      PROJECT_PROGRESS_AGENT_CONCURRENCY: "3",
      PROJECT_PROGRESS_OA_WRITE_CONCURRENCY: "1",
      PROJECT_PROGRESS_WORKSPACE_ROOT: "/var/lib/oaagent/workspaces",
    }, "/srv/oa-agent");

    assert.deepEqual(config.concurrency, {
      github: 8,
      agent: 3,
      oaWrite: 1,
    });
    assert.equal(config.workspaceRoot, "/var/lib/oaagent/workspaces");
  });
});
