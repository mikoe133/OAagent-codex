# 服务端接口文档

本文档描述本项目自带的后台服务接口,也就是 `npm run dev:server` 启动的 TypeScript HTTP 服务。它不是 OA 业务后端接口契约;agent 优先读取 `OA_OPENAPI_URL`,远程不可用或内容非法时回退到 `agent/openapi/openapi.json`,并把选中的契约作为回答 OA 接口问题的事实来源。

## 基本信息

生产公网入口为 `https://oa-agent.rwkvos.com/v1`，由 Nginx 将公开对话路径直接转发到 Agent，沿用 OA Token 鉴权。完整配置、端口绑定与部署验证见 [生产对话接口路由](public-chat-routing.md)。此地址需在生产应用该配置后可用。

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
| `CODEX_SANDBOX_MODE` | 自动 | Codex 命令沙箱。未配置时,无 OA 工具使用 `read-only`,启用 OA 工具使用 `workspace-write`;`danger-full-access` 仅用于已有独立外部沙箱的进程 |
| `OA_OPENAPI_URL` | `https://api-oa.rwkvos.com/openapi_json` | 优先读取的 OA OpenAPI 地址。请求失败、非 2xx 或内容非法时回退本地契约 |
| `OA_API_BASE_URL` | 空 | OA 后端地址。HTTP 服务用它验证用户 OA token,受控工具也通过该地址调用 OA |
| `OA_KNOWLEDGE_API_BASE_URL` | `https://oa-kb.rwkvos.com/api/agent/v1` | 知识库 Agent API 地址 |
| `OA_KNOWLEDGE_BASE_API_KEY` | 空 | 仅用于服务端组装知识库 `Authorization: Bearer` header 的固定 Token；只保存在 agent 服务端 |
| `OA_AUTH_ALIAS` | `default` | OA 登录和 token 验证使用的数据源 alias |
| `OA_API_TOKEN_HEADER` | `Cookie` | 受控 OA 工具调用时的 token header 名称 |
| `OA_API_TOKEN_PREFIX` | `sessionid=` | 受控 OA 工具调用时的 token header 值前缀。设为空时直接发送 token |
| `OA_USER_TOKEN_HEADER` | `Authorization` | 前端请求 agent 接口时,服务端从该 header 读取用户 OA token |
| `OA_USER_TOKEN_PREFIX` | `Bearer` | 前端请求用户 OA token 的 header 值前缀。设为空时读取完整 header 值 |
| `AGENT_OA_TOOL_TOKEN` | 随机生成 | 内部 `callOaApi` 工具 bearer token。通常不需要配置 |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |
| `AGENT_SESSION_STORE` | `.context/agent-sessions.json` | `sessionId -> Codex threadId` 和摘要的持久化文件 |

