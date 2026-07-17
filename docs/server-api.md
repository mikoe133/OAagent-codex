# 服务端接口文档

本文档描述本项目自带的后台服务接口,也就是 `npm run dev:server` 启动的 TypeScript HTTP 服务。它不是 OA 业务后端接口契约;agent 优先读取 `OA_OPENAPI_URL`,远程不可用或内容非法时回退到 `agent/openapi/openapi.json`,并把选中的契约作为回答 OA 接口问题的事实来源。

## 基本信息

- 默认地址:`http://127.0.0.1:3000`
- 启动命令:`npm run dev:server`
- 默认 session 存储:`.context/agent-sessions.json`
- 请求/响应格式:`application/json; charset=utf-8`
- 响应头:`cache-control: no-store`
- 流式接口响应格式:`text/event-stream; charset=utf-8`
- 最大请求体:128 KiB
- `POST` JSON 请求体必须是 JSON object;空请求体按 `{}` 处理

启动和调用相关环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEXTTOKEN_API_KEY` | 无 | 必填。Codex SDK 调用模型所需凭证 |
| `NEXTTOKEN_API_BASE_URL` | `https://next-token.cc` | Nexttoken OpenAI-compatible API 地址。程序会自动补 `/v1` |
| `OPENROUTER_API_KEY` | 无 | 必填。切换到 OpenRouter 时使用的模型凭证 |
| `OPENROUTER_API_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter OpenAI-compatible API 地址 |
| `CODEX_MODEL_PROVIDER` | `nexttoken` | CLI 和省略 `provider` 时使用的默认 provider |
| `CODEX_MODEL` | `gpt-5.6-terra` | 默认 provider 使用的模型 ID |
| `OA_OPENAPI_URL` | `https://api-oa.rwkvos.com/openapi_json` | 优先读取的 OA OpenAPI 地址。请求失败、非 2xx 或内容非法时回退本地契约 |
| `OA_API_BASE_URL` | 空 | OA 后端地址。HTTP 服务用它验证用户 OA token,受控工具也通过该地址调用 OA |
| `OA_AUTH_ALIAS` | `default` | OA 登录和 token 验证使用的数据源 alias |
| `OA_API_TOKEN_HEADER` | `Cookie` | 受控 OA 工具调用时的 token header 名称 |
| `OA_API_TOKEN_PREFIX` | `sessionid=` | 受控 OA 工具调用时的 token header 值前缀。设为空时直接发送 token |
| `OA_USER_TOKEN_HEADER` | `Authorization` | 前端请求 agent 接口时,服务端从该 header 读取用户 OA token |
| `OA_USER_TOKEN_PREFIX` | `Bearer` | 前端请求用户 OA token 的 header 值前缀。设为空时读取完整 header 值 |
| `AGENT_OA_TOOL_TOKEN` | 随机生成 | 内部 `callOaApi` 工具 bearer token。通常不需要配置 |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |
| `AGENT_SESSION_STORE` | `.context/agent-sessions.json` | `sessionId -> Codex threadId` 和摘要的持久化文件 |

## 鉴权

`GET /health` 不需要鉴权。

`POST /__internal/call-oa-api` 使用内部鉴权,只接受本机 loopback 请求,并要求:

```http
Authorization: Bearer <AGENT_OA_TOOL_TOKEN>
```

该内部端点使用独立的短期内部 token,也不是对外 API。

其余 `/v1/*` 接口统一使用用户 OA token。请求必须携带以下任一种形式:

```http
Authorization: Bearer <OA_USER_TOKEN>
Cookie: sessionid=<OA_USER_TOKEN>
X-OA-Api-Token: Bearer <OA_USER_TOKEN>
```

Agent 会用该 token 调用 OA 的 `GET /user/user`;该 OA 路由实际依赖 `simple_authenticated_user`,因此会校验签名、有效期和登录用户。公开且无需登录的 `GET /auth/ping` 不用于 token 验证。

token 缺失或 OA 返回 `4xx` 时,Agent 返回:

```json
{
  "error": "unauthorized"
}
```

状态码为 `401`。OA 未配置、超时、不可达或返回服务端错误时返回 `503`,不会降级放行。

## 前端用户 OA Token

前端用户登录 OA 后,Web 把 httpOnly `sessionid` cookie 中的同一枚 OA token 转为 `Authorization: Bearer <OA_USER_TOKEN>` 调用 agent。服务端会从 `OA_USER_TOKEN_HEADER` 指定的 header 读取 token,默认支持:

