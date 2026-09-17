import assert from "node:assert/strict";
import test from "node:test";
import { CodexWeeklyReportRewriter, contentHash } from "../src/application/weeklyReportRewriter.js";
import { weeklyReportRewriteInputSchema } from "../src/domain/weeklyReportRewrite.js";

const config = { model: { provider: "openrouter" as const, model: "z-ai/glm-5.3", apiBaseUrl: "https://model.test", apiKey: "test", parameters: {} }, workingDirectory: "/tmp", retryPolicy: { maxAttempts: 1, intervalMs: 0 } };
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

test("retries only this report with the rejected draft and review issues, retaining failure audits after success", async () => {
  let calls = 0;
  const result = await new CodexWeeklyReportRewriter({ ...config, retryPolicy: { maxAttempts: 3, intervalMs: 0 } }, async (request) => {
    calls++;
    if (calls === 1) return run({ ...draft(), content: "完成登录问题修复。" });
    if (calls === 2) return run({ approved: false, issues: ["遗漏接口文档和客户沟通。"] });
    if (calls === 3) {
      const payload = JSON.parse(request.prompt);
      assert.equal(payload.current_report, content);
      assert.deepEqual(payload.daily_summaries, input.summaries);
      assert.equal(payload.correction.previous_draft, "完成登录问题修复。");
      assert.deepEqual(payload.correction.issues, ["遗漏接口文档和客户沟通。"]);
      return run(draft());
    }
    return run({ approved: true, issues: [] });
  }).rewrite(input);
  assert.equal(calls, 4);
  assert.equal(result.content, draft().content);
  assert.equal(result.interaction.fallbackUsed, false);
  const audit = result.interaction.responsePayloadSanitized.attempts as Array<Record<string, unknown>>;
  assert.equal(audit.length, 2);
  assert.equal(audit[0]?.phase, "review");
  assert.equal(audit[0]?.draft_content, "完成登录问题修复。");
  assert.deepEqual(audit[0]?.review_issues, ["遗漏接口文档和客户沟通。"]);
  assert.equal(audit[0]?.will_retry, true);
  assert.equal(audit[1]?.status, "succeeded");
});

test("exhausts only the configured report attempts and preserves all rejected outputs with redacted secrets", async () => {
  let calls = 0;
  const result = await new CodexWeeklyReportRewriter({ ...config, model: { ...config.model, apiKey: "model-secret" }, retryPolicy: { maxAttempts: 3, intervalMs: 0 } }, async () => {
    calls++;
    return calls % 2 ? run(draft()) : run({ approved: false, issues: ["遗漏工作。model-secret token=private-token Bearer private-bearer"] });
  }).rewrite(input);
  assert.equal(calls, 6);
  assert.equal(result.content, null);
  assert.equal(result.interaction.errorCode, "weekly_report_fact_review_failed");
  const audit = result.interaction.responsePayloadSanitized.attempts as Array<Record<string, unknown>>;
  assert.equal(audit.length, 3);
  assert.equal(audit[2]?.will_retry, false);
  assert.match(String(audit[2]?.review_response), /遗漏工作/);
  assert.doesNotMatch(JSON.stringify(audit), /model-secret|private-token|private-bearer/);
});

for (const message of ["HTTP 401 unauthorized", "HTTP 403 forbidden", "模型配置无效", "github_identity_not_found"]) {
  test(`does not retry permanent prerequisites: ${message}`, async () => {
    let calls = 0;
    const result = await new CodexWeeklyReportRewriter({ ...config, retryPolicy: { maxAttempts: 3, intervalMs: 0 } }, async () => { calls++; throw new Error(message); }).rewrite(input);
    assert.equal(calls, 1);
    assert.equal(result.content, null);
    const audit = result.interaction.responsePayloadSanitized.attempts as Array<Record<string, unknown>>;
    assert.equal(audit[0]?.retryable, false);
    assert.equal(audit[0]?.generation_response, null);
    assert.match(String(audit[0]?.reason), new RegExp(message));
  });
}

test("records transport failures and retries only the failed report", async () => {
  let calls = 0;
  const result = await new CodexWeeklyReportRewriter({ ...config, retryPolicy: { maxAttempts: 3, intervalMs: 0 } }, async () => {
    if (++calls === 1) throw new Error("HTTP 503 unavailable");
    return run(calls === 2 ? draft() : { approved: true, issues: [] });
  }).rewrite(input);
  assert.equal(calls, 3);
  assert.equal(result.content, draft().content);
  assert.equal((result.interaction.responsePayloadSanitized.attempts as Array<Record<string, unknown>>)[0]?.phase, "generation");
});
