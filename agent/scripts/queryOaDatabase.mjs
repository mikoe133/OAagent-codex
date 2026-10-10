#!/usr/bin/env node
// Credentials remain in the server; this process only receives a session-scoped capability.
import { stringifyJsonLineSafe } from "./jsonLineSafe.mjs";
import { postControlledTool, toolResultExitCode } from './controlledToolRequest.mjs';
const args = process.argv.slice(2);
const payloadIndex = args.indexOf("--input");
if (payloadIndex < 0 || !args[payloadIndex + 1]) {
  console.error('Usage: node scripts/queryOaDatabase.mjs --input \'{"action":"catalog"}\'');
  process.exit(2);
}
try {
  const input = JSON.parse(args[payloadIndex + 1]);
  const url = process.env.CALL_OA_READ_URL;
  const token = process.env.CALL_OA_READ_TOKEN;
  const sessionId = process.env.CALL_OA_API_SESSION_ID;
  if (!url || !token || !sessionId) throw new Error("只读数据库查询工具未配置");
  const result = await postControlledTool(url, token, { ...input, sessionId });
  console.log(stringifyJsonLineSafe(result, 2));
  process.exitCode = toolResultExitCode(result);
} catch (e) {
  console.error(e instanceof SyntaxError ? "--input 必须是合法 JSON" : e.message);
  process.exitCode = 1;
}
