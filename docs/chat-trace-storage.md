# AI 对话 Trace 持久化

新对话请求由 Agent 保存 Trace，不依赖浏览器保持连接。保存的是已经脱敏的公开事件：任务进度、工具调用输入/输出、阶段耗时、中间回复和终态；不保存 Codex 内部 sessionId / threadId 顶层字段，也不采集隐藏推理。

## 保存位置

- 本地：`${AGENT_SESSION_STORE}.public-requests/<key>.trace.jsonl`。
- 默认开发路径：`.context/agent-sessions.json.public-requests/<key>.trace.jsonl`。
- Compose 容器路径：`/app/.context/agent-sessions.json.public-requests/<key>.trace.jsonl`，由 `agent_sessions` 卷持久化。
- OA：Copilot 会话 `record.messages[]` 中 assistant 消息的 `traceEvents` 字段。

`key` 沿用请求幂等索引，是 OA 地址、alias、用户、recordId 和 requestId 的哈希。每行事件包含 `sequence`、`occurredAt` 和事件内容。文件权限为 `0600`；每条事件追加后同步到磁盘，再发送给浏览器。回复正文按增量保存，避免每个 token 重复保存整篇正文。

## 读取与恢复

- `GET /v1/sessions/{recordId}/requests/{requestId}` 返回 `traceEvents`，包括运行中、失败、取消和重启后状态为 `unknown` 的请求。读取仍需通过 OA 会话归属校验。
- 成功 SSE 的 `run.completed.result.traceEvents`、失败 SSE 的 `run.failed.traceEvents` 返回已保存的完整 Trace；幂等重放不会重复写事件或调用模型。
- 重新打开 OA 历史会话时，前端从 `messages[].traceEvents` 重建 `toolSteps` 和 `traceMessages`。历史消息没有这个字段时仍按旧格式显示。
- 已执行的请求在成功、失败或取消后同步到 OA。OA 同步失败时，本地日志仍保留，`historySync` 为 `pending`；可调用 `POST /v1/sessions/{recordId}/requests/{requestId}/sync` 补存，不重新调用模型。
- 排队期间取消或超时的请求先保存本地终态日志，可在会话空闲后通过上述 `/sync` 接口补存。进程异常退出后保留已经写入的完整日志行；末尾未写完的行不参与读取。

开发模式控制更详细的阶段耗时事件是否产生；Trace 保存本身无需开启开发模式。此前只在浏览器缓存里的 Trace 不会自动迁移，服务端无法还原过去未保存的事件。

日志目前跟随请求存储目录保留，没有自动过期清理；删除 OA 会话不会自动删除本地请求日志，但该会话的公开读取将无法通过归属校验。
