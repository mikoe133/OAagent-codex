import test from "node:test";
import assert from "node:assert/strict";
import { boundedSummaryAudit, isRetryableSummaryError, summaryDiagnostic, waitForSummaryRetry } from "../src/application/summaryRetry.js";

for (const error of [new Error("github_identity_not_found"), new Error("缺少 GitHub 账号"), new Error("模型配置无效"), new Error("未授权工具"), { status: 404 }, { status: 401 }, new Error("insufficient_quota")]) {
  test(`terminal prerequisite ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`, () => assert.equal(isRetryableSummaryError(error), false));
}
for (const error of [new Error("HTTP 429 too many requests"), new Error("HTTP 503 unavailable"), new Error("stream disconnected before completion"), new Error("weekly_report_fact_review_failed"), new SyntaxError("Unexpected token")]) {
  test(`retryable ${error.message}`, () => assert.equal(isRetryableSummaryError(error), true));
}
test("waiting retries honor cancellation", async () => {
  const controller = new AbortController();
  const waiting = waitForSummaryRetry({ maxAttempts: 3, intervalMs: 60_000 }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
test("diagnostics are bounded and redact secrets embedded in model text", () => {
  const result = summaryDiagnostic('failed raw-key token=secret-token Bearer credential https://host.test?key=secret', ['raw-key']);
  assert.doesNotMatch(result, /raw-key|secret-token|credential|host.test/);
  assert.equal(summaryDiagnostic("x".repeat(30000)).length, 20000);
});

test("audit fits the persistence limit with ten large failures including Chinese and JSON escapes", () => {
  const attempts = Array.from({ length: 10 }, (_, index) => ({
    attempt: index + 1, status: "failed", phase: "review", error_code: "weekly_report_fact_review_failed",
    reason: "审核拒绝", retryable: true, will_retry: index < 9,
    generation_request_id: "request-" + "a".repeat(200),
    draft_content: "正文".repeat(10_000), generation_response: "\u0000".repeat(20_000),
    review_response: "审核".repeat(10_000), review_issues: Array(100).fill("问题".repeat(500)),
  }));
  const audit = boundedSummaryAudit({ attempts, retry_scope: "weekly_report", max_attempts: 10 });
  assert.ok(Buffer.byteLength(JSON.stringify(audit), "utf8") <= 240 * 1024);
  assert.equal(audit.diagnostics_truncated, true);
  const saved = audit.attempts as typeof attempts;
  assert.equal(saved.length, 10);
  assert.equal(saved[0]!.review_issues.length, 100);
  assert.equal(saved[0]!.generation_request_id, attempts[0]!.generation_request_id);
  assert.equal(saved[0]!.error_code, attempts[0]!.error_code);
  assert.equal(saved[9]!.will_retry, false);
  assert.equal(attempts[0]!.draft_content.length, 20_000);
  const small = { attempts: [{ attempt: 1, reason: "模型超时" }] };
  assert.deepEqual(boundedSummaryAudit(small), small);
});
