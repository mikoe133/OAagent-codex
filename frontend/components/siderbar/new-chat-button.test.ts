import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")

test("places the new chat button below the divider and above the session messages", () => {
  const searchPanelIndex = siderSource.indexOf('data-slot="sider-search-panel"')
  const buttonIndex = siderSource.indexOf('data-slot="new-chat-button"')
  const sessionListIndex = siderSource.indexOf("ref={sessionListRef}")
  const searchPanel = siderSource.match(
    /<div[\s\S]*?data-slot="sider-search-panel"[\s\S]*?<\/div>/,
  )?.[0]

  assert.notEqual(searchPanelIndex, -1, "expected a divided search panel")
  assert.ok(searchPanel, "expected the sider search panel")
  assert.match(searchPanel, /border-b/)
  assert.doesNotMatch(searchPanel, /data-slot="new-chat-button"/)
  assert.notEqual(buttonIndex, -1, "expected a new chat button in the sider")
  assert.ok(searchPanelIndex < buttonIndex, "expected the new chat button below the divider")
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

test("moves the desktop new chat action from floating controls into the sider", () => {
  const desktopControls = chatShellSource.match(
    /<div ref=\{sidebarControlsRef\}[\s\S]*?<\/div>/,
  )?.[0]

  assert.ok(desktopControls, "expected desktop sidebar controls")
  assert.doesNotMatch(desktopControls, /aria-label="New chat"/)
  assert.match(chatShellSource, /<Sider[\s\S]*?onNewSession=\{startNewSession\}/)
})