```http
Authorization: Bearer <OA_USER_TOKEN>
```

也会自动兼容浏览器或客户端携带的 OA cookie:

```http
Cookie: sessionid=<OA_USER_TOKEN>
```

如果请求中有多个 cookie,也可以是:

```http
Cookie: foo=1; sessionid=<OA_USER_TOKEN>; bar=2
```

验证通过后,用户 OA token 会绑定到当前 `sessionId` 的进程内状态,后续该 session 的受控 OA 工具调用使用这个用户 token。服务不会把用户 OA token 写入 prompt、命令行、响应或 session 持久化文件;持久化文件只保存经过 SHA-256 处理的用户归属标识,用于隔离不同用户的 session。

如果前端已经通过 Cookie 传入 OA 登录态,通常不需要配置 `OA_USER_TOKEN_HEADER=Cookie`;服务端会默认尝试读取 `sessionid` cookie。

请求没有有效用户 OA token 时不会进入 agent 或内部工具调用。

## 数据模型

### AgentSession

```json
{
  "sessionId": "demo",
  "threadId": "thread_...",
  "summary": "用户: ...\n助手: ...",
  "createdAt": "2026-07-07T12:00:00.000Z",
  "updatedAt": "2026-07-07T12:05:00.000Z"
}
```

字段说明:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | `string` | 本服务侧会话 ID |
| `threadId` | `string \| null` | Codex SDK 返回的 thread ID。新建且未发消息时为 `null` |
| `summary` | `string \| null` | 服务端维护的紧凑对话摘要。新建且未发消息时为 `null` |
| `createdAt` | `string` | ISO 8601 创建时间 |
| `updatedAt` | `string` | ISO 8601 更新时间 |

`sessionId` 必须满足:

```text
^[A-Za-z0-9_.:-]{1,120}$
```

即只能包含字母、数字、下划线、点、冒号和连字符,长度 1-120。

### SendMessageResult

```json
{
  "sessionId": "demo",
  "threadId": "thread_...",
  "provider": "nexttoken",
  "model": "gpt-5.6-terra",
  "finalResponse": "可以使用 ...",
  "executedCommands": [
    "python3 ..."
  ],
  "summary": "用户: ...\n助手: ..."
}
```

字段说明:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | `string` | 本次消息所属 session |
| `threadId` | `string` | 本次运行后关联的 Codex thread ID |
| `provider` | `string` | 本轮实际使用的模型提供商 |
| `model` | `string` | 本轮实际使用的模型 ID |
| `finalResponse` | `string` | agent 的最终中文回答。已对已知密钥做脱敏 |
| `executedCommands` | `string[]` | agent 运行过程中执行过的命令记录。已对已知密钥做脱敏 |
| `summary` | `string` | 写回 session 的紧凑摘要,用于后续续聊 |

### AgentStreamEvent

流式消息接口使用 Server-Sent Events(SSE)。每条事件都包含:

```text
event: <事件类型>
data: <JSON>
```

连接建立后服务会先发送注释行 `: connected`。连接保持期间每 15 秒发送一次 `: keep-alive` 注释行;这些注释行没有 `event` 或 `data`,客户端解析时应忽略。

主要事件类型:

| 事件 | 主要字段 | 说明 |
| --- | --- | --- |
| `run.queued` | `sessionId` | 请求已进入该 session 的串行队列 |
| `run.started` | `sessionId` | 本轮开始执行 |
| `thread.started` | `sessionId`,`threadId` | Codex 创建或恢复 thread |
| `turn.started` | `sessionId` | Codex turn 开始 |
| `progress` | `sessionId`,`message`,`detail?` | agent 进度说明,例如 todo、文件变更或错误 item |
| `message.delta` | `sessionId`,`itemId`,`delta`,`text` | agent 最终回答的增量文本。`delta` 是本次新增片段,`text` 是该消息当前累积全文 |
| `tool.started` | `sessionId`,`itemId`,`toolType`,`name`,`input?`,`status?` | 工具调用开始。当前可见类型包括 `command_execution`、`mcp_tool_call`、`web_search` |
| `tool.updated` | `sessionId`,`itemId`,`toolType`,`status`,`outputDelta?` | 工具调用中间状态更新。当前只会用于 `command_execution` 和 `mcp_tool_call` |
| `tool.completed` | `sessionId`,`itemId`,`toolType`,`name`,`status?`,`exitCode?`,`outputDelta?`,`result?`,`error?` | 工具调用结束 |
| `run.completed` | `sessionId`,`result`,`usage` | 本轮成功完成。`result` 字段等同非流式 `SendMessageResult`,`usage` 为 Codex 返回的 token 用量或 `null` |
| `run.failed` | `sessionId`,`error` | 本轮失败。若响应已建立,失败会以 SSE 事件返回;若失败发生在建立响应前,会返回普通 JSON 错误 |

