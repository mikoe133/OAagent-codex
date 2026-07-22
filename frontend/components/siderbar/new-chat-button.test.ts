import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")

test("places search and new chat in one borderless 3:2 row above the session messages", () => {
  const actionRowIndex = siderSource.indexOf('data-slot="sider-actions"')
  const buttonIndex = siderSource.indexOf('data-slot="new-chat-button"')
  const sessionListIndex = siderSource.indexOf("ref={sessionListRef}")
  const actionRow = siderSource.match(
    /<div\s+data-slot="sider-actions"[\s\S]*?<SearchBox[\s\S]*?<button[\s\S]*?data-slot="new-chat-button"[\s\S]*?<\/button>\s*<\/div>/,
  )?.[0]

  assert.notEqual(actionRowIndex, -1, "expected a shared sider action row")
  assert.ok(actionRow, "expected search and new chat in the same row")
  assert.match(actionRow, /grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/)
  assert.doesNotMatch(actionRow, /border-b/)
  assert.ok(actionRowIndex < buttonIndex, "expected search before the new chat button")
  assert.ok(buttonIndex < sessionListIndex, "expected the new chat button above the session list")
})

test("styles the new chat button as a borderless rounded zinc surface", () => {
  const newChatButton = siderSource.match(
    /<button[\s\S]*?data-slot="new-chat-button"[\s\S]*?<\/button>/,
  )?.[0]

  assert.ok(newChatButton, "expected the sider new chat button")
  assert.match(newChatButton, /onClick=\{onNewSession\}/)
  assert.match(newChatButton, /border-0/)
  assert.match(newChatButton, /rounded-lg/)
  assert.match(newChatButton, /bg-\[#f4f4f5\]/)
})

test("keeps the session list close to the new chat button", () => {
  const sessionList = siderSource.match(
    /<div\s+ref=\{sessionListRef\}[\s\S]*?>/,
  )?.[0]
  const topFade = siderSource.match(
    /<div\s+className="pointer-events-none absolute inset-x-0 top-0[^\"]*"/,
  )?.[0]

  assert.ok(sessionList, "expected the sider session list")
  assert.match(sessionList, /pt-4/)
  assert.match(sessionList, /pb-20/)
  assert.doesNotMatch(sessionList, /py-20/)
  assert.ok(topFade, "expected the session list top fade")
  assert.match(topFade, /h-4/)
  assert.doesNotMatch(topFade, /h-24/)
})

test("moves the desktop new chat action from floating controls into the sider", () => {
  const desktopControls = chatShellSource.match(
    /<div ref=\{sidebarControlsRef\}[\s\S]*?<\/div>/,
  )?.[0]

  assert.ok(desktopControls, "expected desktop sidebar controls")
  assert.doesNotMatch(desktopControls, /aria-label="New chat"/)
  assert.match(chatShellSource, /<Sider[\s\S]*?onNewSession=\{handleMobileNewSession\}/)
})

test("exposes the conversation list as a mobile drawer", () => {
  assert.match(chatShellSource, /aria-label="Open conversations"/)
  assert.match(chatShellSource, /data-slot="mobile-sider-backdrop"/)
  assert.match(chatShellSource, /setIsMobileSiderOpen\(true\)/)
  assert.match(siderSource, /isMobileOpen\?: boolean/)
  assert.match(siderSource, /aria-label="Close conversations"/)
  assert.match(siderSource, /invisible -translate-x-full pointer-events-none/)
  assert.match(siderSource, /w-\[min\(20rem,calc\(100vw-3rem\)\)\]/)
})
