import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const typingIndicatorSource = readFileSync(new URL("./typing-indicator.tsx", import.meta.url), "utf8")
const shiningTextSource = readFileSync(new URL("../ui/shining-text.tsx", import.meta.url), "utf8")

test("shows a borderless shimmering Thinking label instead of typing dots", () => {
  assert.match(typingIndicatorSource, /import \{ ShiningText \} from "@\/components\/ui\/shining-text"/)
  assert.match(typingIndicatorSource, /import \{ ChevronRight \} from "lucide-react"/)
  assert.match(typingIndicatorSource, /data-slot="thinking-indicator"/)
  assert.match(typingIndicatorSource, /<ShiningText text="Thinking" baseColor="#9e9fa9" \/>/)
  assert.match(typingIndicatorSource, /<ChevronRight[\s\S]*?text-\[#9e9fa9\]/)
  assert.doesNotMatch(typingIndicatorSource, /AnimatedOrb/)
  assert.doesNotMatch(typingIndicatorSource, /animate-bounce/)
  assert.doesNotMatch(typingIndicatorSource, /rounded-2xl/)
})

test("supports a custom shimmer base color without changing the sider default", () => {
  assert.match(shiningTextSource, /baseColor\?: string/)
  assert.match(shiningTextSource, /baseColor = "#404040"/)
  assert.match(shiningTextSource, /backgroundImage:/)
  assert.match(shiningTextSource, /\$\{baseColor\}/)
})
