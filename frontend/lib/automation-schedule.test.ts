import assert from "node:assert/strict"
import test from "node:test"

import {
  buildAutomationCronExpression,
  describeAutomationSchedule,
  parseAutomationSchedule,
} from "./automation-schedule"

test("parses common schedules into readable frequency and time", () => {
  assert.deepEqual(parseAutomationSchedule("0 20 * * 1-5"), {
    frequency: "weekdays",
    executionTime: "20:00",
  })
  assert.deepEqual(parseAutomationSchedule("30 9 * * *"), {
    frequency: "daily",
    executionTime: "09:30",
  })
  assert.deepEqual(parseAutomationSchedule("15 8 * * 1"), {
    frequency: "weekly-1",
    executionTime: "08:15",
  })
})

test("builds schedules without exposing cron syntax to users", () => {
  assert.equal(buildAutomationCronExpression("daily", "09:30"), "30 9 * * *")
  assert.equal(buildAutomationCronExpression("weekdays", "20:00"), "0 20 * * 1-5")
  assert.equal(buildAutomationCronExpression("weekly-5", "18:05"), "5 18 * * 5")
})

test("preserves unsupported existing schedules", () => {
  assert.deepEqual(parseAutomationSchedule("0 */2 * * *"), {
    frequency: "preserve-existing",
    executionTime: "20:00",
  })
  assert.equal(
    buildAutomationCronExpression("preserve-existing", "20:00", "0 */2 * * *"),
    "0 */2 * * *",
  )
})

test("prefers the OA readable schedule description", () => {
  assert.equal(describeAutomationSchedule("0 20 * * 1-5", "工作日晚上八点"), "工作日晚上八点")
  assert.equal(describeAutomationSchedule("0 20 * * 1-5"), "每个工作日 20:00")
})
