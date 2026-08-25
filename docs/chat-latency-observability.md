# Chat latency observability

Agent 服务会为每个 `/v1/sessions/:sessionId/messages` 和
`/v1/sessions/:sessionId/messages/stream` 请求输出一条结构化日志：

```text
[chat-latency] {"event":"chat.latency",...}
```

日志只包含服务端生成的 `requestId`、模型选择、状态和耗时，不记录
sessionId、用户消息、prompt、token 或工具输入输出。

## Durations

- `auth`: OA 登录态校验。
- `queue_wait`: 同一 session 上一个请求结束前的排队等待。
- `session_prepare`: session 读取、创建或登录态绑定。
- `contracts`: OA 与知识库 OpenAPI 契约和索引准备。
- `semantic_route`: 语义路由模型调用。
- `request_routing`: session 准备、契约准备和语义路由总耗时。
- `persistence`: thread id 和会话摘要持久化累计耗时。
- `codex_startup`: 正式模型调用到 `turn.started`。
- `request_ttft`: HTTP 请求开始到第一段回答文本。
- `model_ttft`: 正式模型调用开始到第一段回答文本。
- `model_inference`: `turn.started` 到第一段回答文本。
- `model_turn`: `turn.started` 到 `turn.completed`。
- `stream_drain`: `turn.completed` 到 Codex 事件流关闭。
- `total`: 整个请求总耗时。

`tools` 按工具类型记录调用数量和累计耗时。并行工具的累计耗时可能大于
请求墙钟时间。

## Rolling distributions

每条日志的 `rolling` 字段包含最近 100 个请求的阶段分布，提供 `count`、
`p50`、`p95` 和 `max`。服务重启后窗口重新开始累计。

本地观察日志：

```bash
npm run dev:server 2>&1 | rg '\[chat-latency\]'
```
