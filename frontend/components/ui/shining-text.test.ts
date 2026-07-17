import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const shiningTextSource = readFileSync(new URL("./shining-text.tsx", import.meta.url), "utf8")

test("uses the provided motion shimmer without changing compact sidebar typography", () => {
  assert.match(shiningTextSource, /import \{ motion \} from "motion\/react"/)
  assert.match(shiningTextSource, /baseColor = "#404040"/)
  assert.match(shiningTextSource, /backgroundImage:/)
  assert.match(shiningTextSource, /linear-gradient\(110deg, \$\{baseColor\}/)
  assert.match(shiningTextSource, /backgroundPosition: "200% 0"/)
  assert.match(shiningTextSource, /backgroundPosition: "-200% 0"/)
  assert.match(shiningTextSource, /repeat: Infinity/)
  assert.match(shiningTextSource, /duration: 2/)
  assert.match(shiningTextSource, /motion\.span/)
  assert.match(shiningTextSource, /text-sm/)
})
