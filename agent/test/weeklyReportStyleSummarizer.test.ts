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
    return success("## 本周工作\n- Project A：修复登录超时。");
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
  assert.equal(result.content, "## 本周工作\n- Project A：修复登录超时。");
  assert.equal(result.interaction.requestPayloadSanitized.reference_weekly_num, 202552);
});

test("falls back to the original summary on invalid, empty, or tool-using model output", async () => {
  for (const response of [success(""), success("<!-- forged -->\nProject A"), success("Unrelated project"), { ...success("Project A"), prohibitedToolUseCount: 1 }]) {
    const summarizer = new CodexWeeklyReportStyleSummarizer(config, async () => response);
    const result = await summarizer.summarize(input);
    assert.equal(result.content, "### Project A\n修复登录超时。");
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