说明:

- `message.delta`、`tool.*` 和 `progress` 已对已知密钥值做脱敏。
- `message.delta.text` 是累积文本,前端渲染打字机效果时通常只追加 `delta`。
- `run.completed.result` 是最终权威结果,建议用它落库或更新会话摘要。
- 客户端主动断开连接时,服务端会取消本轮流式请求;此时不保证还能收到 `run.failed`。

### OaApiToolResult

内部受控 OA API 工具返回统一结构。成功或收到 OA 后端 HTTP 响应时:

```json
{
  "ok": true,
  "status": 200,
  "operationId": "weekly_report_days_by_month_weekly_report_days_by_month_get",
  "method": "GET",
  "path": "/weekly-report/days-by-month",
  "data": {}
}
```

工具侧校验失败或 OA 凭证未配置时:

```json
{
  "ok": false,
  "error": {
    "code": "missing_required_parameters",
    "message": "缺少必填参数。",
    "details": {
      "missing": ["query.month"]
    }
  }
}
```

字段说明:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | `boolean` | 工具调用是否成功。OA 后端返回非 2xx 时为 `false` |
| `status` | `number` | OA 后端 HTTP 状态码。未发出 OA 请求时不存在 |
| `operationId` | `string` | 匹配到的 OpenAPI operationId。未匹配到 operation 时不存在 |
| `method` | `string` | HTTP method,大写 |
| `path` | `string` | OpenAPI path 模板,不是渲染后的实际 URL |
| `data` | `unknown` | OA 后端响应体。JSON 会解析成对象;空响应为 `null`;非 JSON 响应为字符串 |
| `error.code` | `string` | 工具错误码 |
| `error.message` | `string` | 工具错误说明 |
| `error.details` | `unknown` | 可选错误详情 |

## 接口列表

### 健康检查

```http
GET /health
```

用途:检查后台服务进程是否存活。

鉴权:不需要。

响应示例:

```json
{
  "status": "ok"
}
```

状态码:

| 状态码 | 说明 |
| --- | --- |
| `200` | 服务可用 |

### 可选模型

```http
GET /v1/models
```

用途:返回默认 provider 的模型列表和全部 provider 白名单。鉴权规则与其他 `/v1/*` 接口相同。

```json
{
  "provider": "nexttoken",
  "models": [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra"
  ],
  "providers": {
    "nexttoken": [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ],
    "openrouter": [
      "z-ai/glm-5.2",
      "moonshotai/kimi-k3",
      "openai/gpt-5.5",
      "openai/gpt-5.4"
    ]
  }
}
```

### 创建或获取 Session

```http
POST /v1/sessions
```

用途:创建一个服务侧 session,或按指定 `sessionId` 获取已有 session。不传 `sessionId` 时服务自动生成 UUID。

鉴权:必须携带并通过 OA 验证的用户 token。

请求体:

```json
{
  "sessionId": "demo"
}
```

字段说明:

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 | 自定义 session ID。不传或传空字符串时自动生成 |

响应示例:

```json
{
  "sessionId": "demo",
  "threadId": null,
  "summary": null,
  "createdAt": "2026-07-07T12:00:00.000Z",
  "updatedAt": "2026-07-07T12:00:00.000Z"
}
```

状态码:

| 状态码 | 说明 |
| --- | --- |
| `201` | 创建成功,或指定 `sessionId` 已存在并返回现有 session |
| `401` | 鉴权失败 |
| `500` | 非法 JSON、非法 `sessionId`、请求体过大或其他服务端错误 |

调用示例:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -H "Cookie: sessionid=$OA_USER_TOKEN" \
  -d '{"sessionId":"demo"}'