知识库统一读写 OpenAPI 是 Agent 的唯一知识库接口事实来源。依据该契约发起上游请求时,服务端固定把 `OA_KNOWLEDGE_BASE_API_KEY` 组装为 `Authorization: Bearer <token>`,把当前页面登录账户经 OA 校验后的 userid 组装为 `X-OA-User-Id`,并为写请求生成 `Idempotency-Key`;Agent 参数不能填写或覆盖任何 Header。开发接入说明 `agent/knowledgebaseapi/AGENT_API.md` 不进入 Agent 运行时上下文。浏览器到 Agent、Codex 到内部工具以及普通 OA API 的现有鉴权方式均不受影响。

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
  "knowledgeSources": [
    {
      "title": "生产部署手册",
      "description": "发布前请确认数据库迁移、镜像版本和部署窗口。",
      "sourceUrl": "https://oa-kb.rwkvos.com/wiki/PAGE_ID"
    }
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
| `knowledgeSources` | `{title,description,sourceUrl}[]` | 本轮知识库调用返回的去重来源。正文优先作为截断后的 `description`;没有正文时使用搜索摘要 |
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
- `run.completed.result` 是最终权威结果,建议用它落库或更新会话摘要。知识库引用应从其中的 `knowledgeSources` 渲染,不要从最终 Markdown 反向解析。
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
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "openai/gpt-5.4"
    ]
  }
}
```

### OA 会话与消息接口

对外会话唯一编号是 OA Copilot 创建记录返回的 `recordId`（十进制正整数字符串）。调用方不生成 sessionId，也不传 threadId。路径中的 `{recordId}` 即 OA `/copilot/record?record_id=...` 的编号。内部 `agentSessionId` 和模型 threadId 不出现在公开会话及最终结果中。

同一会话的每条消息必须有一个 `Idempotency-Key`，推荐 UUID。兼容请求体 `requestId`；两者是同一编号的两种传法，同时提供时必须一致。不新增 runId。编号范围是 1～120 位字母、数字、下划线、点、冒号、连字符。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/v1/sessions` | 在 OA 创建会话；请求 `{ "title": "周报助手" }`，title 可省略，返回 201 和 Location |
| GET | `/v1/sessions?page=1&size=20` | OA 当前用户会话列表，size 最大 100 |
| GET | `/v1/sessions/{recordId}` | OA 会话与已保存历史 |
| PATCH | `/v1/sessions/{recordId}` | 只更新 title 或 feedback；不接受 messages 整体覆盖 |
| DELETE | `/v1/sessions/{recordId}` | 删除 OA 记录，有活动/排队任务时返回 409 |
| GET | `/v1/sessions/{recordId}/messages?limit=20&cursor=0` | 分页历史，limit 最大 100；返回 messages 和 nextCursor（null 表示结束） |
| POST | `/v1/sessions/{recordId}/messages` | 提交消息，等待执行结果；必须携带请求编号 |
| POST | `/v1/sessions/{recordId}/messages/stream` | 提交消息并通过 SSE 接收进度，必须携带请求编号 |
| GET | `/v1/sessions/{recordId}/requests/{requestId}` | 查询原请求状态、结果及历史同步情况 |
| POST | `/v1/sessions/{recordId}/requests/{requestId}/cancel` | 显式请求停止排队/执行；返回 202，不回滚已发生的 OA 操作 |
| POST | `/v1/sessions/{recordId}/requests/{requestId}/sync` | 将已结束请求的结果和 Trace 补存到 OA 历史（成功、失败、取消）；不调用模型，可重复调用 |

每一个读写接口，包括幂等重放、查询和取消，都重新验证 OA Token，并向 OA 读取对应记录，校验记录 user_id 与当前验证的用户 ID 一致。OA 不可用时不返回缓存结果绕过授权。内部幂等索引包含 OA 地址、alias、当前用户、recordId 和 requestId。

对话 Trace 实时写入本地 JSONL，并随 assistant 消息保存到 OA 的 `traceEvents` 字段。请求查询返回已保存事件，历史页面可恢复展示；文件位置、失败补存和保留行为见 [AI 对话 Trace 持久化](chat-trace-storage.md)。

创建示例：

```bash
curl -sS https://oa-agent.rwkvos.com/v1/sessions \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"title":"周报助手"}'
```

```json
{
  "recordId": "123",
  "schema": "oa-agent-chat/v1",
  "title": "周报助手",
  "summary": null,
  "messages": [],
  "createdAt": 1780000000,
  "updatedAt": 1780000000
}
```

时间字段沿用 OA record.createdAt / created_at / updated_at，可能是 Unix 秒或 ISO 字符串；Web 适配层会归一化。创建会话本身不做消息幂等，网络结果未知时不要自动重复创建。

### 普通与流式发送消息

请求 JSON：

```json
{
  "message": "查询我本周的周报",
  "provider": "nexttoken",
  "model": "gpt-5.6-terra"
}
```

message 去掉首尾空白后必须非空。provider/model 可省略，按服务端默认值解析并验证白名单；可选 developerMode（boolean）及 routerModel（路由模型白名单）。建议外部集成显式指定 provider/model，避免默认模型升级影响重试的参数摘要。

```bash
curl -N "https://oa-agent.rwkvos.com/v1/sessions/$RECORD_ID/messages/stream" \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H "Idempotency-Key: $REQUEST_ID" \
  -H 'Content-Type: application/json' \
  --data '{"message":"查询我本周的周报","provider":"nexttoken","model":"gpt-5.6-terra"}'
```

响应头包含原 Idempotency-Key、Idempotency-Replayed（true/false）和指向查询接口的 Location。SSE 事件含 recordId 和 requestId，不含对外 sessionId/runId；进度事件保留 itemId 用于组合流式消息/工具步骤。

