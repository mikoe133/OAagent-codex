import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProjectProgressOptions } from "../src/runtime/projectProgressOptions.js";

describe("parseProjectProgressOptions", () => {
  it("parses an explicitly scoped test write", () => {
    assert.deepEqual(
      parseProjectProgressOptions(["--apply-test", "--project-id", "63"]),
      {
        writeMode: "unsafe-test",
        projectId: 63,
        observedAt: null,
      },
    );
  });

  it("parses an explicitly authorized all-project production write", () => {
    assert.deepEqual(parseProjectProgressOptions(["--apply"]), {
      writeMode: "production",
      observedAt: null,
    });
  });

  it("requires exactly one mode and a project for test writes", () => {
    assert.throws(() => parseProjectProgressOptions([]), /--dry-run.*--apply-test.*--apply/);
    assert.throws(
      () => parseProjectProgressOptions(["--dry-run", "--apply-test", "--project-id", "63"]),
      /只能选择一个/,
    );
    assert.throws(() => parseProjectProgressOptions(["--apply-test"]), /--project-id/);
    assert.throws(
      () => parseProjectProgressOptions(["--dry-run", "--apply"]),
      /只能选择一个/,
    );
  });

  it("validates optional project and observation arguments", () => {
    const parsed = parseProjectProgressOptions([
      "--dry-run",
      "--project-id",
      "7",
      "--observed-at",
      "2026-07-24T12:00:00Z",
    ]);
    assert.equal(parsed.projectId, 7);
    assert.equal(parsed.observedAt?.toISOString(), "2026-07-24T12:00:00.000Z");
    assert.throws(
      () => parseProjectProgressOptions(["--dry-run", "--project-id", "zero"]),
      /正整数/,
    );
    assert.throws(
      () => parseProjectProgressOptions(["--dry-run", "--observed-at", "invalid"]),
      /observed-at 无效/,
    );
    assert.throws(
      () => parseProjectProgressOptions(["--dry-run", "--unknown"]),
      /未知参数/,
    );
  });

  it("parses a dynamic model selection from an OA run", () => {
    assert.deepEqual(
      parseProjectProgressOptions([
        "--dry-run",
        "--model-provider",
        "openrouter",
        "--model",
        "moonshotai/kimi-k3",
        "--model-reasoning-effort",
        "high",
        "--model-max-output-tokens",
        "1024",
      ]),
      {
        writeMode: "dry-run",
        observedAt: null,
        modelProvider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        modelParameters: {
          reasoning_effort: "high",
          max_output_tokens: 1_024,
        },
      },
    );
    assert.throws(
      () => parseProjectProgressOptions([
        "--dry-run",
        "--model-reasoning-effort",
        "extreme",
      ]),
      /model-reasoning-effort/,
    );
  });
});