```

### 查询 Session 列表

```http
GET /v1/sessions
```

用途:查询当前 OA 用户拥有的 session,按 `createdAt` 倒序返回,即最新创建的会话排在最前。

鉴权:必须携带并通过 OA 验证的用户 token。

响应示例:

```json
{
  "sessions": [
    {
      "sessionId": "demo",
      "threadId": "thread_...",
      "summary": "用户: ...\n助手: ...",
      "createdAt": "2026-07-07T12:00:00.000Z",
      "updatedAt": "2026-07-07T12:05:00.000Z"
    }
  ]
}
```

状态码:

| 状态码 | 说明 |
| --- | --- |
| `200` | 查询成功 |
| `401` | 鉴权失败 |
| `500` | 读取 session 存储文件失败或其他服务端错误 |

调用示例:

```bash
curl -s http://127.0.0.1:3000/v1/sessions \
  -H "Authorization: Bearer $OA_USER_TOKEN"
```

### 删除 Session

```http
DELETE /v1/sessions/{sessionId}
```

用途:删除当前 OA 用户拥有的指定 session 的持久化元数据和进程内 OA token 绑定。接口具有幂等性;session 不存在或不属于当前用户时仍返回 `200`,但 `deleted` 为 `false`。

鉴权:必须携带并通过 OA 验证的用户 token。

响应示例:

```json
{
  "deleted": true,
  "sessionId": "demo"
}
```

状态码:

| 状态码 | 说明 |
| --- | --- |
| `200` | 删除请求已处理 |
| `401` | 鉴权失败 |
| `500` | 非法 `sessionId`、写入 session 存储文件失败或其他服务端错误 |

调用示例:

```bash
curl -s -X DELETE http://127.0.0.1:3000/v1/sessions/demo \
  -H "Authorization: Bearer $OA_USER_TOKEN"
```

### 发送消息

```http
POST /v1/sessions/{sessionId}/messages
```

用途:向指定 session 发送用户消息。服务会调用 Codex agent,由 agent 基于远程优先、本地兜底选中的 OpenAPI 契约回答 OA 接口问题;首次进入 Codex agent 时会创建或初始化 Codex thread,后续请求会复用同一个 `threadId` 并带上服务端摘要继续对话。

服务端不包含按关键词硬编码的 OA 直连分支。配置 `OA_API_BASE_URL` 后,agent 可以通过受控 `callOaApi` 工具调用所选 OpenAPI 契约中声明的 OA 接口;OA 登录态来自当前请求验证并绑定到 session 的用户 token。

鉴权:必须携带并通过 OA 验证的用户 token。

路径参数:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 | 需要 URL 编码。解码后必须满足 session ID 规则 |

请求体:

```json
{
  "message": "我想查一下周报列表,应该调用哪个接口?",
  "provider": "nexttoken",
  "model": "gpt-5.6-terra"
}
```

字段说明:

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 用户输入。去掉首尾空白后不能为空 |
| `provider` | `string` | 否 | 本轮 provider,可选 `nexttoken` 或 `openrouter`;省略时使用 `CODEX_MODEL_PROVIDER` |
| `model` | `string` | 否 | 本轮模型。省略时使用该 provider 的默认模型;传入时必须属于对应 provider 白名单 |

响应示例:

```json
{
  "sessionId": "demo",
  "threadId": "thread_...",
  "provider": "nexttoken",
  "model": "gpt-5.6-terra",
  "finalResponse": "建议使用 `weekly_report_list_weekly_report_report_list_get` ...",
  "executedCommands": [
    "python3 ..."
  ],
  "summary": "用户: 我想查一下周报列表,应该调用哪个接口?\n助手: 建议使用 ..."
}
```

状态码:

| 状态码 | 说明 |
| --- | --- |
| `200` | agent 运行成功 |
| `400` | `message` 缺失/为空,或 `provider`/`model` 类型错误、组合不在白名单 |
| `401` | 鉴权失败 |
| `500` | 非法 JSON、非法 `sessionId`、请求体过大、agent 未返回最终回答、模型调用失败或其他服务端错误 |

调用示例:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sessions/demo/messages \
  -H 'content-type: application/json' \
  -H "Cookie: sessionid=$OA_USER_TOKEN" \
  -d '{"message":"我想查一下周报列表,应该调用哪个接口?","provider":"nexttoken","model":"gpt-5.6-terra"}'
```

### 流式发送消息

```http
POST /v1/sessions/{sessionId}/messages/stream
```

用途:向指定 session 发送用户消息,并在执行过程中通过 SSE 实时返回进展、部分输出和工具调用。会话复用、鉴权、路径参数、请求体和错误规则与非流式“发送消息”接口一致。

