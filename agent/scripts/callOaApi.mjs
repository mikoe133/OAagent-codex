#!/usr/bin/env node

import { stringifyJsonLineSafe } from "./jsonLineSafe.mjs";
import { postControlledTool, toolResultExitCode } from './controlledToolRequest.mjs';

const args = parseArgs(process.argv.slice(2));
const url = process.env.CALL_OA_API_URL;
const token = process.env.CALL_OA_API_TOKEN;

if (!url || !token) {
  console.error(
    "CALL_OA_API_URL 或 CALL_OA_API_TOKEN 未配置;当前没有可用的受控 OA API 调用工具。",
  );
  process.exit(2);
}

const payload = {
  sessionId: args.sessionId || process.env.CALL_OA_API_SESSION_ID,
  operationId: args.operationId,
  method: args.method,
  path: args.path,
  pathParams: parseJsonArg(args.pathParams, "pathParams"),
  query: parseJsonArg(args.query, "query"),
  body: parseJsonArg(args.body, "body"),
  confirmed: parseBooleanArg(args.confirmed),
  responseId: args.responseId,
  action: args.action,
  responsePath: args.responsePath,
  conditions: parseJsonArg(args.conditions, "conditions"),
  fields: parseJsonArg(args.fields, "fields"),
  groupBy: args.groupBy,
  offset: parseIntegerArg(args.offset, "offset"),
  limit: parseIntegerArg(args.limit, "limit"),
};

const data = await postControlledTool(url, token, payload);
console.log(stringifyJsonLineSafe(data, 2));
process.exitCode = toolResultExitCode(data);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function parseJsonArg(value, name) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error(`${name} 必须是合法 JSON: ${error.message}`);
    process.exit(2);
  }
}

function parseBooleanArg(value) {
  if (value === undefined) {
    return undefined;
  }
  return value === "true" || value === "1" || value === "yes";
}

function parseIntegerArg(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    console.error(`${name} 必须是非负整数。`);
    process.exit(2);
  }
  return Number(value);
}
