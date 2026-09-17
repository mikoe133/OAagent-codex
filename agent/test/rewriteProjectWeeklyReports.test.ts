import assert from "node:assert/strict";
import test from "node:test";
import { rewriteProjectWeeklyReports, type WeeklyReportRewriteTarget } from "../src/application/rewriteProjectWeeklyReports.js";
import { contentHash } from "../src/application/weeklyReportRewriter.js";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";
import { OaRequestError } from "../src/infrastructure/oa/projectProgressOaClient.js";
import type { ProjectProgressProjectReport } from "../src/application/syncProjectProgress.js";

import type { ProjectProgressAiInteraction } from "../src/application/projectProgressSummarizer.js";

const context = { report_id: 12, weekly_num: 121, owner_id: 7, github_id: "alice", start_date: "2026-09-14", end_date: "2026-09-20", content: "原周报", content_hash: contentHash("原周报") };
const interaction = { provider: "openrouter", model: "test", promptVersion: "test", systemPromptSnapshot: "test", requestPayloadSanitized: {}, responsePayloadSanitized: {}, finalSummary: "新周报", limitations: [], fallbackUsed: false, upstreamRequestId: null, inputTokens: 0, outputTokens: 0, latencyMs: 0, status: "succeeded", errorCode: null, errorSummary: null } as unknown as ProjectProgressAiInteraction;
function setup() {
  const reports: ProjectProgressProjectReport[] = [1, 2].map((projectId) => ({ projectId, projectName: `P${projectId}`, currentStatus: "updating", targetStatus: "updating", outcome: "evaluated", warnings: [], summaries: [], mutationsApplied: 0 }));
  const targets: WeeklyReportRewriteTarget[] = reports.map((report, i) => {
    const proposal = { summaryDate: "2026-09-16", sourceDigest: "facts", summary: "完成更新。", aiConfidence: 90, aiNote: "", commitCount: 1 };
    report.summaries.push(proposal);
    return { projectId: report.projectId, summaryDate: proposal.summaryDate, proposal, githubId: "alice", authorName: "Alice" };
  });
  return { targets, reports, agentLimiter: new AsyncSemaphore(1), writeLimiter: new AsyncSemaphore(1) };
}
const saved = () => ({ report_id: 12, weekly_num: 121, owner_id: 7, github_id: "alice", content_hash: contentHash("整篇新周报"), updated: true });

test("groups only the same author and day into one whole-report replacement", async () => {
  const state = setup(); let reads = 0, writes = 0, generations = 0;
  const count = await rewriteProjectWeeklyReports({ ...state, oa: {
    getWeeklyReportRewriteContext: async (input) => { reads += 1; assert.equal(input.summaryDate, "2026-09-16"); return context; },
    replaceWeeklyReport: async (input) => { writes += 1; assert.equal(input.summaryDate, "2026-09-16"); assert.equal(input.content, "整篇新周报"); return saved(); },
  }, rewriter: { rewrite: async (input) => { assert.equal(input.context.content, "原周报"); assert.deepEqual(input.summaries.map((s) => s.project_id), [1, 2]); generations += 1; return { content: "整篇新周报", interaction }; } } });
  assert.equal(count, 1); assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(generations, 1);
  for (const report of state.reports) assert.equal(report.weeklyReportSyncs?.[0]?.mode, "replace");
});

test("unchanged generated content still checks CAS and records a no-op", async () => {
  const state = setup(); let writes = 0;
  const count = await rewriteProjectWeeklyReports({ ...state, oa: {
    getWeeklyReportRewriteContext: async () => context,
    replaceWeeklyReport: async (input) => { writes++; assert.equal(input.content, context.content); return { ...saved(), updated: false }; },
  }, rewriter: { rewrite: async () => ({ content: context.content, interaction }) } });
  assert.equal(count, 0); assert.equal(writes, 1); assert.equal(state.reports[0]!.weeklyReportSyncs?.[0]?.updated, false);
});

test("content conflict rereads the edited baseline and merges the same daily summaries again", async () => {
  const state = setup(); let reads = 0, writes = 0;
  await rewriteProjectWeeklyReports({ ...state, oa: {
    getWeeklyReportRewriteContext: async () => ({ ...context, content: `新底稿${++reads}`, content_hash: contentHash(`新底稿${reads}`) }),
    replaceWeeklyReport: async (input) => {
      writes += 1;
      if (writes === 1) throw new OaRequestError("conflict", 409, "weekly_report_version_conflict");
      assert.equal(input.context.content, "新底稿2"); assert.equal(input.content, "新底稿2+当天总结"); return saved();
    },
  }, rewriter: { rewrite: async (ctx) => ({ content: `${ctx.context.content}+当天总结`, interaction }) } });
  assert.equal(reads, 2); assert.equal(writes, 2);
  assert.equal(state.reports[0]!.summaries[0]!.weeklyReportInteractions?.length, 2);
});

