import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveStableSessionOrder,
  sortSessionItemsByCreatedAt,
  sortSessionItemsByPinnedOrder,
} from "./session-list-order"

test("keeps creation-time order unchanged when the active session changes", () => {
  const items = [
    { sessionId: "newest", createdAt: "2026-07-15T08:00:00.000Z" },
    { sessionId: "middle", createdAt: "2026-07-14T08:00:00.000Z" },
    { sessionId: "oldest", createdAt: "2026-07-13T08:00:00.000Z" },
  ]

  const whenOldestIsActive = resolveStableSessionOrder(items, "oldest")
  const whenMiddleIsActive = resolveStableSessionOrder(items, "middle")

  assert.deepEqual(
    whenOldestIsActive.map((item) => item.sessionId),
    ["newest", "middle", "oldest"],
  )
  assert.deepEqual(
    whenMiddleIsActive.map((item) => item.sessionId),
    ["newest", "middle", "oldest"],
  )
})

test("sorts sessions from newest to oldest creation time without using update time", () => {
  const items = [
    {
      sessionId: "older-created",
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
    },
    {
      sessionId: "newer-created",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-13T08:00:00.000Z",
    },
  ]

  const sorted = sortSessionItemsByCreatedAt(items)

  assert.deepEqual(
    sorted.map((item) => item.sessionId),
    ["newer-created", "older-created"],
  )
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["older-created", "newer-created"],
  )
})

test("uses session identity as a deterministic tie-breaker for equal creation times", () => {
  const createdAt = "2026-07-15T08:00:00.000Z"
  const forward = [
    { sessionId: "session-b", createdAt },
    { sessionId: "session-a", createdAt },
  ]
  const reversed = [...forward].reverse()

  assert.deepEqual(
    sortSessionItemsByCreatedAt(forward).map((item) => item.sessionId),
    ["session-a", "session-b"],
  )
  assert.deepEqual(
    sortSessionItemsByCreatedAt(reversed).map((item) => item.sessionId),
    ["session-a", "session-b"],
  )
})

test("moves pinned sessions ahead of the existing creation-time order", () => {
  const items = [
    { sessionId: "newest" },
    { sessionId: "middle" },
    { sessionId: "oldest" },
  ]

  const sorted = sortSessionItemsByPinnedOrder(items, ["oldest", "middle"])

  assert.deepEqual(
    sorted.map((item) => item.sessionId),
    ["oldest", "middle", "newest"],
  )
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["newest", "middle", "oldest"],
  )
})

test("ignores stale pinned identities without disturbing session order", () => {
  const items = [
    { sessionId: "newest" },
    { sessionId: "oldest" },
  ]

  assert.deepEqual(
    sortSessionItemsByPinnedOrder(items, ["missing"]).map((item) => item.sessionId),
    ["newest", "oldest"],
  )
})