响应事件示例:

```text
: connected

event: run.queued
data: {"type":"run.queued","sessionId":"demo"}

event: tool.started
data: {"type":"tool.started","sessionId":"demo","itemId":"...","toolType":"command_execution","name":"python3 ...","status":"in_progress"}

event: message.delta
data: {"type":"message.delta","sessionId":"demo","itemId":"...","delta":"建议使用","text":"建议使用"}

event: run.completed
data: {"type":"run.completed","sessionId":"demo","result":{"sessionId":"demo","threadId":"thread_...","provider":"nexttoken","model":"gpt-5.6-terra","finalResponse":"建议使用 ...","executedCommands":["python3 ..."],"summary":"用户: ..."},"usage":{"input_tokens":123,"cached_input_tokens":0,"output_tokens":45,"reasoning_output_tokens":0}}

: keep-alive
```

调用示例:

```bash
curl -N -X POST http://127.0.0.1:3000/v1/sessions/demo/messages/stream \
  -H 'content-type: application/json' \
  -H "Cookie: sessionid=$OA_USER_TOKEN" \
  -d '{"message":"我想查一下周报列表,应该调用哪个接口?","provider":"nexttoken","model":"gpt-5.6-terra"}'
```

浏览器示例:

```js
const response = await fetch("/v1/sessions/demo/messages/stream", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message: "我想查一下周报列表,应该调用哪个接口?",
    provider: "nexttoken",
    model: "gpt-5.6-terra",
  }),
});

const reader = response.body
  .pipeThrough(new TextDecoderStream())
  .getReader();

let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  const chunks = buffer.split("\n\n");
  buffer = chunks.pop() || "";
  for (const chunk of chunks) {
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice(6));
    if (event.type === "message.delta") {
      process.stdout.write(event.delta);
    }
    if (event.type === "tool.started") {
      console.error("tool:", event.toolType, event.name);
    }
  }
}
```

### 受控 OA API 调用工具

当 `OA_API_BASE_URL` 已配置,且当前 session 已绑定已验证的用户 OA token 时,Codex agent 可以通过仓库内的 CLI 调用受控工具:

```bash
node agent/scripts/callOaApi.mjs \
  --sessionId demo \
  --operationId weekly_report_days_by_month_weekly_report_days_by_month_get \
  --query '{"month":"2026-07","alias":"default"}'
```

