import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadItem } from "@openai/codex-sdk";
import {
  buildIncompleteTurnContinuationPrompt,
  hasTerminalAgentResponse,
  resolveStreamFailure,
  resolveStreamRecovery,
} from "../src/application/agentService.js";
import type { AppConfig } from "../src/config/config.js";
import {
  MODEL_CATALOG,
  decodeAutomationModelParameters,
  getModelDisplayName,
  resolveAutomationModelSelection,
  resolveRequestedProvider,
  resolveRequestedModel,
} from "../src/config/modelCatalog.js";
import { parseCodexSandboxMode } from "../src/config/config.js";
import { createThreadOptions } from "../src/infrastructure/codex/codexClient.js";

describe("model provider selection", () => {
  it("exposes isolated provider model whitelists", () => {
    assert.deepEqual(MODEL_CATALOG.nexttoken, [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    assert.deepEqual(MODEL_CATALOG.openrouter, [
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
  });

  it("accepts a supported provider and model", () => {
    assert.equal(resolveRequestedProvider("openrouter", "nexttoken"), "openrouter");
    assert.equal(
      resolveRequestedModel("openrouter", "z-ai/glm-5.3", "z-ai/glm-5.3"),
      "z-ai/glm-5.3",
    );
    assert.equal(
      resolveRequestedModel("openrouter", "moonshotai/kimi-k3", "z-ai/glm-5.3"),
      "moonshotai/kimi-k3",
    );
    assert.equal(
      resolveRequestedModel(
        "openrouter",
        "deepseek/deepseek-v4-pro",
        "z-ai/glm-5.3",
      ),
      "deepseek/deepseek-v4-pro",
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "z-ai/glm-5.2", "z-ai/glm-5.3"),
      /不支持模型/,
    );
  });

  it("formats model brand names in model catalogs", () => {
    assert.equal(getModelDisplayName("z-ai/glm-5.3"), "GLM 5.3");
    assert.equal(
      getModelDisplayName("deepseek/deepseek-v4-pro"),
      "DeepSeek V4 Pro",
    );
  });

  it("rejects unknown providers and cross-provider models", () => {
    assert.throws(
      () => resolveRequestedProvider("unknown", "nexttoken"),
      /不支持的模型提供商/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "gpt-5.6-terra", "z-ai/glm-5.3"),
      /不支持模型/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "openai/gpt-5.4-mini", "z-ai/glm-5.3"),
      /不支持模型/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "openai/gpt-5.4-nano", "z-ai/glm-5.3"),
      /不支持模型/,
    );
  });

  it("validates automation model selections and parameters", () => {
    assert.deepEqual(
      resolveAutomationModelSelection(
        {
          modelProvider: "openrouter",
          modelId: "moonshotai/kimi-k3",
          modelParameters: {
            reasoning_effort: "high",
            max_output_tokens: 1_024,
          },
        },
        { modelProvider: "nexttoken", modelId: "gpt-5.6-terra" },
      ),
      {
        modelProvider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        modelParameters: {
          reasoning_effort: "high",
          max_output_tokens: 1_024,
        },
      },
    );
    assert.throws(
      () => decodeAutomationModelParameters({ temperature: 0.2 }),
      /不支持的字段:temperature/,
    );
    assert.throws(
      () => decodeAutomationModelParameters({ max_output_tokens: 100 }),
      /256-4096/,
    );
  });

  it("allows DeepSeek V4 Pro for automation tasks", () => {
    assert.deepEqual(
      resolveAutomationModelSelection(
        {
          modelProvider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          modelParameters: {
            reasoning_effort: "high",
            max_output_tokens: 2_048,
          },
        },
        { modelProvider: "nexttoken", modelId: "gpt-5.6-terra" },
      ),
      {
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelParameters: {
          reasoning_effort: "high",
          max_output_tokens: 2_048,
        },
      },
    );
  });

  it("normalizes GLM 5.3 automation reasoning parameters", () => {
    assert.deepEqual(
      resolveAutomationModelSelection(
        {
          modelProvider: "openrouter",
          modelId: "z-ai/glm-5.3",
          modelParameters: { reasoning_effort: "medium" },
        },
        { modelProvider: "nexttoken", modelId: "gpt-5.6-terra" },
      ),
      {
        modelProvider: "openrouter",
        modelId: "z-ai/glm-5.3",
        modelParameters: { reasoning_effort: "high" },
      },
    );
  });

  it("uses the selected model for the Codex thread", () => {
    const config = {
      model: "gpt-5.6-terra",
      oaApiBaseUrl: null,
      projectRoot: "/tmp/agent",
    } as AppConfig;

    assert.equal(
      createThreadOptions(config, "gpt-5.6-terra").model,
      "gpt-5.6-terra",
    );
  });

  it("keeps the Codex sandbox by default", () => {
    const readOnlyConfig = {
      oaApiBaseUrl: null,
      codexSandboxMode: null,
      projectRoot: "/tmp/agent",
    } as AppConfig;
    const oaToolConfig = {
      oaApiBaseUrl: "https://oa.example.test",
      codexSandboxMode: null,
      projectRoot: "/tmp/agent",
    } as AppConfig;

    assert.equal(createThreadOptions(readOnlyConfig).sandboxMode, "read-only");
    assert.equal(createThreadOptions(oaToolConfig).sandboxMode, "workspace-write");
    assert.equal(createThreadOptions(oaToolConfig).networkAccessEnabled, true);
  });

  it("uses the Docker boundary when full access is explicitly configured", () => {
    const config = {
      oaApiBaseUrl: "https://oa.example.test",
      codexSandboxMode: "danger-full-access",
      projectRoot: "/tmp/agent",
    } as AppConfig;

    const options = createThreadOptions(config);
    assert.equal(options.sandboxMode, "danger-full-access");
    assert.equal(options.networkAccessEnabled, undefined);
  });

  it("rejects unknown Codex sandbox modes", () => {
    assert.equal(parseCodexSandboxMode(undefined), null);
    assert.equal(parseCodexSandboxMode(" workspace-write "), "workspace-write");
    assert.throws(
      () => parseCodexSandboxMode("disabled"),
      /CODEX_SANDBOX_MODE/,
    );
  });
});

