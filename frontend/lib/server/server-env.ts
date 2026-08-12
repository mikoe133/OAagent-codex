import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export function readServerEnvValue(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key]?.trim() || null
  }

  const cwd = process.cwd()
  const candidates = [
    resolve(cwd, ".env.local"),
    resolve(cwd, ".env"),
    resolve(cwd, "..", ".env.local"),
    resolve(cwd, "..", ".env"),
  ]

  for (const filePath of candidates) {
    const value = readEnvFileValue(filePath, key)
    if (value) {
      return value
    }
  }

  return null
}

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }

  let lines: string[]
  try {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/)
  } catch {
    return null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex < 0 || line.slice(0, separatorIndex).trim() !== key) {
      continue
    }

    return line.slice(separatorIndex + 1).trim().replace(/^(['"])(.*)\1$/, "$2") || null
  }

  return null
}
