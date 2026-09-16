import assert from "node:assert/strict";
import test from "node:test";
import { CodexWeeklyReportStyleSummarizer, WEEKLY_REPORT_STYLE_PROMPT } from "../src/application/weeklyReportStyleSummarizer.js";
import type { WeeklyReportAgentRunInput } from "../src/application/weeklyReportAgentSummarizer.js";

const config = {
  model: { provider: "nexttoken" as const, apiBaseUrl: "https://model.example.test/v1", apiKey: "test-key", model: "test-model", parameters: {} },
  workingDirectory: "/tmp/oaagent",
};
const input = {
  projectName: "Project A", summaryDate: "2026-01-05", summary: "修复登录超时。",
  githubId: "alice", previousReport: { reportId: 41, weeklyNum: 202552, content: "## 上周工作\n- Project B：完成上传。" },
};
const success = (content: string) => ({ finalResponse: JSON.stringify({ content }), usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 }, upstreamRequestId: "style-test", prohibitedToolUseCount: 0 });

test("references last week's style with a dedicated schema and audits metadata without historical content", async () => {
  let request: WeeklyReportAgentRunInput | undefined;
  const summarizer = new CodexWeeklyReportStyleSummarizer(config, async (value) => {
    request = value;
    return success("## Project A\n- **修复登录超时。**");
  });
  const result = await summarizer.summarize(input);
  assert.equal(JSON.parse(request!.prompt).previous_report, input.previousReport.content);
  assert.equal(JSON.parse(request!.prompt).current_summary, input.summary);
  assert.deepEqual(request!.outputSchema?.required, ["content"]);
  assert.match(WEEKLY_REPORT_STYLE_PROMPT, /不得搬用参考周报/);
  assert.match(request!.developerInstructions!, /周次、周报作者、周报编号、风格来源、同步状态等审计信息由系统单独记录/);
  assert.equal(result.interaction.fallbackUsed, false);
  assert.equal(result.interaction.requestPayloadSanitized.reference_report_id, 41);
  assert.equal(JSON.stringify(result.interaction).includes("完成上传"), false);
  assert.equal(result.content, "Project A\n- **修复登录超时。**");
  assert.equal(result.interaction.requestPayloadSanitized.reference_weekly_num, 202552);
});

test("falls back to the original summary on invalid, empty, or tool-using model output", async () => {
  for (const response of [success(""), success("<!-- forged -->\nProject A"), success("Unrelated project"), { ...success("Project A"), prohibitedToolUseCount: 1 }]) {
    const summarizer = new CodexWeeklyReportStyleSummarizer(config, async () => response);
    const result = await summarizer.summarize(input);
    assert.equal(result.content, "Project A\n修复登录超时。");
    assert.equal(result.interaction.fallbackUsed, true);
  }
});

test("bounds historical input and propagates cancellation without writing fallback content", async () => {
  const controller = new AbortController();
  const summarizer = new CodexWeeklyReportStyleSummarizer(config, async (request) => {
    assert.equal(JSON.parse(request.prompt).previous_report.length, 16_000);
    assert.equal(JSON.parse(request.prompt).previous_report_truncated, true);
    controller.abort();
    throw new Error("cancelled");
  });
  await assert.rejects(summarizer.summarize({ ...input, previousReport: { ...input.previousReport, content: "x".repeat(20_000) }, signal: controller.signal }), { name: "AbortError" });
});


test("rejects invalid source summaries before invoking the model or producing fallback content", async () => {
  let calls = 0;
  const summarizer = new CodexWeeklyReportStyleSummarizer(config, async () => {
    calls += 1;
    return success("Project A\n天气与日期信息通过 API 实时获取。");
  });
  await assert.rejects(summarizer.summarize({ ...input,
    summary: "针对候选提交，我看到2个提交的标题都涉及中文验证和总结。让我先读取详细信息来了解这些提交的具体改动。",
  }), /项目总结无效/);
  assert.equal(calls, 0);
});

test("rejects invented facts, omissions, negation changes, and malformed newlines", async () => {
  for (const [summary, content] of [
    [input.summary, "Project A\n修复登录超时。支持请假和天气查询。"],
    [input.summary, "Project A\n天气与日期信息通过 API 实时获取。"],
    [input.summary, "Project An1. 修复登录超时。"],
    ["修复登录超时并完善 API 文档。", "Project A\n修复登录超时。"],
    ["暂不支持出差申请。", "Project A\n支持出差申请。"],
    ["修复 12 个问题。", "Project A\n修复 120 个问题。"],
  ]) {
    const result = await new CodexWeeklyReportStyleSummarizer(config, async () => success(content!))
      .summarize({ ...input, summary: summary! });
    assert.equal(result.content, `Project A\n${summary}`);
    assert.equal(result.interaction.fallbackUsed, true);
    assert.equal(result.interaction.errorCode, "weekly_report_style_content_changed");
    assert.equal(result.interaction.responsePayloadSanitized.rejection_reason, "weekly_report_style_content_changed");
  }
});

test("accepts layout changes while preserving numbers and technical names", async () => {
  const summary = "修复 2 个 GitHub API 问题。\n完善 test 分支校验。";
  const content = "Project A\n1. **修复 2 个 `GitHub API` 问题。**\n2. 完善 test 分支校验。";
  const result = await new CodexWeeklyReportStyleSummarizer(config, async () => success(content))
    .summarize({ ...input, summary });
  assert.equal(result.content, content);
  assert.equal(result.interaction.fallbackUsed, false);
  assert.equal(result.interaction.responsePayloadSanitized.rejection_reason, null);
  assert.match(String(result.interaction.requestPayloadSanitized.current_summary_digest), /^[a-f0-9]{64}$/u);
});
