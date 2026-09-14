# 生产对话接口路由

生产站点配置位于 `deploy/nginx/oa-agent.rwkvos.com.conf`。用它替换该域名现有的两个 server 块，不要重复添加同域名配置。文件由 Nginx 的 http 上下文加载，保留现有 Certbot 证书路径。

## 路由契约

| 公网路径 | 上游 | 用途 |
| --- | --- | --- |
| `/v1/models` | Agent `192.168.251.1:3011` | 模型列表 |
| `/v1/sessions` | Agent `192.168.251.1:3011` | 创建、列出 OA 会话 |
| `/v1/sessions/{recordId}` | Agent `192.168.251.1:3011` | 查询、更新、删除 OA 会话 |
| `/v1/sessions/{recordId}/messages` | Agent `192.168.251.1:3011` | 普通对话 |
| `/v1/sessions/{recordId}/messages/stream` | Agent `192.168.251.1:3011` | SSE 对话 |
| `/v1/sessions/{recordId}/requests/{requestId}` 及其 `/cancel`、`/sync` | Agent `192.168.251.1:3011` | 状态查询、取消、历史补存 |
| 其他 `/v1/*`、`/internal`、`/internal/*`、`/__internal`、`/__internal/*` | 无，返回 404 | 默认不公开 |
| 其他路径 | Web `192.168.251.1:3010` | 页面、静态资源、登录、SSO、原有 Web API |

公开会话子路径由 Agent 再校验路由和 HTTP 方法；不存在的接口返回 404。`/health` 没有作为 Agent 公网接口开放。OA 自动化内部调用继续使用可达的私网 Agent 地址，不使用这个公网域名。

外部系统使用 `https://oa-agent.rwkvos.com/v1`，携带 `Authorization: Bearer <OA Token>`。Nginx 转发原始路径和 Token，Agent 继续调用 OA 校验用户并隔离会话。Web `/api/chat` 保留原来的 Cookie 登录流程。此配置面向服务端调用或同源网页，不添加跨域 CORS 放行。

## 上游端口与部署

配置沿用当前 Nginx 的 `192.168.251.1` 地址，生产端口依据仓库约定为 Web `3010`、Agent `3011`。先从 **Nginx 所在机器或容器** 验证：

```sh
curl -i http://192.168.251.1:3011/health
curl -i http://192.168.251.1:3010/login
```

Agent 必须能返回 200。若 3011 不通，生产运行环境需要：

```dotenv
AGENT_BIND_ADDRESS=192.168.251.1
AGENT_PORT=3011
```

修改绑定地址后需重新创建 Agent 容器，仅 reload Nginx 不会改变 Docker 端口绑定。通过 CI 部署时还需同步 production 环境的 `AGENT_BIND_ADDRESS` variable，否则下一次部署可能恢复为 `127.0.0.1`。保留现有可用的 Web 端口绑定。

若 Nginx 是宿主机原生进程，也可将两个 proxy_pass 地址改为 `127.0.0.1` 并保留 loopback 绑定。容器内的 `127.0.0.1` 指向容器自身，不指向宿主机。Agent 端口只需对 Nginx 和既有私网调用方可达，无需对公网开放。

备份当前站点配置后替换，使用实际管理该站点的 Nginx 执行：

```sh
nginx -t
# 仅在语法检查成功后执行：
nginx -s reload
```

如果使用容器或管理面板，在对应容器/面板执行检查和重载。本仓库文件不会自动部署到生产 Nginx。

## 接入验证

不带 Token 应返回 401；内部和未开放的 API 路径应返回 404：

```sh
curl -i https://oa-agent.rwkvos.com/v1/models
curl -i https://oa-agent.rwkvos.com/internal/v1/models
curl -i -X POST https://oa-agent.rwkvos.com/__internal/call-oa-api
curl -i https://oa-agent.rwkvos.com/v1/automation/models
```

以下示例中的 `OA_TOKEN` 由调用环境安全提供，不要把真实 Token 写进配置或文档：

```sh
curl -i https://oa-agent.rwkvos.com/v1/models \
  -H "Authorization: Bearer $OA_TOKEN"

curl -i https://oa-agent.rwkvos.com/v1/sessions \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{}'
```

将返回的 OA recordId 设为 `RECORD_ID`，为本条消息生成并保存 `REQUEST_ID`，再验证 SSE（会实际运行一次对话）：

```sh
curl -N "https://oa-agent.rwkvos.com/v1/sessions/$RECORD_ID/messages/stream" \
  -H "Authorization: Bearer $OA_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REQUEST_ID" \
  --data '{"message":"你好"}'
```

应收到 `text/event-stream`、逐步事件和最终 `run.completed`，失败时查看 `run.failed`，不能只凭 HTTP 200 判断运行成功。配置关闭代理缓冲与缓存，空闲读写超时为 3600 秒；这不是任务执行期限。对话请求体限制为 128 KiB，与 Agent 一致，超限由 Nginx 返回 413（默认 Nginx 错误页）；Web 保留 20 MiB。网关不自动重放上游请求，Agent 已实现请求编号幂等；下游 OA 写操作自身的幂等仍需各业务接口保证。

新接口以 OA recordId 为索引，具体响应与调度参数见 [服务端接口文档](server-api.md)。Web /api/chat/sessions 只代理 Agent，标题与反馈更新不会覆盖 Agent 生成的历史消息。
