import assert from "node:assert/strict";
import test from "node:test";
import { CodexWeeklyReportRewriter, contentHash } from "../src/application/weeklyReportRewriter.js";
import { weeklyReportRewriteInputSchema } from "../src/domain/weeklyReportRewrite.js";

const config = { model: { provider: "openrouter" as const, model: "z-ai/glm-5.3", apiBaseUrl: "https://model.test", apiKey: "test", parameters: {} }, workingDirectory: "/tmp" };
const content = "OA-Agent：完成接口文档，正在修复登录问题。其他工作：完成客户沟通。";
const input = weeklyReportRewriteInputSchema.parse({
  context: { report_id: 12, weekly_num: 121, owner_id: 7, github_id: "alice", start_date: "2026-09-14", end_date: "2026-09-20", content, content_hash: contentHash(content) },
  summaryDate: "2026-09-16", summaries: [{ source_id: "daily:1:2026-09-16", project_id: 1, project_name: "OA-Agent", summary_date: "2026-09-16", content: "登录问题已修复。" }],
});
const draft = () => ({ content: "OA-Agent：完成接口文档和登录问题修复。其他工作：完成客户沟通。", source_ids: ["current-report", "daily:1:2026-09-16"] });
const run = (value: unknown) => ({ finalResponse: JSON.stringify(value), usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, reasoning_output_tokens: 0 }, upstreamRequestId: "test", prohibitedToolUseCount: 0 });

test("gives generation and review the existing report and only today's summaries", async () => {
  let calls = 0;
  const result = await new CodexWeeklyReportRewriter(config, async (request) => {
    const payload = JSON.parse(request.prompt);
    assert.equal(payload.current_report, content);
    assert.deepEqual(payload.daily_summaries, input.summaries);
    assert.equal(payload.summary_date, "2026-09-16");
    assert.equal("facts" in payload, false);
    if (++calls === 2) assert.deepEqual(payload.draft, draft());
    return run(calls === 1 ? draft() : { approved: true, issues: [] });
  }).rewrite(input);
  assert.equal(result.content, draft().content);
  assert.equal(calls, 2);
  assert.equal(result.interaction.inputTokens, 200);
  assert.equal(result.interaction.requestPayloadSanitized.expected_content_hash, input.context.content_hash);
});

test("keeps text on both sides of old append markers and accepts in-place manual edits", async () => {
  let calls = 0;
  const edited = "修改过的接口文档工作。\n<!-- oaagent-project-progress:1:2026-09-15:abc -->\n正在修复登录问题。\n手写尾注：完成客户沟通。";
  const result = await new CodexWeeklyReportRewriter(config, async (request) => {
    const payload = JSON.parse(request.prompt);
    assert.doesNotMatch(payload.current_report, /oaagent-project-progress/);
    assert.match(payload.current_report, /修改过的接口文档工作/);
    assert.match(payload.current_report, /手写尾注：完成客户沟通/);
    return run(++calls === 1 ? draft() : { approved: true, issues: [] });
  }).rewrite({ ...input, context: { ...input.context, content: edited, content_hash: contentHash(edited) } });
  assert.notEqual(result.content, null);
});

for (const issue of ["遗漏原有接口文档和客户沟通", "新增无依据天气功能", "已修复仍写成待修复", "将团队成果归为个人成果"]) {
  test(`keeps original when reviewer rejects: ${issue}`, async () => {
    let calls = 0;
    const result = await new CodexWeeklyReportRewriter(config, async () => run(++calls === 1 ? draft() : { approved: false, issues: [issue] })).rewrite(input);
    assert.equal(result.content, null);
    assert.equal(result.interaction.errorCode, "weekly_report_fact_review_failed");
  });
}
for (const failure of ["missing_baseline", "unknown_source", "missing_daily", "process", "html", "too_long", "malformed"] as const) {
  test(`rejects ${failure} before review`, async () => {
    const value = draft(); let calls = 0;
    if (failure === "missing_baseline") value.source_ids.shift();
    if (failure === "unknown_source") value.source_ids.push("invented");
    if (failure === "missing_daily") value.source_ids.pop();
    if (failure === "process") value.content = "让我先读取详细信息来了解这些提交的具体改动。";
    if (failure === "html") value.content = "<p>完成登录修复</p>";
    if (failure === "too_long") value.content = "完成工作。".repeat(201);
    const result = await new CodexWeeklyReportRewriter(config, async () => { calls++; return run(failure === "malformed" ? {} : value); }).rewrite(input);
    assert.equal(result.content, null); assert.equal(calls, 1);
  });
}

test("rejects missing, process-like, wrong-day and oversized daily summaries before generation", async () => {
  const rewriter = new CodexWeeklyReportRewriter(config, async () => { throw new Error("runner must not be called"); });
  for (const summaries of [[], [{ ...input.summaries[0]!, content: "让我先读取详情。" }], [{ ...input.summaries[0]!, summary_date: "2026-09-15" }], [{ ...input.summaries[0]!, content: "完成修复。".repeat(15000) }]]) {
    const result = await rewriter.rewrite({ ...input, summaries });
    assert.equal(result.content, null); assert.equal(result.interaction.responsePayloadSanitized.model_calls, 0);
  }
});

test("an empty current report can be initialized from the daily summary", async () => {
  let calls = 0;
  const result = await new CodexWeeklyReportRewriter(config, async () => run(++calls === 1 ? { content: "OA-Agent：完成登录问题修复。", source_ids: [input.summaries[0]!.source_id] } : { approved: true, issues: [] })).rewrite({ ...input, context: { ...input.context, content: "", content_hash: contentHash("") } });
  assert.equal(result.content, "OA-Agent：完成登录问题修复。");
});

test("propagates cancellation during review", async () => {
  const controller = new AbortController(); let calls = 0;
  const rewriter = new CodexWeeklyReportRewriter(config, async () => {
    if (++calls === 2) controller.abort();
    return run(calls === 1 ? draft() : { approved: true, issues: [] });
  });
  await assert.rejects(rewriter.rewrite(input, controller.signal), { name: "AbortError" });
});
