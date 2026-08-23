#!/usr/bin/env node

import { stringifyJsonLineSafe } from "./jsonLineSafe.mjs";

const args = parseArgs(process.argv.slice(2));
const url = process.env.CALL_KNOWLEDGE_BASE_API_URL;
const token = process.env.CALL_KNOWLEDGE_BASE_API_TOKEN;

if (!url || !token) {
  console.error(
    "CALL_KNOWLEDGE_BASE_API_URL 或 CALL_KNOWLEDGE_BASE_API_TOKEN 未配置;当前没有可用的受控知识库 API 工具。",
  );
  process.exit(2);
}

const response = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify({
    sessionId: args.sessionId || process.env.CALL_KNOWLEDGE_BASE_API_SESSION_ID,
    operationId: args.operationId,
    pathParams: parseJsonArg(args.pathParams, "pathParams"),
    query: parseJsonArg(args.query, "query"),
    body: parseJsonArg(args.body, "body"),
    confirmed: parseBooleanArg(args.confirmed),
  }),
});

const text = await response.text();
let data;
try {
  data = text ? JSON.parse(text) : null;
} catch {
  data = text;
}
console.log(stringifyJsonLineSafe(data, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = "true";
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function parseJsonArg(value, name) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error(`${name} 必须是合法 JSON: ${error.message}`);
    process.exit(2);
  }
}

function parseBooleanArg(value) {
  if (value === undefined) return undefined;
  return value === "true" || value === "1" || value === "yes";
}
