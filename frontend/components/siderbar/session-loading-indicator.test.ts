import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")

test("renders ShiningText while running and a compact emerald dot for unviewed completions", () => {
  const sectionsList = siderSource.match(/const SectionsList[\s\S]*?\nconst Sider =/)?.[0]
  const unreadIndicator = sectionsList?.match(
    /<span\s+data-slot="session-unread-indicator"[\s\S]*?\/>/,
  )?.[0]

  assert.ok(sectionsList, "expected the session list renderer")
  assert.doesNotMatch(siderSource, /Load1/)
  assert.match(siderSource, /import \{ ShiningText \} from "@\/components\/ui\/shining-text"/)
  assert.match(sectionsList, /sessionIndicatorStates\.get\(item\.sessionId\)/)
  assert.match(sectionsList, /indicatorState === "running"/)
  assert.match(sectionsList, /<ShiningText text=\{item\.name\}/)
  assert.match(
    sectionsList,
    /indicatorState === "paused" && item\.sessionId !== activeSessionId/,
  )
  assert.ok(unreadIndicator, "expected the unread completion indicator")
  assert.match(unreadIndicator, /h-1\.5/)
  assert.match(unreadIndicator, /w-1\.5/)
  assert.match(unreadIndicator, /bg-emerald-400/)
  assert.doesNotMatch(unreadIndicator, /bg-sky-/)
})

test("passes the live session indicator lifecycle from ChatShell into Sider", () => {
  assert.match(chatShellSource, /<Sider[\s\S]*sessionIndicatorStates=\{sessionIndicatorStates\}/)
  assert.match(chatShellSource, /setSessionIndicatorState\(sessionId, "paused"\)/)
  assert.match(chatShellSource, /setSessionIndicatorState\(sessionId, "dismissing"\)/)
  assert.match(chatShellSource, /dismissSessionIndicator\(session\.sessionId\)/)
})

test("keeps a completed background session as a dot until the user views it", () => {
  const pauseSessionIndicator = chatShellSource.match(
    /const pauseSessionIndicator = useCallback\([\s\S]*?\n  \/\/ Send a message to the AI/,
  )?.[0]
  const handleSelectSession = chatShellSource.match(
    /const handleSelectSession = useCallback\([\s\S]*?\n  const toggleSider/,
  )?.[0]

  assert.ok(pauseSessionIndicator, "expected the completed indicator lifecycle")
  assert.ok(handleSelectSession, "expected session selection handling")
  assert.match(pauseSessionIndicator, /setSessionIndicatorState\(sessionId, "paused"\)/)
  assert.match(
    pauseSessionIndicator,
    /if \(activeSessionIdRef\.current !== sessionId\) \{\s*return\s*\}/,
  )
  assert.match(pauseSessionIndicator, /dismissSessionIndicator\(sessionId\)/)
  assert.match(handleSelectSession, /dismissSessionIndicator\(session\.sessionId\)/)
})

test("holds the completed dot long enough to be visible before fading the viewed session", () => {
  assert.match(chatShellSource, /const SESSION_INDICATOR_VIEWED_HOLD_MS = 1500/)
  assert.match(chatShellSource, /}, SESSION_INDICATOR_VIEWED_HOLD_MS\)/)
})

test("does not remove a completed dot after the user switches away during its hold", () => {
  const pauseSessionIndicator = chatShellSource.match(
    /const pauseSessionIndicator = useCallback\([\s\S]*?\n  \/\/ Send a message to the AI/,
  )?.[0]

  assert.ok(pauseSessionIndicator, "expected the completed indicator lifecycle")
  assert.match(
    pauseSessionIndicator,
    /setTimeout\(\(\) => \{\s*if \(activeSessionIdRef\.current !== sessionId\) \{[\s\S]*?return[\s\S]*?\}\s*dismissSessionIndicator\(sessionId\)/,
  )
})
