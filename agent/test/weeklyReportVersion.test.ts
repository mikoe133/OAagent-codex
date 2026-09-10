import assert from "node:assert/strict";
import test from "node:test";
import { isWeeklyReportVersion, normalizeWeeklyReportVersion, compareWeeklyReportVersions } from "../src/domain/weeklyReportVersion.js";
import { automationEventCreateSchema } from "../src/automation/contracts.js";

test("accepts production database BIGINT strings without rounding adjacent versions", () => {
  const version = "1789023613519811600";
  assert.equal(isWeeklyReportVersion(version), true);
  assert.equal(normalizeWeeklyReportVersion(version), version);
  assert.equal(compareWeeklyReportVersions(version, "1789023613519811601"), -1);
  assert.equal(compareWeeklyReportVersions("10", "9"), 1);
  assert.equal(compareWeeklyReportVersions("7", 7), 0);
  assert.equal(normalizeWeeklyReportVersion(1789023613519811600), version);
});

test("event ingestion preserves large decimal string versions and supports legacy numbers", () => {
  const event = {
    event_id: "bc80638b-19f9-4ce6-89e3-23cf394c39a6",
    event_type: "weekly_report.updated", aggregate_type: "weekly_report",
    aggregate_id: "3818", aggregate_version: "1789023613519811601",
    occurred_at: "2026-09-10T07:00:13.519667Z",
    data: { weekly_num: 121, content: "项目 51：完成联调" },
  };
  assert.equal(automationEventCreateSchema.parse(event).aggregate_version, event.aggregate_version);
  assert.equal(automationEventCreateSchema.parse({ ...event, aggregate_version: 7 }).aggregate_version, 7);
  for (const invalid of [0, -1, 1.5, "1.5", "-1", "0", "1e18", "9223372036854775808"]) {
    assert.equal(automationEventCreateSchema.safeParse({ ...event, aggregate_version: invalid }).success, false);
  }
});

test("production snapshot uses its content without calling the missing OA read endpoint", async () => {
  const { resolveWeeklyReportSource } = await import("../src/application/weeklyReportSource.js");
  const snapshot = {
    source_report_id: "3818", source_version: "1789023613519811600",
    weekly_num: 121, updated_at: "2026-09-10T07:00:13.519667Z", content: "项目 51：完成联调",
  };
  const result = await resolveWeeklyReportSource(snapshot, async () => {
    assert.fail("Complete database snapshots must not call GET /internal/weekly-reports");
  });
  assert.equal(result.version, snapshot.source_version);
  assert.equal(result.content, snapshot.content);
});

test("fallback read compares adjacent large versions exactly", async () => {
  const { resolveWeeklyReportSource } = await import("../src/application/weeklyReportSource.js");
  await assert.rejects(resolveWeeklyReportSource({
    source_report_id: "3818", source_version: "1789023613519811600",
  }, async () => ({
    id: "3818", version: "1789023613519811601", weeklyNum: 121,
    updatedAt: "2026-09-10T07:00:13.519667Z", content: "new", ownerId: null,
  })), /周报源版本已推进/);
});
