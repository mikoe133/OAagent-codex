import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadItem } from "@openai/codex-sdk";
import {
  resolveStreamFailure,
  resolveStreamRecovery,
} from "../src/application/agentService.js";
import type { AppConfig } from "../src/config/config.js";
import {
  MODEL_CATALOG,
  resolveRequestedProvider,
  resolveRequestedModel,
} from "../src/config/modelCatalog.js";
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
      "z-ai/glm-5.2",
      "moonshotai/kimi-k3",
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
  });

  it("accepts a supported provider and model", () => {
    assert.equal(resolveRequestedProvider("openrouter", "nexttoken"), "openrouter");
    assert.equal(
      resolveRequestedModel("openrouter", "z-ai/glm-5.2", "z-ai/glm-5.2"),
      "z-ai/glm-5.2",
    );
    assert.equal(
      resolveRequestedModel("openrouter", "moonshotai/kimi-k3", "z-ai/glm-5.2"),
      "moonshotai/kimi-k3",
    );
  });

  it("rejects unknown providers and cross-provider models", () => {
    assert.throws(
      () => resolveRequestedProvider("unknown", "nexttoken"),
      /不支持的模型提供商/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "gpt-5.6-terra", "z-ai/glm-5.2"),
      /不支持模型/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "openai/gpt-5.4-mini", "z-ai/glm-5.2"),
      /不支持模型/,
    );
    assert.throws(
      () => resolveRequestedModel("openrouter", "openai/gpt-5.4-nano", "z-ai/glm-5.2"),
      /不支持模型/,
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
});

describe("resolveStreamRecovery", () => {
  it("preserves a completed agent response after the Codex process exits with an error", () => {
    const finalResponse = "不能直接修改 Dax 的周报。";

    const recovery = resolveStreamRecovery(
      finalResponse,
      [successfulGetUserItem()],
      [],
    );

    assert.deepEqual(recovery, {
      kind: "existing_response",
      response: finalResponse,
    });
  });

  it("does not turn a successful helper GET into a completed business task", () => {
    const recovery = resolveStreamRecovery("", [successfulGetUserItem()], []);

    assert.equal(recovery, null);
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
        "接口依据:",
        "- weekly_report_weekly_report_report_post, POST /weekly-report/report",
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
