import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")

test("styles the sider search as a transparent full-width hover row", () => {
  const searchBox = siderSource.match(/const SearchBox = \([\s\S]*?\n\)\n\nconst UserInfo/)?.[0]

  assert.ok(searchBox, "expected the sider search box")
  assert.match(searchBox, /data-slot="sider-search"/)
  assert.match(searchBox, /w-full/)
  assert.match(searchBox, /bg-transparent/)
  assert.match(searchBox, /text-\[#565657\]/)
  assert.match(searchBox, /placeholder:text-\[#565657\]/)
  assert.match(searchBox, /left-3/)
  assert.match(searchBox, /pl-9/)
  assert.match(searchBox, /hover:bg-stone-100\/70/)
  assert.match(searchBox, /focus-within:bg-stone-100\/70/)
  assert.doesNotMatch(searchBox, /\bborder(?:-|\b)/)
  assert.doesNotMatch(searchBox, /\bring(?:-|\b)/)
})
