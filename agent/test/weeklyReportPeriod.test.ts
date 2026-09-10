import assert from "node:assert/strict";
import test from "node:test";
import { automationEventCreateSchema } from "../src/automation/contracts.js";
import { resolveWeeklyReportSource } from "../src/application/weeklyReportSource.js";

const event = {
  event_id: "bc80638b-19f9-4ce6-89e3-23cf394c39a6",
  event_type: "weekly_report.updated", aggregate_type: "weekly_report",
  aggregate_id: "3818", aggregate_version: "1789028263279859500",
  occurred_at: "2026-09-10T08:17:43Z",
  data: { weekly_num: 121, start_date: "2026-09-06", end_date: "2026-09-11", content: "项目 1：完成联调" },
};
test("event accepts paired calendar dates and rejects incomplete or invalid periods", () => {
  assert.equal(automationEventCreateSchema.parse(event).data.end_date, "2026-09-11");
  for (const dates of [
    { end_date: undefined }, { start_date: undefined }, { start_date: null },
    { start_date: "2026-02-30" }, { end_date: "2026-09-01" },
    { start_date: "2026-9-06" }, { start_date: "2026-09-06T00:00:00Z" },
  ]) {
    assert.equal(automationEventCreateSchema.safeParse({ ...event, data: { ...event.data, ...dates } }).success, false);
  }
  assert.equal(automationEventCreateSchema.safeParse({ ...event, data: { ...event.data, end_date: "2026-09-06" } }).success, true);
});
test("worker retains supplied period without calling OA for a complete snapshot", async () => {
  const source = await resolveWeeklyReportSource({
    ...event.data, source_report_id: "3818", source_version: event.aggregate_version,
    updated_at: event.occurred_at,
  }, async () => assert.fail("must use snapshot"));
  assert.equal(source.startDate, "2026-09-06");
  assert.equal(source.endDate, "2026-09-11");
});
