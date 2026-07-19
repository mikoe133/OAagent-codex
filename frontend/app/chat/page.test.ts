import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chatPageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

test("uses the product name as the chat browser tab title", () => {
  assert.match(chatPageSource, /title: "元始 OS-Agent"/)
  assert.doesNotMatch(chatPageSource, /title: "Chat - OA Agent"/)
})
