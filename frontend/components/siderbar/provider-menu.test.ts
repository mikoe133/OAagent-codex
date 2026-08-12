import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")

test("renders provider choices in a right-side hover submenu", () => {
  const providerSubmenu = siderSource.match(/<DropdownMenuSub>[\s\S]*?<\/DropdownMenuSub>/)?.[0]

  assert.doesNotMatch(siderSource, /from "@\/components\/ui\/m3-dropdown-menu"/)
  assert.ok(providerSubmenu, "expected the model provider submenu")
  assert.match(providerSubmenu, /<DropdownMenuSubTrigger[\s\S]*模型提供商[\s\S]*<\/DropdownMenuSubTrigger>/)
  assert.match(providerSubmenu, /<DropdownMenuSubContent\s+sideOffset=\{8\}[\s\S]*MODEL_PROVIDERS\.map/)
})

test("centers the user-menu expand icon inside its trigger", () => {
  const userMenuTrigger = siderSource.match(/<DropdownMenuTrigger[\s\S]*?aria-label="Open user menu"[\s\S]*?<\/DropdownMenuTrigger>/)?.[0]

  assert.ok(userMenuTrigger, "expected the user-menu trigger")
  assert.match(userMenuTrigger, /className="[^"]*inline-flex[^"]*items-center[^"]*justify-center[^"]*"/)
  assert.match(userMenuTrigger, /<ChevronsUpDown className="h-4 w-4"/)
})