```text
event: run.queued
data: {"type":"run.queued","recordId":"123","requestId":"req-1"}

event: message.delta
data: {"type":"message.delta","recordId":"123","requestId":"req-1","itemId":"m","delta":"查询结果","text":"查询结果"}

event: run.completed
data: {"type":"run.completed","recordId":"123","requestId":"req-1","historySync":"synced","result":{"recordId":"123","requestId":"req-1","finalResponse":"查询结果……","provider":"nexttoken","model":"gpt-5.6-terra","knowledgeSources":[]}}
```

其他执行进度包括 run.started、turn.started、progress、tool.started、tool.updated、tool.completed；底层 thread.started 不转发。SSE 开始后失败返回 run.failed，HTTP 200 不代表任务成功。

普通消息响应与查询响应采用同一个运行记录格式：

```json
{
  "recordId": "123",
  "requestId": "req-1",
  "message": "查询我本周的周报",
  "state": "completed",
  "createdAt": "2026-09-14T08:00:00.000Z",
  "updatedAt": "2026-09-14T08:00:08.000Z",
  "historySync": "synced",
  "result": {
    "recordId": "123",
    "requestId": "req-1",
    "finalResponse": "查询结果……",
    "provider": "nexttoken",
    "model": "gpt-5.6-terra",
    "knowledgeSources": []
  }
}
```

### 幂等、查询与断线恢复

首次发送前保存 requestId；断线后用 GET 查询，或使用相同编号和相同参数重新 POST。普通/SSE 共用一条请求记录，不重复排队或调用模型。相同会话、相同编号、不同消息或模型参数返回 409 idempotency_conflict。不同会话可以独立使用相同请求编号。

| state | 含义 |
| --- | --- |
| queued | 已受理，等待执行名额 |
| running | Agent 正在执行 |
| completed | 结果已持久化，可查询/重放 |
| failed | 执行失败或超时，errorCode 说明原因；不能自动换编号重新执行 |
| cancelled | 显式取消已处理；不表示 OA 操作被撤销 |
| unknown | 持久记录未完成，但当前进程没有该运行；通常是重启/崩溃后结果待核对 |

已受理任务不因 HTTP/SSE 连接关闭而取消。使用 cancel 接口明确停止。客户端慢读导致输出缓冲超过 1 MiB 时断开该连接，后台继续，调用方可查询结果。重复请求执行中返回 409 idempotency_pending 和 Retry-After: 3；已完成 SSE 重放只提供最终事件，不提供历史 delta、usage 或断点续传。

historySync=pending 且 state=completed 表示模型已完成，但 OA 历史尚未确认保存。使用 sync 接口补存，不重新运行模型。历史写入采用当前 OA 文档的 PATCH 整体覆盖协议，在同一会话执行槽内读取最新记录并追加，消息标识由 requestId + role 派生，重复补存不会重复添加。禁止浏览器整体覆盖 messages。失败/取消的执行详情保留在请求查询记录，成功消息对同步到 OA。

### 限流、并发与失败处理

请求在鉴权、参数检查和幂等查询后才进入容量检查。重放和结果查询不算新对话，不占模型名额。容量不足拒绝时删除未受理占位，调用方可按 Retry-After 使用原编号重试。首次有效请求已受理后，即使失败或重启也保留编号，绝不自动重新执行。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| CHAT_MAX_CONCURRENCY | 2 | Agent 同时执行的对话数 |
| CHAT_USER_CONCURRENCY | 1 | 单个 OA 用户同时执行数 |
| CHAT_MAX_QUEUE | 20 | 全局等待数 |
| CHAT_USER_QUEUE | 5 | 单用户等待数 |
| CHAT_USER_REQUESTS_PER_MINUTE | 20 | 单用户每分钟受理的新请求数 |
| CHAT_QUEUE_TIMEOUT_MS | 120000 | 最长排队时间 |
| CHAT_EXECUTION_TIMEOUT_MS | 600000 | 发出执行取消信号的时限 |

