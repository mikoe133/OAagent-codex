# OA Agent Demo

这是一个前后端分离、同仓库管理的 npm workspaces 项目。

- `agent/`: 后端 agent 服务,包含 Codex SDK 调用、HTTP API、提示词、受控 OA API 工具和 `openapi/openapi.json`。
- `frontend/`: Next.js 前端工作区,包含登录、会话列表、流式聊天 UI 和服务端 BFF。
- 根目录: 只负责统一安装依赖、调度 workspace 脚本、保存共享文档和 `.env`。

agent 依据 `agent/openapi/openapi.json` 作为唯一事实来源回答 OA 后端接口问题,不引入额外 Skill、MCP、function tools 或多 agent 编排。详见 [docs/agent-demo-implementation-plan.md](docs/agent-demo-implementation-plan.md)。

## 运行

一次性 CLI:

```bash
npm install
cp .env.example .env   # 填入 OPENROUTER_API_KEY
npm run dev -- "我想查一下周报列表,应该调用哪个接口?"
```

后台服务:

```bash
npm run dev:server
```

前端工作区:

```bash
npm run dev:frontend
```

默认监听 `http://127.0.0.1:3000`,并把 `sessionId -> Codex threadId` 映射持久化到 `.context/agent-sessions.json`。完整接口说明见 [docs/server-api.md](docs/server-api.md)。

后台服务不包含按关键词硬编码的 OA 直连分支。所有消息都会进入 Codex agent,由 agent 基于 `agent/openapi/openapi.json` 分析接口能力;配置 `OA_API_BASE_URL` 后,agent 可通过受控 `callOaApi` 工具调用 OpenAPI 中声明的 OA 接口。OA 登录态优先来自前端请求 header 中的用户 token,没有用户 token 时才 fallback 到 `.env` 的 `OA_API_TOKEN`。

```bash
# 创建 session。不传 sessionId 时服务自动生成。
curl -s -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"sessionId":"demo"}'

# 往同一个 session 继续发消息。服务会 resume 对应 Codex thread。
curl -s -X POST http://127.0.0.1:3000/v1/sessions/demo/messages \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <OA_USER_TOKEN>" \
  -d '{"message":"我想查一下周报列表,应该调用哪个接口?"}'

# 流式发送消息。中途可看到部分输出、进展和工具调用。
curl -N -X POST http://127.0.0.1:3000/v1/sessions/demo/messages/stream \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <OA_USER_TOKEN>" \
  -d '{"message":"我想查一下周报列表,应该调用哪个接口?"}'
```

如果把 `HOST` 改成非本机地址,必须配置 `AGENT_API_TOKEN`,请求时带上 `Authorization: Bearer <AGENT_API_TOKEN>`。此时 `Authorization` 已被服务鉴权占用,前端用户 OA token 建议改用 `X-OA-Api-Token: Bearer <OA_USER_TOKEN>`。

启动前校验:缺少 `OPENROUTER_API_KEY` 或 `agent/openapi/openapi.json` 直接失败。未配置 `OA_API_BASE_URL` 时只做接口分析,不执行真实 OA 请求。配置了 `OA_API_BASE_URL` 但请求未携带用户 OA token、`.env` 也未配置 `OA_API_TOKEN` 时,agent 只能做接口分析或得到 `oa_not_configured` 工具错误。

## 脚本

```text
npm run dev              运行 agent 一次性 CLI
npm run dev:server       启动 agent HTTP 服务
npm run dev:frontend     进入 frontend workspace
npm run build            构建所有有 build 脚本的 workspace
npm run typecheck        检查所有有 typecheck 脚本的 workspace
```

## 结构

```text
agent/                   后端 workspace
  openapi/openapi.json   后端接口能力的唯一事实来源
  prompts/               系统提示词(system / document-policy / output-policy)
  scripts/               后端受控工具脚本
  src/                   后端 TypeScript 源码
frontend/                前端 workspace
docs/                    实现规划、服务 API 文档与验收记录
```

## 验收

见 [docs/m4-acceptance-record.md](docs/m4-acceptance-record.md):接口定位与敏感删除确认两个样例均通过。

## Docker Compose 部署

现有 OA 服务端 Compose 把宿主机 `8010` 映射到 `rwkvoa` 容器的 `9010`。本项目保持 OA 服务独立运行,由 `agent` 和 `web` 通过 `host.docker.internal:8010` 访问它,因此不需要修改 OA 服务端的 Compose 文件。

部署拓扑:

```text
browser -> web:3000 -> agent:3000 (Docker 内部网络)
                    -> host.docker.internal:8010 -> rwkvoa:9010
```

准备环境变量:

```bash
cp .env.example .env
# 必填:OPENROUTER_API_KEY
# 必填:AGENT_API_TOKEN,agent 与 web 使用同一个随机值
openssl rand -hex 32
```

把生成值填入 `.env` 的 `AGENT_API_TOKEN`。同机部署 OA 时保留:

```dotenv
OA_DOCKER_API_BASE_URL=http://host.docker.internal:8010
WEB_BIND_ADDRESS=0.0.0.0
WEB_PORT=3000
```

构建并启动:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f agent web
```

验证:

```bash
curl -fsS http://127.0.0.1:3000/login >/dev/null
docker compose exec agent node -e "fetch('http://127.0.0.1:3000/health').then(async r=>console.log(r.status,await r.text()))"
```

Compose 只向宿主机发布 web 端口,agent 仅在内部网络暴露。`agent_sessions` 保存 session 映射,`agent_codex_home` 保存 Codex thread 状态;普通 `docker compose down` 不会删除它们。不要在有数据时执行 `docker compose down -v`。

如果 OA 在另一台机器,把 `OA_DOCKER_API_BASE_URL` 改为 OA 的 HTTPS API 地址。生产环境应在 web 前配置 HTTPS 反向代理,因为登录 cookie 在 production 模式带 `Secure` 属性;直接通过服务器 IP 的 HTTP 地址访问会导致登录态不可用。
