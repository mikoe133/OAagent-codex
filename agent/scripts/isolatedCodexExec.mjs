#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const codexPackageJson = require.resolve("@openai/codex/package.json")
const codexEntrypoint = path.join(path.dirname(codexPackageJson), "bin", "codex.js")
const arguments_ = process.argv.slice(2)

if (arguments_[0] !== "exec") {
  console.error("isolatedCodexExec only supports Codex exec mode")
  process.exit(2)
}

arguments_.splice(
  1,
  0,
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
)

const child = spawn(process.execPath, [codexEntrypoint, ...arguments_], {
  env: process.env,
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal)
    }
  })
}

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