同一会话串行；不同用户轮流获得可用名额。超时只是取消信号，名额在实际任务退出后才释放，避免旧执行未停止又继续超额接入。用户限额返回 429；全局队列满返回 503；两者有 Retry-After。排队超时 errorCode=queue_timeout，尚未运行模型；执行超时为 execution_timeout，可能已发生业务操作。接口错误采用 `{ "code": "...", "error": "..." }`。非法 JSON/参数为 400，请求体超 128 KiB 为 413；OA 故障/本地持久化故障不会降级执行。

### 持久化与迁移边界

聊天历史的主要存储仍是 OA Copilot。Agent 仅保存内部模型上下文映射和请求运行记录，后者位于 `${AGENT_SESSION_STORE}.public-requests`，与 Compose 的 /app/.context 持久卷一起备份。记录包含用户输入和结果等业务数据，不包含鉴权头；目录 0700、文件 0600。占位独占创建，结果使用同步落盘和原子替换。没有自动过期，不要在调用方仍可能重试时清理。

本版依赖单 Agent 进程及持久磁盘；不支持把多个进程各自接到公网分流来共享会话调度。重启后未确认请求返回 unknown，需人工核对，不恢复执行。OA PATCH 没有版本条件，本版通过唯一 Agent 写入者和会话串行避免本项目内竞争；其他系统直接覆盖同一 Copilot record 时仍需 OA 增加版本/CAS 支持。

这是公网会话契约变更，Web 和 Agent 必须配套部署。已有 OA recordId 不变；Agent 在确认本地旧会话属于当前用户后，复用 record.agentSessionId 对应的上下文。旧浏览器本地自定义会话编号需要从会话列表重新打开，列表提供同一个 OA ID；本地没有 OA 记录的草稿不自动冒充 OA 会话。旧 `${AGENT_SESSION_STORE}.requests` 幂等文件保留在磁盘，但属于旧 sessionId 协议，不会自动映射为新请求：切换前应排空旧任务，核对结果，不能用新接口重发结果未知的旧请求。


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
| `--responseId` | `string` | 条件必填 | 大响应首次检查返回的临时句柄；与 `--action` 一起使用，不会再次请求 OA |
| `--action` | `string` | 条件必填 | 本地响应动作：`inspect`、`find`、`filter`、`count`、`group_count` 或 `read` |
| `--responsePath` | `string` | 否 | 要处理的 JSON 路径，例如 `$.data`，默认 `$` |
| `--conditions` | JSON object | 否 | `find`、`filter`、`count` 的条件；简单值表示精确匹配，也支持 `operator`/`value` |
| `--fields` | JSON string[] | 否 | 返回结果保留的字段，最多 20 个 |
| `--groupBy` | `string` | 条件必填 | `group_count` 使用的分组字段 |
| `--offset` | integer | 否 | `read` 的起始位置，默认 0 |
| `--limit` | integer | 否 | `find`、`filter`、`read` 的返回上限，最大 100 |

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
- 大数组、超长字段或明确未完成分页的响应不会先裁剪再交给模型。工具在当前 turn 内保存完整响应，并返回 `responseId`、`coverage` 和 `data.mode=inspect` 的结构摘要。
- 结构摘要只展示数组长度、字段并集和一项样例。模型应通过同一 `responseId` 在完整缓存上执行本地查找、筛选、统计、分组或分块读取。
- `coverage.status=complete` 表示可对未命中和统计结果下完整结论；`partial` 或 `unknown` 时不得据此断言数据不存在或当前数量就是总数。
- `responseId` 绑定当前 session 和当前 turn；turn 结束后失效，不写入聊天记录或持久化存储。
- 原生运行且未配置 `CODEX_SANDBOX_MODE` 时,配置 `OA_API_BASE_URL` 会让 Codex thread 使用 `workspace-write` 沙箱并开启 `network_access`,用于让 `agent` 工作目录下的 `scripts/callOaApi.mjs` 访问本机内部工具端点。
- Docker Compose 显式设置 `CODEX_SANDBOX_MODE=danger-full-access`,由非 root、`cap_drop: ALL`、`no-new-privileges`、Docker seccomp/AppArmor 和独立网络共同构成外部隔离边界,避免 Codex 在受限容器内再次通过 `bwrap` 创建 namespace。不要在没有等价外部隔离的原生进程中使用该模式。

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

- 本服务内部把 `sessionId -> threadId` 和 `summary` 保存到 `AGENT_SESSION_STORE` 指定的 JSON 文件。
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