for (const failure of ["quality", "unavailable", "persist", "cancel", "conflict"] as const) {
  test(`keeps the previous report when ${failure} prevents a safe replacement`, async () => {
    const state = setup(); let writes = 0;
    if (failure === "persist") state.reports[1]!.warnings.push("write_failed:project conflict");
    const count = await rewriteProjectWeeklyReports({ ...state, shouldCancel: () => failure === "cancel", oa: {
      getWeeklyReportRewriteContext: async () => { if (failure === "unavailable") throw new OaRequestError("missing", 404); return context; },
      replaceWeeklyReport: async () => { writes += 1; throw new OaRequestError("conflict", 409, "weekly_report_version_conflict"); },
    }, rewriter: { rewrite: async () => ({ content: failure === "quality" ? null : "新周报", interaction }) } });
    assert.equal(count, 0); assert.equal(writes, failure === "conflict" ? 2 : 0);
    assert.ok(state.reports.every((r) => r.weeklyReportSyncs === undefined));
    assert.ok(state.reports[0]!.warnings.some((w) => w.startsWith("weekly_report_write_failed:")));
  });
}


test("different days use sequential fresh baselines instead of fetching weekly facts", async () => {
  const state = setup();
  state.targets[1]!.summaryDate = "2026-09-15";
  state.targets[1]!.proposal.summaryDate = "2026-09-15";
  let baseline = "原周报";
  const days: string[] = [];
  const count = await rewriteProjectWeeklyReports({ ...state, oa: {
    getWeeklyReportRewriteContext: async () => ({ ...context, content: baseline, content_hash: contentHash(baseline) }),
    replaceWeeklyReport: async (input) => { baseline = input.content; return saved(); },
  }, rewriter: { rewrite: async (input) => {
    days.push(input.summaryDate);
    assert.equal(input.summaries.length, 1);
    assert.equal(input.summaries[0]!.summary_date, input.summaryDate);
    assert.equal(input.context.content, baseline);
    return { content: baseline + input.summaryDate, interaction };
  } } });
  assert.equal(count, 2);
  assert.deepEqual(days, ["2026-09-15", "2026-09-16"]);
  assert.equal(baseline, "原周报2026-09-152026-09-16");
});

test("missing GitHub identity does not retry or invoke generation and other authors continue", async () => {
  const state = setup();
  state.targets[1]!.githubId = "bob";
  const reads: string[] = []; let generations = 0;
  await rewriteProjectWeeklyReports({ ...state, oa: {
    getWeeklyReportRewriteContext: async (input) => {
      reads.push(input.githubId);
      if (input.githubId === "alice") throw new OaRequestError("missing account", 404, "github_identity_not_found");
      return { ...context, github_id: "bob" };
    },
    replaceWeeklyReport: async () => ({ ...saved(), github_id: "bob" }),
  }, rewriter: { rewrite: async () => { generations++; return { content: "新周报", interaction }; } } });
  assert.deepEqual(reads, ["alice", "bob"]);
  assert.equal(generations, 1);
  assert.match(state.reports[0]!.warnings.join(" "), /github_identity_not_found/);
  assert.equal(state.reports[1]!.weeklyReportSyncs?.[0]?.updated, true);
});

test("a failed report retries in place without regenerating another author's successful report", async () => {
  const { CodexWeeklyReportRewriter } = await import("../src/application/weeklyReportRewriter.js");
  const state = setup();
  state.targets[1]!.githubId = "bob";
  const calls = { alice: 0, bob: 0 };
  const reads: string[] = [], writes: string[] = [];
  const rewriter = new CodexWeeklyReportRewriter({
    model: { provider: "openrouter", model: "test", apiKey: "fixture-key", apiBaseUrl: "https://model.test", parameters: {} },
    workingDirectory: "/tmp", retryPolicy: { maxAttempts: 3, intervalMs: 0 },
  }, async (request) => {
    const payload = JSON.parse(request.prompt);
    const author: "alice" | "bob" = payload.current_report.includes("alice") ? "alice" : "bob";
    const attempt = ++calls[author];
    const response = payload.draft
      ? { approved: !(author === "bob" && attempt === 2), issues: author === "bob" && attempt === 2 ? ["遗漏已完成工作"] : [] }
      : { content: "保留原有工作，完成本次项目更新。", source_ids: ["current-report", ...payload.daily_summaries.map((s: { source_id: string }) => s.source_id)] };
    return { finalResponse: JSON.stringify(response), usage: null, upstreamRequestId: `${author}-${attempt}`, prohibitedToolUseCount: 0 };
  });
  const count = await rewriteProjectWeeklyReports({ ...state, rewriter, oa: {
    getWeeklyReportRewriteContext: async (input) => { reads.push(input.githubId); return { ...context, github_id: input.githubId, content: `${input.githubId} 的已有工作` }; },
    replaceWeeklyReport: async (input) => { writes.push(input.githubId); return { ...saved(), github_id: input.githubId }; },
  } });
  assert.equal(count, 2);
  assert.deepEqual(calls, { alice: 2, bob: 4 });
  assert.deepEqual(reads, ["alice", "bob"]);
  assert.deepEqual(writes, ["alice", "bob"]);
});
