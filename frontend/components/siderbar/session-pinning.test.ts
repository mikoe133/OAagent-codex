import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")

test("renders a pin control immediately before each conversation delete control", () => {
  const sectionsList = siderSource.match(/const SectionsList[\s\S]*?\nconst Sider =/)?.[0]

  assert.ok(sectionsList, "expected the session list renderer")
  assert.match(siderSource, /\bPin\b/)
  assert.match(siderSource, /data-slot="session-pin-button"/)
  assert.match(siderSource, /aria-pressed=\{isPinned\}/)
  assert.notEqual(sectionsList.indexOf("<PinConversationButton"), -1)
  assert.notEqual(sectionsList.indexOf("<DeleteConversationButton"), -1)
  assert.ok(
    sectionsList.indexOf("<PinConversationButton") < sectionsList.indexOf("<DeleteConversationButton"),
    "expected the pin button before the delete button",
  )
})

test("marks pinned conversations with the requested pink left border", () => {
  assert.match(siderSource, /border-\[#ec4899\]/)
  assert.match(siderSource, /isPinned=\{isPinned\}/)
  assert.match(siderSource, /pinnedSessionIds\.includes\(item\.sessionId\)/)
})

test("uses gray pin states with a pale idle background and no pinned background", () => {
  const pinButton = siderSource.match(
    /const PinConversationButton[\s\S]*?\nconst DeleteConversationButton/,
  )?.[0]

  assert.ok(pinButton, "expected the pin button component")
  assert.match(pinButton, /bg-\[#f5f5f5\] text-slate-400/)
  assert.match(pinButton, /hover:text-slate-700/)
  assert.match(pinButton, /bg-transparent text-\[#cfd5df\] opacity-100/)
  assert.match(pinButton, /theme-dark:text-\[#cfd5df\]/)
  assert.match(pinButton, /bg-\[#f5f5f5\] text-slate-400 opacity-0/)
  assert.match(pinButton, /group-hover:opacity-100/)
  assert.match(pinButton, /isPinned && "fill-current"/)
  assert.doesNotMatch(pinButton, /fill-\[#ec4899\]/)
})

test("persists pinned session order and applies it before rendering", () => {
  assert.match(siderSource, /PINNED_SESSIONS_STORAGE_KEY/)
  assert.match(siderSource, /window\.localStorage\.setItem/)
  assert.match(siderSource, /sortSessionItemsByPinnedOrder/)
})