describe("resolveStreamRecovery", () => {
  it("preserves a completed agent response after the Codex process exits with an error", () => {
    const finalResponse = "不能直接修改 Dax 的周报。";

    const recovery = resolveStreamRecovery(
      finalResponse,
      [successfulGetUserItem(), agentMessageItem("final-answer", finalResponse)],
      [],
    );

    assert.deepEqual(recovery, {
      kind: "existing_response",
      response: finalResponse,
    });
  });

  it("does not treat a progress message before the last tool as a final response", () => {
    const progress = "项目列表已返回，我现在继续精确定位。";
    const items = [
      agentMessageItem("progress", progress),
      successfulGetUserItem(),
    ];

    assert.equal(hasTerminalAgentResponse(items), false);
    assert.equal(resolveStreamRecovery(progress, items, []), null);
  });

  it("does not treat progress as final while a later OA tool is still active", () => {
    const progress = "知识库结果已取得，我接着查询项目更新。";
    const items = [agentMessageItem("progress", progress)];
    const activeToolIds = new Set(["oa-project-query"]);

    assert.equal(hasTerminalAgentResponse(items, activeToolIds), false);
    assert.equal(
      resolveStreamRecovery(progress, items, [], activeToolIds),
      null,
    );
  });

  it("accepts an agent response emitted after the last tool", () => {
    const answer = "RWKV Chat 项目当前处于持续更新状态。";
    const items = [
      successfulGetUserItem(),
      agentMessageItem("final-answer", answer),
    ];

    assert.equal(hasTerminalAgentResponse(items), true);
  });

  it("does not turn a successful helper GET into a completed business task", () => {
    const recovery = resolveStreamRecovery("", [successfulGetUserItem()], []);

    assert.equal(recovery, null);
  });

  it("builds a domain-agnostic continuation that audits every pending user intent", () => {
    const prompt = buildIncompleteTurnContinuationPrompt(
      "请回答知识库制度，并查询相关项目的当前更新。",
    );

    assert.match(prompt, /拆分.*子问题|子问题.*拆分/);
    assert.match(prompt, /逐项.*已有证据|已有证据.*逐项/);
    assert.match(prompt, /只.*未完成|尚未完成/);
    assert.match(prompt, /完整最终回答/);
    assert.doesNotMatch(prompt, /发票|宽带|RWKV Chat/);
  });

  it("recovers from a successful confirmed mutation when no final response exists", () => {
    const recovery = resolveStreamRecovery(
      "",
      [successfulConfirmedWeeklyReportWriteItem()],
      [],
    );

    assert.deepEqual(recovery, {
      kind: "tool_fallback",
      response: [
        "已成功执行修改操作。",
        "结果:系统 weekly_num=101, content 已更新为 `6666`",
      ].join("\n"),
    });
  });

  it("does not recover from an unconfirmed mutation", () => {
    const item = successfulConfirmedWeeklyReportWriteItem();
    item.command = item.command.replace(" --confirmed true", "");

    const recovery = resolveStreamRecovery("", [item], []);

    assert.equal(recovery, null);
  });
});

