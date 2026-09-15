# OA Agent 对外接口文档

版本：2026-09-14。本文以当前仓库实现为准，面向外部系统接入；实际可用性取决于目标环境是否部署对应版本及 Nginx 配置。

## 1. 地址与鉴权

| 环境 | Base URL |
| --- | --- |
| 测试 | `https://test.oa-agent.rwkvos.com/v1` |
| 生产 | `https://oa-agent.rwkvos.com/v1` |

下文路径相对于 Base URL。所有接口必须携带有效的 OA 用户 Token：

```http
Authorization: Bearer <OA_TOKEN>
Content-Type: application/json
```

Agent 向 OA 验证 Token。会话、历史、请求查询、重放和取消均受当前用户权限限制；OA 鉴权不可用时不会放行。不要将 Token 放入 URL。

- 会话唯一编号：`recordId`，由 OA Copilot 创建后返回。按字符串处理，例如 `"457"`，格式为无前导零的十进制正整数。
- 消息请求编号：`requestId`，由调用方生成，推荐 UUID。通过 `Idempotency-Key` 请求头传入。
- 不需要传入 `sessionId`、`threadId` 或 `runId`。
- JSON 请求体最大 128 KiB；接口当前只接收文本，不支持直接上传图片或文件。
- 响应没有统一的 `data` 包装：会话对象、请求对象、列表分别按下文返回。
- 当前适用于服务端调用、同源页面调用；未配置第三方浏览器跨域 CORS。

## 2. 接口总览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/models` | 获取可选模型 |
| POST | `/sessions` | 创建 OA 会话 |
| GET | `/sessions` | 分页查询会话列表 |
| GET | `/sessions/{recordId}` | 查询会话详情和 OA 中的历史 |
| PATCH | `/sessions/{recordId}` | 修改标题、消息反馈 |
| DELETE | `/sessions/{recordId}` | 删除 OA 会话 |
| POST | `/sessions/{recordId}/messages` | 普通 AI 对话，等待结果 |
| POST | `/sessions/{recordId}/messages/stream` | SSE 流式 AI 对话 |
| GET | `/sessions/{recordId}/messages` | 分页查询消息历史 |
| GET | `/sessions/{recordId}/requests/{requestId}` | 查询请求状态和结果 |
| POST | `/sessions/{recordId}/requests/{requestId}/cancel` | 请求取消 |
| POST | `/sessions/{recordId}/requests/{requestId}/sync` | 将成功结果补存到 OA 历史 |

`/internal/*`、`/__internal/*`、自动化模型管理接口不属于这套公开对话 API。Web 的 `/api/chat/*` 是网页适配接口，外部系统应使用本文的 `/v1/*`。

## 3. 获取模型

```http
GET /models
```

成功：HTTP 200。响应示意，模型以实际接口返回为准：

```json
{
  "provider": "nexttoken",
  "models": ["gpt-5.6-terra"],
  "providers": {
    "nexttoken": ["gpt-5.6-terra"],
    "openrouter": ["z-ai/glm-5.3"]
  }
}
```

`provider` 是服务端默认提供商，`models` 是其白名单；`providers` 给出各提供商的完整白名单。

## 4. 创建会话

```http
POST /sessions
```

