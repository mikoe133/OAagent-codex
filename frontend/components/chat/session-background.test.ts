import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { resolveLoadedSessionMessages } from "./session-messages"

const chatShellSource = readFileSync(new URL("./chat-shell.tsx", import.meta.url), "utf8")

function callbackSource(name: string, nextName: string): string {
  const callback = chatShellSource.match(
    new RegExp(`const ${name} = useCallback\\([\\s\\S]*?\\n  const ${nextName}`),
  )?.[0]

  assert.ok(callback, `expected ${name} callback`)
  return callback
}

test("switching to an existing session leaves its background request running", () => {
  const handleSelectSession = callbackSource("handleSelectSession", "toggleSider")

  assert.doesNotMatch(handleSelectSession, /\.abort\(\)/)
  assert.doesNotMatch(handleSelectSession, /activeSessionRunsRef\.current\.delete/)
  assert.match(handleSelectSession, /sessionMessagesRef\.current\.get\(session\.sessionId\)/)
  assert.match(handleSelectSession, /resolveLoadedSessionMessages\(/)
})

test("starting a new session does not abort the previous session", () => {
  const startNewSession = callbackSource("startNewSession", "handleDeleteSession")

  assert.doesNotMatch(startNewSession, /\.abort\(\)/)
  assert.match(startNewSession, /setActiveWorkspaceView\("conversation"\)/)
  assert.match(startNewSession, /sessionMessagesRef\.current\.set\(nextAgentSessionId, \[\]\)/)
})

test("selecting a conversation returns from automated tasks to chat", () => {
  const handleSelectSession = callbackSource("handleSelectSession", "toggleSider")

  assert.match(handleSelectSession, /setActiveWorkspaceView\("conversation"\)/)
})

test("tracks active requests independently for each session", () => {
  assert.match(chatShellSource, /activeSessionRunsRef = useRef\(new Map<string, ActiveSessionRun>\(\)\)/)
  assert.match(chatShellSource, /runningSessionIds\.has\(agentSessionId\)/)
  assert.match(chatShellSource, /activeSessionRunsRef\.current\.set\(currentAgentSessionId,/)
})

test("uses persisted OA history when the local session cache is empty", () => {
  const persistedMessages = [{ id: "oa-message" }]

  assert.equal(resolveLoadedSessionMessages([], persistedMessages, false), persistedMessages)
})

test("keeps non-empty local messages while a session continues in the background", () => {
  const cachedMessages = [{ id: "local-message" }]
  const persistedMessages = [{ id: "oa-message" }]

  assert.equal(resolveLoadedSessionMessages(cachedMessages, persistedMessages, true), cachedMessages)
})

test("keeps an empty local cache when that session still has unsynced work", () => {
  const cachedMessages: Array<{ id: string }> = []
  const persistedMessages = [{ id: "oa-message" }]

  assert.equal(resolveLoadedSessionMessages(cachedMessages, persistedMessages, true), cachedMessages)
})

test("server history corrects a device's cached duration even without trace data", () => {
  const cached = [{ id: "same:assistant", content: "answer", durationMs: 210_000 }]
  const persisted = [{ id: "same:assistant", content: "answer", durationMs: 193_992 }]
  const result = resolveLoadedSessionMessages(cached, persisted, false)
  assert.equal(result[0]?.durationMs, 193_992)
  assert.equal(cached[0]?.durationMs, 210_000)
  assert.equal(result[0]?.content, "answer")
})

test("server zero or missing duration is not replaced by a device's cached timing", () => {
  const cached: Array<{ id: string; durationMs?: number }> = [{ id: "same:assistant", durationMs: 12_000 }]
  assert.equal(resolveLoadedSessionMessages(cached, [{ id: "same:assistant", durationMs: 0 }], false)[0]?.durationMs, 0)
  assert.equal(resolveLoadedSessionMessages(cached, [{ id: "same:assistant" }], false)[0]?.durationMs, undefined)
  assert.equal(resolveLoadedSessionMessages(cached, [{ id: "same:assistant", durationMs: 0 }], true), cached)
})

test("a device with older cached history loads new server messages in server order", () => {
  const cached = [
    { id: "first:user", content: "first" },
    { id: "first:assistant", content: "first answer", durationMs: 210_000 },
    { id: "local:user", content: "not yet committed" },
  ]
  const persisted = [
    { id: "first:user", content: "first" },
    { id: "first:assistant", content: "first answer", durationMs: 193_992 },
    { id: "second:user", content: "sent from another device" },
    { id: "second:assistant", content: "second answer", durationMs: 47_525 },
  ]

  const result = resolveLoadedSessionMessages(cached, persisted, false)
  assert.deepEqual(result.map(message => message.id), [
    "first:user", "first:assistant", "second:user", "second:assistant", "local:user",
  ])
  assert.equal(result[1]?.durationMs, 193_992)
  assert.equal(result[3]?.durationMs, 47_525)
  assert.equal(cached[1]?.durationMs, 210_000)
  assert.equal(cached.length, 3)
})

test("reselecting an active session preserves live messages until its request is synced", () => {
  const cached: Array<{ id: string; content: string; durationMs?: number }> = [
    { id: "live:assistant", content: "streaming" },
  ]
  const persisted = [{ id: "old:assistant", content: "old answer", durationMs: 1_000 }]
  assert.equal(resolveLoadedSessionMessages(cached, persisted, true), cached)
})

test("missing server history preserves local-only messages without mutating the cache", () => {
  const cached = [{ id: "local:assistant", content: "unsynced answer", durationMs: 1_000 }]
  assert.equal(resolveLoadedSessionMessages(cached, [], false), cached)
})

test("matching cached messages retain richer local trace when server history has no trace", () => {
  const cached = [{ id: "same:assistant", content: "answer", durationMs: 9_000, toolSteps: [{ id: "lookup" }] }]
  const persisted = [{ id: "same:assistant", content: "answer", durationMs: 1_000 }]
  const result = resolveLoadedSessionMessages<{ id: string; content: string; durationMs: number; toolSteps?: { id: string }[] }>(cached, persisted, false)
  assert.equal(result[0]?.durationMs, 1_000)
  assert.equal(result[0]?.toolSteps, cached[0]?.toolSteps)
})