describe("resolveStreamFailure", () => {
  it("prefers the structured Codex turn failure over the process exit error", () => {
    const failure = resolveStreamFailure(
      new Error(
        "Codex Exec exited with code 1: Reading prompt from stdin...\n",
      ),
      "This model is not available in your region.",
      [],
    );

    assert.equal(
      failure.message,
      "This model is not available in your region.",
    );
  });

  it("redacts secrets from the structured Codex turn failure", () => {
    const failure = resolveStreamFailure(
      new Error("Codex Exec exited with code 1"),
      "Provider rejected secret-nexttoken-key",
      ["secret-nexttoken-key"],
    );

    assert.equal(failure.message, "Provider rejected [REDACTED]");
  });

  it("falls back to the process exit error when no turn failure exists", () => {
    const failure = resolveStreamFailure(
      new Error("Codex Exec exited with code 1"),
      null,
      [],
    );

    assert.equal(failure.message, "Codex Exec exited with code 1");
  });

  it("does not expose the malformed JSONL event payload in parse errors", () => {
    const failure = resolveStreamFailure(
      new Error(
        'Failed to parse item: {"type":"item.completed","item":{"aggregated_output":"公司敏感正文"}}',
      ),
      null,
      [],
    );

    assert.match(failure.message, /JSONL|事件流/);
    assert.doesNotMatch(failure.message, /公司敏感正文|aggregated_output/);
    assert.ok(failure.message.length < 300);
  });
});

function successfulGetUserItem(): Extract<
  ThreadItem,
  { type: "command_execution" }
> {
  return {
    id: "get-user",
    type: "command_execution",
    command:
      "node scripts/callOaApi.mjs --operationId user_info_user_user_get --query '{}' | jq '{status, ok, operationId, path, data}'",
    aggregated_output: JSON.stringify({
      status: 200,
      ok: true,
      operationId: "user_info_user_user_get",
      path: "/user/user",
      data: {
        code: 200,
        message: "ok",
        success: true,
      },
    }),
    exit_code: 0,
    status: "completed",
  };
}

function successfulConfirmedWeeklyReportWriteItem(): Extract<
  ThreadItem,
  { type: "command_execution" }
> {
  return {
    id: "write-weekly-report",
    type: "command_execution",
    command:
      "node scripts/callOaApi.mjs --operationId weekly_report_weekly_report_report_post --body '{\"weekly_num\":101,\"content\":\"6666\"}' --confirmed true",
    aggregated_output: JSON.stringify({
      status: 200,
      ok: true,
      operationId: "weekly_report_weekly_report_report_post",
      method: "POST",
      path: "/weekly-report/report",
      data: {
        code: 200,
        message: "ok",
        success: true,
        data: {
          weekly_num: 101,
          content: "6666",
        },
      },
    }),
    exit_code: 0,
    status: "completed",
  };
}

function agentMessageItem(
  id: string,
  text: string,
): Extract<ThreadItem, { type: "agent_message" }> {
  return {
    id,
    type: "agent_message",
    text,
  };
}