CLI 参数:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--sessionId` | `string` | 否 | 当前 agent session ID。传入后内部工具优先使用绑定到该 session 的用户 OA token。由 agent 自动调用时,服务会通过 `CALL_OA_API_SESSION_ID` 注入当前 session,通常不需要手写 |
| `--operationId` | `string` | 条件必填 | OpenAPI operationId。提供后可选传 `--method`、`--path` 做一致性校验 |
| `--method` | `string` | 条件必填 | HTTP method。未传 `--operationId` 时必须和 `--path` 同时提供 |
| `--path` | `string` | 条件必填 | OpenAPI path 模板。未传 `--operationId` 时必须和 `--method` 同时提供 |
| `--pathParams` | JSON object | 否 | 路径参数,用于渲染 `{param}` |
| `--query` | JSON object | 否 | query 参数。值会转成字符串加入 URL |
| `--body` | JSON value | 否 | JSON request body |
| `--confirmed` | boolean | 否 | 敏感操作确认标记。`true`、`1`、`yes` 会被视为确认 |

工具行为:

- 只允许调用远程优先、本地兜底选中的 OpenAPI 契约中存在的 operation。
- 可通过 `operationId` 定位接口,也可通过 `method` + `path` 定位接口。
- 如果同时传入 `operationId` 与 `method` 或 `path`,服务端会校验它们必须匹配。
- agent 自动调用 CLI 时,会在 `agent` 工作目录下运行 `scripts/callOaApi.mjs`,并从 `CALL_OA_API_SESSION_ID` 自动带上当前 session;手动调试 CLI 时可显式传 `--sessionId`。
- 服务端校验 OpenAPI 中声明为必填的 query/path/body 参数。
- 必填 header/cookie 参数不允许由 agent 自行传入;遇到这类接口会返回 `unsupported_required_parameters`。
- 服务端注入当前 `sessionId` 绑定的用户 OA token;token 不进入 prompt,也不需要 agent 构造鉴权 header。
- `OA_API_TOKEN_HEADER` 和 `OA_API_TOKEN_PREFIX` 控制发送给 OA 后端的鉴权 header。`OA_API_TOKEN_PREFIX` 为空时直接发送 token;前缀以 `=` 结尾时不插入空格,否则按 `<prefix> <token>` 拼接。
- 查询/读取/列表/搜索/统计/报表/下载/导出类接口不需要用户确认。
- 修改数据、删除数据、创建数据、上传文件、提交审批、修改密码或变更权限等操作需要 agent 先取得用户确认,再传 `--confirmed true`。
- 工具执行过程会作为 Codex 的 `command_execution` 事件出现在流式响应中。
- 配置 `OA_API_BASE_URL` 时,Codex thread 会使用 `workspace-write` 沙箱并开启 `network_access`,用于让 `agent` 工作目录下的 `scripts/callOaApi.mjs` 访问本机内部工具端点。

内部端点 `POST /__internal/call-oa-api` 只接受本机请求和内部 bearer token,不是对外 API。请求体与 CLI 参数一一对应:

```json
{
  "sessionId": "demo",
  "operationId": "weekly_report_days_by_month_weekly_report_days_by_month_get",
  "method": "GET",
  "path": "/weekly-report/days-by-month",
  "pathParams": {},
  "query": {
    "month": "2026-07",
    "alias": "default"
  },
  "body": null,
  "confirmed": false
}
```

内部端点状态码:

| 状态码 | 说明 |
| --- | --- |
| `200` | 内部工具请求被服务接收。具体 OA 调用是否成功见响应体 `ok` |
| `401` | 内部 bearer token 不正确 |
| `403` | 请求不是来自 loopback 地址 |
| `500` | 请求体不是合法 JSON object、请求体过大、远程与本地 OpenAPI 都无法读取或其他服务端异常 |

常见工具错误码:

| code | 说明 |
| --- | --- |
| `oa_not_configured` | 缺少 `OA_API_BASE_URL` 或当前 session 没有已验证的用户 OA token |
| `invalid_session_id` | 内部工具请求携带的 `sessionId` 格式非法 |
| `missing_operation` | 未提供 `operationId`,也未同时提供 `method` 和 `path` |
| `operation_not_found` | 当前选中的 OpenAPI 契约中不存在指定 operation |
| `operation_mismatch` | `operationId` 与传入的 `method` 或 `path` 不匹配 |
| `missing_required_parameters` | 缺少 OpenAPI 声明的必填 query/path 参数 |
| `unsupported_required_parameters` | 接口存在必填 header/cookie 参数,受控工具不支持 agent 传入 |
| `missing_required_body` | 接口声明了必填 request body,但未传 `body` |
| `confirmation_required` | 该接口可能产生敏感影响,需要用户确认后传 `confirmed=true` |

## 会话与上下文行为

- 本服务把 `sessionId -> threadId` 和 `summary` 保存到 `AGENT_SESSION_STORE` 指定的 JSON 文件。
- `threadId` 是 Codex SDK 返回的 thread 标识,用于后续消息继续同一个 agent thread。
- `summary` 是本服务本地生成的紧凑摘要,最多约 3000 字符,每轮会追加当前用户输入和 agent 最终回答的压缩版本。
- 同一个 `sessionId` 的并发消息会排队串行执行,避免多个请求同时改写同一个 session。
- 第一次消息使用完整任务提示词;后续消息会附带 `<conversation_memory>` 摘要和新的 `<user_task>`。
- 服务只会对已知密钥值做脱敏,不会把 `NEXTTOKEN_API_KEY`、`OPENROUTER_API_KEY` 或用户 OA token 写入响应。

## 通用错误格式

服务端错误统一返回:

```json
{
  "error": "错误说明"
}
```

未命中路由返回:

```json
{
  "error": "not found"
}
```

状态码为 `404`。

当前实现中,除明确处理的 `401`、`403`、`400` 和 `404` 外,其余异常都会返回 `500`。常见 `500` 来源包括:

- 请求体不是合法 JSON object,例如数组、字符串或非法 JSON。
- 请求体超过 128 KiB。
- `sessionId` 不符合格式规则。
- session 存储文件读取或写入失败。
- agent 未返回最终回答、模型调用失败或 Codex SDK 运行失败。
- 内部 OA 工具读取远程与本地 OpenAPI 都失败,或请求 OA 后端失败。
