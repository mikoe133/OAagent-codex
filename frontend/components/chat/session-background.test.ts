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

  assert.equal(resolveLoadedSessionMessages(cachedMessages, persistedMessages, false), cachedMessages)
})

test("keeps an empty local cache when that session still has unsynced work", () => {
  const cachedMessages: Array<{ id: string }> = []
  const persistedMessages = [{ id: "oa-message" }]

  assert.equal(resolveLoadedSessionMessages(cachedMessages, persistedMessages, true), cachedMessages)
})
