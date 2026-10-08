#!/usr/bin/env node
import { stringifyJsonLineSafe } from './jsonLineSafe.mjs';

try {
  const args = process.argv.slice(2), index = args.indexOf('--input');
  if (index < 0 || !args[index + 1]) throw new Error('Usage: node scripts/requestConfirmation.mjs --input \'{"title":"...","description":"...","actions":["..."]}\'');
  const url = process.env.CALL_CHAT_CONFIRMATION_URL;
  const token = process.env.CALL_CHAT_CONFIRMATION_TOKEN;
  const sessionId = process.env.CALL_OA_API_SESSION_ID;
  if (!url || !token || !sessionId) throw new Error('当前会话未配置确认工具');
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, confirmation: JSON.parse(args[index + 1]) }), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  console.log(stringifyJsonLineSafe(result, 2));
  if (!response.ok || result.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : '确认请求失败');
  process.exitCode = 1;
}
