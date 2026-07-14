import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadItem } from "@openai/codex-sdk";
import { resolveStreamRecovery } from "../src/application/agentService.js";
import type { AppConfig } from "../src/config/config.js";
import {
  SUPPORTED_OPENAI_MODELS,
  resolveRequestedOpenAiModel,
} from "../src/config/modelCatalog.js";
import { createThreadOptions } from "../src/infrastructure/codex/codexClient.js";

describe("OpenRouter OpenAI model selection", () => {
  it("exposes the supported OpenAI model whitelist", () => {
    assert.deepEqual(SUPPORTED_OPENAI_MODELS, [
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano",
    ]);
  });

  it("accepts a supported requested model", () => {
    assert.equal(
      resolveRequestedOpenAiModel("openai/gpt-5.4-mini", "gpt-5.5"),
      "openai/gpt-5.4-mini",
    );
  });

  it("rejects models outside the whitelist", () => {
    assert.throws(
      () => resolveRequestedOpenAiModel("openai/gpt-5.5-pro", "gpt-5.5"),
      /不支持的模型/,
    );
  });

  it("uses the selected model for the Codex thread", () => {
    const config = {
      model: "gpt-5.5",
      oaApiBaseUrl: null,
      projectRoot: "/tmp/agent",
    } as AppConfig;

    assert.equal(
      createThreadOptions(config, "openai/gpt-5.4").model,
      "openai/gpt-5.4",
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
