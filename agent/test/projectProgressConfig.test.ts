import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProjectProgressConfig } from "../src/config/projectProgressConfig.js";

describe("loadProjectProgressConfig", () => {
  it("uses dedicated OA worker authentication settings", () => {
    const config = loadProjectProgressConfig(
      {
        OA_API_BASE_URL: "https://oa.example.test",
        OA_AUTH_ALIAS: "production",
        OA_API_TOKEN_HEADER: "Cookie",
        OA_PROJECT_SYNC_TOKEN: "worker-token",
        OA_PROJECT_SYNC_TOKEN_HEADER: "X-Worker-Token",
        OA_PROJECT_SYNC_TOKEN_PREFIX: "Token",
        GITHUB_PROJECT_SYNC_TOKEN: "github-token",
        NEXTTOKEN_API_KEY: "model-token",
      },
      "/srv/oa-agent",
    );

    assert.equal(config.oa.tokenHeader, "X-Worker-Token");
    assert.equal(config.oa.tokenPrefix, "Token");
    assert.equal(config.oa.token, "worker-token");
    assert.equal(config.stateDatabasePath, "/srv/oa-agent/.context/project-progress.sqlite");
    assert.equal(config.writeEnabled, false);
  });

  it("rejects test writes without an explicit unsafe acknowledgement", () => {
    assert.throws(
      () => loadProjectProgressConfig({ PROJECT_PROGRESS_WRITE_ENABLED: "true" }, "/tmp"),
      /UNSAFE_TEST_WRITES/,
    );
  });

  it("allows explicitly acknowledged writes only through a loopback OA service", () => {
    const environment = {
      OA_API_BASE_URL: "http://127.0.0.1:3002",
      OA_PROJECT_SYNC_TOKEN: "worker-token",
      GITHUB_PROJECT_SYNC_TOKEN: "github-token",
      NEXTTOKEN_API_KEY: "model-token",
      PROJECT_PROGRESS_WRITE_ENABLED: "true",
      PROJECT_PROGRESS_UNSAFE_TEST_WRITES: "I_UNDERSTAND_TEST_ONLY",
    };

    assert.equal(loadProjectProgressConfig(environment, "/tmp").writeEnabled, true);
    assert.throws(
      () => loadProjectProgressConfig(
        { ...environment, OA_API_BASE_URL: "https://oa.example.com" },
        "/tmp",
      ),
      /loopback/,
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
  });
});
