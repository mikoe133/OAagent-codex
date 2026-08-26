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

## Semantic routing prompt

语义路由先使用本地 OpenAPI 索引筛选最多 20 个相关接口，再把接口的
方法、路径、摘要、operationId 和最多 4 个关键参数名发送给独立
路由模型，不发送完整 OpenAPI 文档或 schema。候选召回以完整用户请求
为主，必要时附带最近会话摘要；每个可用接口域也会保留必要的代表接口。

路由模型只接收最近最多 1000 字的会话摘要。服务兼容模型将 JSON 放在
`message.content`、`message.reasoning` 或 reasoning details 的返回格式；
Qwen Flash 的路由请求显式关闭推理输出，避免推理预算挤占结构化 JSON；
解码层兼容模型偶尔返回的单数 `catalog`、单数 `operationId` 和逗号分隔
的字符串字段，但不会据此推断固定业务关键词；
如果首次结果无效，或模型选择了不在候选列表中的接口，服务会把候选范围
扩大到最多 40 个接口重试一次，但两次尝试共享 8 秒总预算。仍失败时只保留可用的 OA 与知识库读取候选作为安全降级，
不会根据问题中的固定词语推断目录，也不会在路由失败时暴露知识库写接口。
如果用户选择的路由模型与默认 GLM Flash 不同，服务会并发执行两个独立的
语义路由；第一个返回有效路由的模型胜出，并取消另一个未完成请求。两个模型
都失败才进入安全降级。备用模型胜出时，开发模式 trace 会记录模型切换和
首选模型失败原因（如果首选模型已经明确失败）。若首选模型仍在运行，trace 会说明
备用模型先完成并取消了较慢请求。这种竞速会增加模型请求成本，
但能显著降低单个模型慢响应或格式异常造成的长尾延迟。

## Developer mode

聊天页侧边栏用户菜单提供默认关闭的“开发模式”。开启后可以在
“路由模型配置”中选择独立的国产轻量语义路由模型：

- `z-ai/glm-4.7-flash`，默认选项。
- `qwen/qwen3.5-flash-02-23`。
- `deepseek/deepseek-v4-flash`。

该选择只影响语义路由，正式回答继续使用输入框中选择的模型。关闭
开发模式后，已选择的路由模型仍然持续生效；开发模式只控制配置入口
和调试信息展示。
开发模式同时在 AI 回复的 trace 中展示任务编排、会话准备、接口契约、
语义路由、模型启动、模型首字和各次工具调用的服务端耗时。
开发模式和路由模型选择仅保存在当前浏览器的 localStorage 中。
