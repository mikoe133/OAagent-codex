import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const globalsSource = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8")

test("offers persisted font-size modes in the sider user menu", () => {
  assert.match(siderSource, /import \{[^}]*Type[^}]*\} from "lucide-react"/)
  assert.match(siderSource, /字体大小/)
  assert.match(siderSource, /value: "small", label: "小", rootFontSize: "87\.5%"/)
  assert.match(siderSource, /value: "default", label: "标准", rootFontSize: "100%"/)
  assert.match(siderSource, /value: "large", label: "大", rootFontSize: "112\.5%"/)
  assert.match(siderSource, /value: "extra-large", label: "特大", rootFontSize: "125%"/)
  assert.match(siderSource, /window\.localStorage\.setItem\(FONT_SIZE_STORAGE_KEY, value\)/)
  assert.match(siderSource, /document\.documentElement\.dataset\.fontSize = mode/)
  assert.match(siderSource, /document\.documentElement\.style\.fontSize = selectedMode\.rootFontSize/)
})

test("maps each font-size mode to a root rem scale", () => {
  assert.match(globalsSource, /html\[data-font-size="small"\]\s*\{\s*font-size: 87\.5%;/)
  assert.match(globalsSource, /html\[data-font-size="large"\]\s*\{\s*font-size: 112\.5%;/)
  assert.match(globalsSource, /html\[data-font-size="extra-large"\]\s*\{\s*font-size: 125%;/)
})
