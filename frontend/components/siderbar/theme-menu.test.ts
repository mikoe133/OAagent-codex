import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const layoutSource = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8")
const globalsSource = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")

test("offers system, light, and dark theme modes in the sider user menu", () => {
  assert.match(siderSource, /import \{ useTheme \} from "next-themes"/)
  assert.match(siderSource, /主题模式/)
  assert.match(siderSource, /value: "system", label: "跟随系统"/)
  assert.match(siderSource, /value: "light", label: "浅色模式"/)
  assert.match(siderSource, /value: "dark", label: "暗色模式"/)
  assert.match(siderSource, /<DropdownMenuRadioGroup value=\{selectedTheme\} onValueChange=\{setTheme\}>/)
})

test("configures the root theme provider with light as the default", () => {
  assert.match(layoutSource, /<ThemeProvider[\s\S]*?attribute="class"/)
  assert.match(layoutSource, /defaultTheme="light"/)
  assert.match(layoutSource, /enableSystem/)
  assert.match(layoutSource, /suppressHydrationWarning/)
})

test("provides a dark surface for the primary chat shell", () => {
  assert.match(globalsSource, /@custom-variant theme-dark \(&:is\(\.dark \*\)\)/)
  assert.match(chatShellSource, /bg-stone-50 theme-dark:bg-zinc-950/)
  assert.match(siderSource, /theme-dark:bg-zinc-950\/95/)
  assert.doesNotMatch(siderSource, /(?<!theme-)dark:bg-zinc-950\/95/)
})
