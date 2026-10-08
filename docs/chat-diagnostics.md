# 聊天与登录跳转诊断

浏览器和 Web 服务端的结构化日志统一以 `[oa-chat]` 开头。记录时间、请求编号 `traceId`、接口路径、方法、HTTP 状态、阶段和耗时，不记录 Cookie、Authorization、密码、聊天正文、图片、用户信息、完整 URL、响应正文或异常原文。

覆盖会话创建/列表/读取/保存/删除、消息发送、取消请求，以及当前用户身份查询。消息流另外记录完成、失败和缺失结束事件，避免把 HTTP 200 当成回答成功。普通 HTTP 耗时计算到收到响应头，消息流事件的耗时包含读取过程。

## 浏览器取日志

打开开发者工具 Console，按 `[oa-chat]` 过滤。建议打开 Preserve log，便于观察跳转过程。

同一标签页最近 100 条浏览器诊断记录保存在 `sessionStorage`，刷新和跳转登录页后仍保留；关闭标签页后清除。浏览器禁用存储时仍尝试输出 Console 日志，不影响聊天。没有自动上传浏览器日志的收集服务。

在出现错误的标签页运行以下命令即可复制记录（Chrome/Edge DevTools）：

```javascript
copy(sessionStorage.getItem('oa-chat-diagnostics') || '[]')
```

也可以在 Network 中检查出错请求，查看响应头 `x-oa-trace-id`。向维护人员提供诊断记录、发生时间和使用环境即可，不需要提供 Cookie、token 或完整 HAR。

## Web 服务端关联查询

浏览器的 `traceId` 通过 `x-oa-trace-id` 请求头传到 Web，Web 将同一编号写入日志并在响应头返回。日志编号只用于定位，不参与认证。当前关联范围是浏览器到 Web；Web 记录其对 Agent/OA 的请求结果，未修改 Agent 的日志协议。

在部署目录使用对应项目名查看日志，例如生产环境：

```bash
docker compose -p oa-agent-prod logs --since 30m web | rg '这里替换为 traceId'
```

测试环境的项目名是 `oa-agent-test`。

| 日志字段/事件 | 含义 |
| --- | --- |
| `phase: local`，最终状态 401 | Web 未取得有效格式的会话 Cookie，尚未请求 Agent |
| `phase: agent`，`upstream_response` 状态 401 | Agent 返回认证失败；继续排查 Agent 对 OA 的认证 |
| `phase: oa_auth` | 当前用户身份查询所依赖的 OA 验证结果 |
| `network_failed` | 请求未获得正常响应；不记录异常文本以避免泄露凭据 |
| `login_redirect` | 浏览器收到 401 后执行登录页跳转 |
| `prepare_failed` | 消息发送前的会话准备失败，可用同一编号查看创建/读取请求 |
| `stream_failed` / `stream_incomplete` | 消息请求已开始，但流返回失败或未收到结束事件 |
| `request_recovered` | 浏览器从原请求已持久化的 completed 结果恢复回答、trace 和确认卡片 |
| `aborted` | 请求取消，与网络故障区分 |

`response_received` 表示收到 HTTP 响应，`stream_completed` 才表示消息流报告完成。浏览器流异常且未主动取消时，会回查原 requestId 一次（最多等待 8 秒）；只有同一请求的 completed 结果可以恢复成功状态，查询不会重新执行业务操作。仍在执行、失败或无法查询时保留原错误。日志本身不改变请求、错误提示或跳转逻辑。