```json
{"title":"周报助手"}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| title | 否 | 字符串，最大 200 字符，省略/空标题使用 `New Section` |

不可提交自定义 recordId 或 sessionId。成功返回 HTTP 201，`Location: /v1/sessions/457`：

```json
{
  "recordId": "457",
  "schema": "oa-agent-chat/v1",
  "title": "周报助手",
  "summary": null,
  "messages": [],
  "createdAt": 1789371800,
  "updatedAt": 1789371800
}
```

会话时间沿用 OA 的数据，可能为 Unix 秒或 ISO 8601 字符串。创建会话本身没有幂等支持：创建结果未知时不要盲目自动重试，应先核对会话列表。

## 5. 查询会话列表与详情

```http
GET /sessions?page=1&size=20
```

- page：默认 1，范围 1～1000000。
- size：默认 20，范围 1～100。

HTTP 200：

```json
{
  "sessions": [
    {"recordId":"457","title":"周报助手","summary":null,"messages":[],"createdAt":1789371800,"updatedAt":1789371800}
  ],
  "page": 1,
  "size": 20,
  "total": 1
}
```

查询详情：`GET /sessions/457`，HTTP 200，返回与创建接口同类的会话对象，含已保存的 messages。既有 OA 记录可能带有额外业务字段，客户端应允许新增字段。

## 6. 普通 AI 对话

```http
POST /sessions/457/messages
Idempotency-Key: req-001
```

```json
{
  "message": "请回复一句你好",
  "provider": "nexttoken",
  "model": "gpt-5.6-terra"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| message | 是 | 文本，去掉首尾空白后不能为空 |
| provider | 否 | `nexttoken` 或 `openrouter`，省略使用服务端默认值 |
| model | 否 | 对应 provider 的白名单模型；省略使用默认模型 |
| requestId | 条件 | 不使用 Idempotency-Key 请求头时在此提供；两处同时提供必须完全相同 |
| developerMode | 否 | boolean，默认 false，通常无需设置 |
| routerModel | 否 | 指定语义路由模型，通常无需设置；当前白名单见下文 |

当前 routerModel 白名单为 `z-ai/glm-4.7-flash`、`qwen/qwen3.5-flash-02-23`、`deepseek/deepseek-v4-flash`，与正式回答模型的 `/models` 白名单不是同一用途。普通接入建议省略这两个高级参数。

推荐显式指定 provider/model，使默认模型升级不影响重试的参数一致性。只传本轮用户消息；多轮上下文由 Agent 维护，不提交 messages 数组。

成功返回 HTTP 200：

```json
{
  "recordId": "457",
  "requestId": "req-001",
  "message": "请回复一句你好",
  "state": "completed",
  "createdAt": "2026-09-14T08:00:00.000Z",
  "updatedAt": "2026-09-14T08:00:08.000Z",
  "historySync": "synced",
  "result": {
    "recordId": "457",
    "requestId": "req-001",
    "finalResponse": "你好！",
    "provider": "nexttoken",
    "model": "gpt-5.6-terra",
    "knowledgeSources": []
  }
}
```

普通消息接口会等待任务结束，不是立即返回的异步提交接口。读取回答用 `result.finalResponse`。knowledgeSources 是本轮知识库来源列表，无引用时为空数组。

响应头：

```http
Idempotency-Key: req-001
Idempotency-Replayed: false
Location: /v1/sessions/457/requests/req-001
```

## 7. SSE 流式 AI 对话

```http
POST /sessions/457/messages/stream
Idempotency-Key: req-002
```

请求字段与普通对话相同，响应为 `text/event-stream`。

```text
event: run.queued
data: {"type":"run.queued","recordId":"457","requestId":"req-002"}

event: message.delta
data: {"type":"message.delta","recordId":"457","requestId":"req-002","itemId":"m1","delta":"你好","text":"你好"}

event: run.completed
data: {"type":"run.completed","recordId":"457","requestId":"req-002","historySync":"synced","result":{"recordId":"457","requestId":"req-002","finalResponse":"你好！","provider":"nexttoken","model":"gpt-5.6-terra","knowledgeSources":[]}}
```

| 事件 | 用途 |
| --- | --- |
| run.queued | 已进入流式处理，后续查询以请求 state 为准 |
| run.started、turn.started | 执行进度 |
| progress | 路由/准备等进度信息 |
| message.delta | 增量文本；delta 为增量，text 为对应 item 当前文本 |
| tool.started、tool.updated、tool.completed | 工具执行过程 |
| run.completed | 成功终态，以 result.finalResponse 为完整最终回答 |
| run.failed | 失败终态，包含 error，通常还有 state |

工具和消息的 itemId 是事件关联字段，不是需要额外管理的会话或运行编号。客户端不能将所有不同 item 的文本简单合并为最终回答，应以 run.completed 为准。

每约 15 秒发送 `: keep-alive` 注释心跳；忽略以冒号开头的行。事件以空行分隔，网络 chunk 不等于一个完整事件，需要缓冲后解析。SSE 为 POST，浏览器应使用 fetch 流式读取，而不是原生 EventSource。

HTTP 200 只表示 SSE 已建立，不代表对话成功。收到 run.failed 或连接结束前没有 run.completed，都不能当作成功。断线后任务继续执行，用请求查询接口确认结果；不支持 Last-Event-ID 断点续传。成功重放的 SSE 返回 run.queued 和最终 run.completed，不重放历史增量或工具过程。

## 8. 查询请求与安全重试

```http
GET /sessions/457/requests/req-002
```

HTTP 200，返回第 6 节中的请求记录格式。未完成时没有 result；失败时可能有 errorCode。

| state | 含义 |
| --- | --- |
| queued | 已受理，等待执行 |
| running | 执行中 |
| completed | 结果已持久化 |
| failed | 执行失败或超时 |
| cancelled | 已处理取消 |
| unknown | 当前进程没有对应执行，但磁盘记录未完成；可能发生过重启，需要核对业务结果 |

| historySync | 含义 |
| --- | --- |
| pending | 历史尚未确认保存；需结合 state 判断，不能直接认为 AI 失败 |
| synced | 本次成功消息已保存到 OA |

幂等规则：

1. 首次发送前生成并保存 requestId；重试时保持同一 recordId、requestId 和消息/模型参数。
2. 相同编号、相同参数且已完成：复用原结果，Idempotency-Replayed 为 true，不调用模型。
3. 相同编号、不同参数：HTTP 409，code=idempotency_conflict。
4. 原请求执行中：HTTP 409，code=idempotency_pending，附 Retry-After: 3；不要自动换编号。
5. 原请求失败、取消或 unknown：不重新执行。普通消息重放返回 HTTP 409 和请求对象；SSE 重放通过 run.failed 表达。
6. 新一轮消息使用新编号。同一个编号可在不同会话中独立使用，但不能用它代表同一会话里的两条新消息。
7. 请求编号不会因服务重启而自动失效，目前没有自动过期机制。

请求编号格式为 `^[A-Za-z0-9_.:-]{1,120}$`。Token 刷新但用户身份不变时，可以继续访问原请求。

## 9. 查询历史

```http
GET /sessions/457/messages?limit=20&cursor=0
```

limit 默认 20，范围 1～100。首轮可不传 cursor，后续传入响应的 nextCursor。

```json
{
  "recordId": "457",
  "messages": [
    {"id":"req-001:user","requestId":"req-001","role":"user","content":"请回复一句你好","createdAt":"2026-09-14T08:00:00.000Z"},
    {"id":"req-001:assistant","requestId":"req-001","role":"assistant","content":"你好！","status":"completed","knowledgeSources":[],"createdAt":"2026-09-14T08:00:08.000Z"}
  ],
  "nextCursor": null
}
```

nextCursor=null 表示本次读取已到末尾。当前游标是消息偏移量，不是快照游标。历史来自 OA Copilot；失败、取消的执行详情应查请求接口，未成功同步到 OA 的结果也应先查请求接口。

## 10. 取消、历史补存、会话修改与删除

### 取消

```http
POST /sessions/457/requests/req-002/cancel
```

无需请求体。HTTP 202：

```json
{"recordId":"457","requestId":"req-002","cancellationRequested":true,"state":"running"}
```

这里只表示已请求取消，继续 GET 查询最终状态。已经完成、失败或当前进程没有运行时 cancellationRequested 可能为 false。取消不回滚已发生的 OA 操作。

### 历史补存

```http
POST /sessions/457/requests/req-002/sync
```

适用于 state=completed、historySync=pending。无需请求体，成功 HTTP 200，返回更新后的请求记录。只写 OA 历史，不调用模型；重复补存不会重复追加同一消息。有会话任务执行中时返回 409 session_busy。

### 修改标题或反馈

```http
PATCH /sessions/457
```

```json
{
  "title": "新的会话标题",
  "feedback": {"req-001:assistant":"like"}
}
```

title 最长 200 字符。feedback 的键为历史接口返回的消息 id，值为 like、dislike 或 null（清除反馈）；只更新匹配消息。只允许 title、feedback 字段，不允许整体覆盖 messages。有活动/排队任务时返回 409 session_busy。成功 HTTP 200，返回会话对象。

### 删除会话

```http
DELETE /sessions/457
```

成功 HTTP 200：`{"recordId":"457","deleted":true}`。有活动/排队任务时返回 409 session_busy；会话不存在或无权访问时以 OA/Agent 返回状态为准，不保证重复删除返回 200。删除后不能再通过公开接口查询该会话的旧请求。

## 11. 状态码与错误格式

常见接口错误：

```json
{"code":"invalid_request_id","error":"必须提供 Idempotency-Key；与 requestId 同时提供时须一致"}
```

鉴权层部分错误仅返回 `{"error":"unauthorized"}`，并非所有错误都带 code。执行失败查询对象使用 errorCode。不要仅依赖一个固定错误 JSON 结构。

| HTTP 状态 | 常见原因 |
| --- | --- |
| 400 | invalid_json、invalid_request_id、invalid_message、invalid_model、invalid_patch 等参数错误 |
| 401 | Token 缺失或失效 |
| 403/404 | 无权限、OA 记录不存在或接口不存在 |
| 405 | 不支持的方法 |
| 409 | idempotency_conflict、idempotency_pending、session_busy、result_unavailable，或普通消息返回失败/取消/未知的请求对象 |
| 413 | 请求体超过 128 KiB；Nginx 拒绝时可能返回 HTML |
| 429 | user_rate_limited、user_queue_full |
| 502 | OA 返回错误或无效数据，如 oa_record_error、oa_invalid_response |
| 503 | queue_full、oa_unavailable、oa_identity_unavailable、chat_storage_unavailable，或 OA 鉴权服务不可用 |

排队超时请求的 errorCode 为 queue_timeout，尚未执行模型；执行超时通常为 execution_timeout；其他模型失败通常为 agent_failed。执行超时/失败不代表下游业务操作未生效。

## 12. 默认容量限制

以下为代码默认值，部署可覆盖：

| 项目 | 默认值 |
| --- | --- |
| 全局执行并发 | 2 |
| 单用户执行并发 | 1 |
| 全局等待数 | 20 |
| 单用户等待数 | 5 |
| 单用户每分钟新请求 | 20 |
| 最长排队时间 | 120 秒 |
| 执行取消信号时限 | 600 秒 |

按 OA 用户限制，不按 Token 字符串限制。同一会话串行，不同用户轮换获得执行机会。重放/结果查询不重复占模型名额。429/503 时按 Retry-After 等待；容量拒绝的未受理请求可使用原编号重试。执行时限只发出取消信号，实际任务退出才释放名额。

当前服务为单 Agent 进程模式；多副本共享幂等、会话写入与调度需要额外部署设计。

## 13. 最小接入示例

以下示例使用 curl 和 jq。OA_TOKEN 由调用环境安全提供，不要写进源码。

```bash
BASE_URL=https://test.oa-agent.rwkvos.com/v1

# 1. 创建会话并保存 OA 编号
SESSION_JSON=$(curl --fail-with-body -sS "$BASE_URL/sessions" \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"title":"接口联调"}')
RECORD_ID=$(printf '%s' "$SESSION_JSON" | jq -er '.recordId')

# 2. 首次发送前生成并保存请求编号
REQUEST_ID=$(uuidgen)

# 3. 流式发送本轮用户消息
curl --fail-with-body -N "$BASE_URL/sessions/$RECORD_ID/messages/stream" \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H "Idempotency-Key: $REQUEST_ID" \
  -H 'Content-Type: application/json' \
  --data '{"message":"你好，请简短介绍你的能力"}'

# 4. 查询最终状态；断线后也使用同一个编号
curl --fail-with-body -sS "$BASE_URL/sessions/$RECORD_ID/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $OA_TOKEN"
```

线上调用必须同时处理 HTTP 错误、SSE run.failed、连接中断和 historySync=pending。下一轮继续使用 RECORD_ID，但生成新的 REQUEST_ID。
