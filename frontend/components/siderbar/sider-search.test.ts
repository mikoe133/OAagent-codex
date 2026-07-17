import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")

test("styles the sider search as a borderless integrated surface", () => {
  const searchBox = siderSource.match(/const SearchBox = \([\s\S]*?\n\)\n\nconst UserInfo/)?.[0]

  assert.ok(searchBox, "expected the sider search box")
  assert.match(searchBox, /data-slot="sider-search"/)
  assert.match(searchBox, /bg-\[#f4f4f5\]/)
  assert.match(searchBox, /focus-within:shadow-/)
  assert.match(searchBox, /group-focus-within\/search:text-slate-600/)
  assert.doesNotMatch(searchBox, /\bborder(?:-|\b)/)
  assert.doesNotMatch(searchBox, /\bring(?:-|\b)/)
})
