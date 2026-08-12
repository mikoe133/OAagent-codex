# OA Agent Demo

这是一个前后端分离、同仓库管理的 npm workspaces 项目。

- `agent/`: 后端 agent 服务,包含 Codex SDK 调用、HTTP API、提示词、受控 OA API 工具和 `openapi/openapi.json`。
- `frontend/`: Next.js 前端工作区,包含登录、会话列表、流式聊天 UI 和服务端 BFF。
- 根目录: 只负责统一安装依赖、调度 workspace 脚本、保存共享文档和 `.env`。

agent 优先从 `OA_OPENAPI_URL`(默认 `https://api-oa.rwkvos.com/openapi_json`)获取 OA 接口契约;远程请求失败、返回非 2xx 或内容不是合法 OpenAPI JSON 时,自动回退到 `agent/openapi/openapi.json`。选中的契约是回答 OA 后端接口问题的唯一事实来源,不引入额外 Skill、MCP、function tools 或多 agent 编排。详见 [docs/agent-demo-implementation-plan.md](docs/agent-demo-implementation-plan.md)。

## 运行

一次性 CLI:

```bash
npm install
cp .env.example .env   # 填入 NEXTTOKEN_API_KEY 和 OPENROUTER_API_KEY
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

OA Web 可通过服务端 SSO 启动路由打开 OA Agent。两边 Web 服务端配置相同的
`OA_AGENT_SSO_SHARED_SECRET`；OA Web 设置 `OA_AGENT_SSO_URL=https://oa-agent.rwkvos.com`。
SSO code 默认在 Agent 进程内存中保存 60 秒并只能消费一次，单实例部署适用；多实例部署
需要将票据存储迁移到共享 Redis。

默认监听 `http://127.0.0.1:3000`,并把 `sessionId -> Codex threadId` 映射持久化到 `.context/agent-sessions.json`。完整接口说明见 [docs/server-api.md](docs/server-api.md)。

后台服务不包含按关键词硬编码的 OA 直连分支。所有消息都会进入 Codex agent,由 agent 基于远程优先、本地兜底选中的 OpenAPI 契约分析接口能力;配置 `OA_API_BASE_URL` 后,agent 可通过受控 `callOaApi` 工具调用 OpenAPI 中声明的 OA 接口。Web 和 agent 使用同一枚用户 OA token,并分别通过 OA 的已登录用户接口验证。

```bash
# 创建 session。不传 sessionId 时服务自动生成。
curl -s -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <OA_USER_TOKEN>" \
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

所有 `/v1/*` 请求都必须携带 OA token。token 缺失或被 OA 拒绝时返回 `401`;OA 验证服务不可用时返回 `503`,不会降级放行。

启动前校验:缺少 `NEXTTOKEN_API_KEY`、`OPENROUTER_API_KEY` 或作为兜底的 `agent/openapi/openapi.json` 直接失败。运行任务时优先读取 `OA_OPENAPI_URL`;远程不可用或内容非法时自动使用本地文件。未配置 `OA_API_BASE_URL` 时服务仍可启动,但 `/v1/*` 会因无法验证 OA token 返回 `503`,一次性 CLI 只做接口分析。

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
  openapi/openapi.json   远程 OpenAPI 不可用时的本地兜底契约
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
# 必填:NEXTTOKEN_API_KEY、OPENROUTER_API_KEY、OA_AGENT_SSO_SHARED_SECRET
# 按 OA 服务端配置填写 OA_AGENT_SSO_TTL_SECONDS
```

同机部署 OA 时保留:

```dotenv
OA_DOCKER_API_BASE_URL=http://host.docker.internal:8010
OA_API_TOKEN_HEADER=Cookie
OA_API_TOKEN_PREFIX=sessionid=
OA_AGENT_SSO_SHARED_SECRET=<与 OA 服务端一致的随机密钥>
OA_AGENT_SSO_TTL_SECONDS=300
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

Compose 只向宿主机发布 web 端口,agent 仅在内部网络暴露。`agent` 容器通过 `CODEX_SANDBOX_MODE=danger-full-access` 将 Docker 作为 Codex 命令的隔离边界,并继续使用非 root、`cap_drop: ALL`、`no-new-privileges` 和 Docker 默认 seccomp/AppArmor;不要为运行 Codex 内层 `bwrap` 而给容器增加 `SYS_ADMIN` 或关闭这些保护。原生运行不设置该变量,仍使用 Codex 自身的 `read-only/workspace-write` 沙箱。

`agent_sessions` 保存 session 映射,`agent_codex_home` 保存 Codex thread 状态;普通 `docker compose down` 不会删除它们。不要在有数据时执行 `docker compose down -v`。

如果 OA 在另一台机器,把 `OA_DOCKER_API_BASE_URL` 改为 OA 的 HTTPS API 地址。生产环境应在 web 前配置 HTTPS 反向代理,因为登录 cookie 在 production 模式带 `Secure` 属性;直接通过服务器 IP 的 HTTP 地址访问会导致登录态不可用。

自动任务系统已集成进现有 `agent` 服务：前端和 `project-progress-worker` 的 `AUTOMATION_API_BASE_URL` 指向 `http://agent:3000`，`PROJECT_SYNC_API_BASE_URL` 仍指向保留项目/GitHub 总结接口的原 OA。任务数据存入独立 MySQL，迁移命令、Secret 和切流步骤见 [docs/automation-node-migration.md](docs/automation-node-migration.md)。

## GitHub Actions CI/CD

仓库提供 `.github/workflows/ci-cd.yml`:Pull Request 自动运行测试、构建并验证两个 Docker 镜像;合并到 `test` 后部署测试环境,合并到 `main` 后部署生产环境。两个环境都使用各自提交的 SHA 镜像,部署失败会自动恢复上一版镜像和运行配置。

最简服务器准备、Secret/Variable 配置和双环境发布步骤见 [docs/dual-environment-deployment.md](docs/dual-environment-deployment.md);CI/CD 内部流程和回滚说明见 [docs/cicd.md](docs/cicd.md)。

GitHub Actions 暂时不可用或 Artifact 配额耗尽时,使用 [手动受限构建部署](docs/manual-server-deployment.md)。该流程由本地上传源码,在服务器通过受限 BuildKit 顺序构建并保留自动回滚。
