import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")

test("renders provider choices in a right-side hover submenu", () => {
  const providerSubmenu = [...siderSource.matchAll(/<DropdownMenuSub>[\s\S]*?<\/DropdownMenuSub>/g)]
    .map((match) => match[0])
    .find((submenu) => submenu.includes("模型提供商"))

  assert.doesNotMatch(siderSource, /from "@\/components\/ui\/m3-dropdown-menu"/)
  assert.ok(providerSubmenu, "expected the model provider submenu")
  assert.match(providerSubmenu, /<DropdownMenuSubTrigger[\s\S]*模型提供商[\s\S]*<\/DropdownMenuSubTrigger>/)
  assert.match(providerSubmenu, /<DropdownMenuSubContent\s+sideOffset=\{8\}[\s\S]*MODEL_PROVIDERS\.map/)
})

test("renders developer mode before providers and reveals router configuration only when enabled", () => {
  const developerModeIndex = siderSource.indexOf("开发模式")
  const routerModelIndex = siderSource.indexOf("路由模型配置")
  const providerIndex = siderSource.indexOf("模型提供商")

  assert.ok(developerModeIndex >= 0, "expected developer mode menu")
  assert.ok(routerModelIndex > developerModeIndex, "expected router model after developer mode")
  assert.ok(providerIndex > routerModelIndex, "expected provider menu after developer options")
  assert.match(siderSource, /value=\{developerMode \? "enabled" : "disabled"\}/)
  assert.match(siderSource, /developerMode\s*\?\s*\([\s\S]*路由模型配置[\s\S]*ROUTER_MODELS\.map/)
  assert.match(siderSource, />\s*关闭\s*<\/DropdownMenuRadioItem>/)
  assert.match(siderSource, />\s*开启\s*<\/DropdownMenuRadioItem>/)
})

test("shows the selected router and fixed fallback models as checked together", () => {
  const routerMenuStart = siderSource.indexOf("路由模型配置")
  const routerMenuEnd = siderSource.indexOf("</DropdownMenuSub>", routerMenuStart)
  const routerSubmenu = routerMenuStart >= 0 && routerMenuEnd >= 0
    ? siderSource.slice(routerMenuStart, routerMenuEnd)
    : ""

  assert.ok(routerSubmenu, "expected the router model submenu")
  assert.match(routerSubmenu, /<DropdownMenuCheckboxItem/)
  assert.match(routerSubmenu, /const isDefaultFallback = model\.id === DEFAULT_ROUTER_MODEL/)
  assert.match(routerSubmenu, /const isChecked = isDefaultFallback \|\| model\.id === selectedRouterModel/)
  assert.match(routerSubmenu, /disabled=\{providerSwitchDisabled \|\| isDefaultFallback\}/)
  assert.doesNotMatch(routerSubmenu, /<DropdownMenuRadioGroup/)
})

test("defaults developer mode to disabled and persists developer preferences", () => {
  assert.match(chatShellSource, /const \[developerMode, setDeveloperMode\] = useState\(false\)/)
  assert.match(chatShellSource, /localStorage\.getItem\(DEVELOPER_MODE_STORAGE_KEY\) === "enabled"/)
  assert.match(chatShellSource, /localStorage\.setItem\(ROUTER_MODEL_STORAGE_KEY, model\)/)
})

test("keeps the selected router model active after developer mode is disabled", () => {
  assert.match(chatShellSource, /developerMode,\s*routerModel:\s*selectedRouterModel,/)
  assert.doesNotMatch(chatShellSource, /developerMode\s*\?\s*\{\s*routerModel:/)
})

test("centers the user-menu expand icon inside its trigger", () => {
  const userMenuTrigger = siderSource.match(/<DropdownMenuTrigger[\s\S]*?aria-label="Open user menu"[\s\S]*?<\/DropdownMenuTrigger>/)?.[0]

  assert.ok(userMenuTrigger, "expected the user-menu trigger")
  assert.match(userMenuTrigger, /className="[^"]*inline-flex[^"]*items-center[^"]*justify-center[^"]*"/)
  assert.match(userMenuTrigger, /<ChevronsUpDown className="h-4 w-4"/)
})
