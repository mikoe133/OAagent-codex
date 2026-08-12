import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTaskReasoningEffort } from "../src/application/taskReasoningPolicy.js";
import type { AppConfig } from "../src/config/config.js";
import { createThreadOptions } from "../src/infrastructure/codex/codexClient.js";

describe("task reasoning policy", () => {
  it("uses medium for default and ordinary queries", () => {
    assert.equal(resolveTaskReasoningEffort(""), "medium");
    assert.equal(resolveTaskReasoningEffort("查询薛屹阳的个人信息"), "medium");
    assert.equal(resolveTaskReasoningEffort("查看我的本周周报"), "medium");
  });

  it("uses high for statistics, cross-module analysis, and writes", () => {
    assert.equal(resolveTaskReasoningEffort("统计各部门本月工时趋势"), "high");
    assert.equal(resolveTaskReasoningEffort("综合分析项目进度和周报风险"), "high");
    assert.equal(resolveTaskReasoningEffort("帮我修改第 101 周周报"), "high");
    assert.equal(resolveTaskReasoningEffort("维护项目 GitHub 仓库地址"), "high");
  });

  it("always overrides inherited global reasoning effort", () => {
    const config = {
      model: "gpt-5.6-terra",
      oaApiBaseUrl: null,
      projectRoot: "/tmp/agent",
    } as AppConfig;

    assert.equal(createThreadOptions(config).modelReasoningEffort, "medium");
    assert.equal(
      createThreadOptions(config, "gpt-5.6-terra", "high").modelReasoningEffort,
      "high",
    );
  });
});
