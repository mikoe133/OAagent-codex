import assert from "node:assert/strict"
import test from "node:test"

import { prioritizeSessionItem } from "./session-list-order"

test("prioritizes the exact newly created session record without reordering the remaining items", () => {
  const items = [
    { sessionId: "new-session", recordId: "older-record" },
    { sessionId: "other-session", recordId: "other-record" },
    { sessionId: "new-session", recordId: "current-record" },
  ]

  const prioritized = prioritizeSessionItem(items, {
    sessionId: "new-session",
    recordId: "current-record",
  })

  assert.deepEqual(
    prioritized.map((item) => item.recordId),
    ["current-record", "older-record", "other-record"],
  )
  assert.deepEqual(
    items.map((item) => item.recordId),
    ["older-record", "other-record", "current-record"],
  )
})
