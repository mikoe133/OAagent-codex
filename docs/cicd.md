# GitHub Actions CI/CD

完整的用户操作清单见 [双环境部署简单步骤](dual-environment-deployment.md)。

## 自动流程

Pull Request:

1. Agent/Web/部署测试。
2. TypeScript 类型检查。
3. 应用构建和 Compose 配置校验。
4. Agent/Web Docker 镜像构建,但不推送。

合并到 `test`:

1. 完成全部质量检查。
2. 构建 Agent/Web 镜像,以 commit SHA 推送 GHCR,并生成保留 1 天的私有部署 Artifact。
3. 部署 Job 通过 SSH 将 Artifact 加载到服务器,然后自动部署到 `test` Environment。

合并到 `main`:

1. 完成全部质量检查。
2. 构建 Agent/Web 镜像,以 commit SHA 推送 GHCR,并生成保留 1 天的私有部署 Artifact。
3. 如果 production 配置了 Required reviewer,等待人工批准。
4. 自动部署到 `production` Environment。

两个环境独立发布。推荐先把功能分支合并到 `test`,验证通过后再把 `test` 合并到 `main`。

## GitHub 配置

Repository Secrets:

| Secret | 用途 |
| --- | --- |
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | 可以直接运行 Docker 的 SSH 用户 |
| `DEPLOY_SSH_KEY` | GitHub Actions 登录服务器的 SSH 私钥 |
| `DEPLOY_KNOWN_HOSTS` | 已核对的服务器 SSH Host Key |
| `NEXTTOKEN_API_KEY` | Agent 模型服务凭证 |
| `OPENROUTER_API_KEY` | OpenRouter 模型服务凭证 |
| `PROJECT_PROGRESS_GITHUB_TOKEN` | AI GitHub 账号的只读 fine-grained PAT |

Repository Variables:

| Variable | 用途 |
| --- | --- |
| `DEPLOY_PORT` | SSH 端口,默认 `22` |
| `DEPLOY_PLATFORM` | 默认 `linux/amd64`;ARM 使用 `linux/arm64` |

Environment Secrets:

| Environment | Secret | 用途 |
| --- | --- | --- |
| `test` | `OA_AGENT_SSO_SHARED_SECRET` | 测试 OA 与 OA Agent 共用的 SSO 签名密钥 |
| `production` | `OA_AGENT_SSO_SHARED_SECRET` | 生产 OA 与 OA Agent 共用的 SSO 签名密钥 |
| `test` | `OA_AGENT_AUTOMATION_TOKEN` | 测试 OA 调用 OAagent 自动化模型接口的专用凭证 |
| `production` | `OA_AGENT_AUTOMATION_TOKEN` | 生产 OA 调用 OAagent 自动化模型接口的专用凭证 |
| `test` / `production` | `OA_PROJECT_SYNC_TOKEN` | 对应原 OA 的项目同步最小权限服务凭证 |
| `test` / `production` | `DATABASE_URL` | 对应环境的 Node 自动任务 MySQL Secret |
| `test` / `production` | `OA_SESSION_SECRET` | 与对应原 OA 一致的 sessionid 签名 Secret |

以上五类 Secret 应在 `test` 和 `production` 分别配置，不能用同一个 Repository Secret 同时覆盖两个环境。模型 Key、部署 SSH 凭证和只读 GitHub PAT 可以在两个环境确实共用时保留为 Repository Secret。

Environment Variables:

| Environment | Variable | 用途 |
| --- | --- | --- |
| `test` | `OA_DOCKER_API_BASE_URL` | 测试 OA API 地址 |
| `production` | `OA_DOCKER_API_BASE_URL` | 生产 OA API 地址 |
| 两者 | `OA_KNOWLEDGE_BASE_API_KEY` | 服务端组装知识库 `Authorization: Bearer` header 的固定 Token，配置为 Environment Secret |
| 两者可选 | `OA_KNOWLEDGE_API_BASE_URL` | 知识库 Agent API 地址，默认使用生产地址 |
| 两者 | `AUTOMATION_API_BASE_URL` | Compose 内固定为 `http://agent:3000`，无需配置 |
| 两者可选 | `PROJECT_SYNC_API_BASE_URL` | 原 OA 项目同步服务地址；未配置时继承 `OA_DOCKER_API_BASE_URL` |
| `test` | `OA_AGENT_SSO_TTL_SECONDS` | 测试环境 SSO 凭证有效期(秒),必须是正整数 |
| `production` | `OA_AGENT_SSO_TTL_SECONDS` | 生产环境 SSO 凭证有效期(秒),必须是正整数 |
| `test` | `AGENT_BIND_ADDRESS` | 填服务器 `docker0` 地址 `192.168.251.1`,供同机 OA 后端容器访问 Agent |
| `production` 可选 | `AGENT_BIND_ADDRESS` | 默认 `127.0.0.1`;仅在生产 OA 后端也需跨容器访问时填写其可达的宿主机地址 |
| 两者可选 | `OA_AUTH_ALIAS` | OA 数据源 alias,默认 `default` |
| 两者可选 | `NEXTTOKEN_API_BASE_URL` | Nexttoken API 地址,默认 `https://next-token.cc` |
| 两者可选 | `OPENROUTER_API_BASE_URL` | OpenRouter API 地址,默认 `https://openrouter.ai/api/v1` |
| 两者可选 | `PROJECT_PROGRESS_WORKER_INSTANCE` | Worker 稳定实例名；默认按环境生成 |
| 两者可选 | `PROJECT_PROGRESS_LEASE_SECONDS` | claim 租约秒数，默认 `300` |
| 两者可选 | `PROJECT_PROGRESS_HEARTBEAT_SECONDS` | heartbeat 间隔秒数，默认 `10` 且必须小于租约 |
| 两者可选 | `PROJECT_PROGRESS_GITHUB_CONCURRENCY` | GitHub HTTP 全局并发，默认 `6` |
| 两者可选 | `PROJECT_PROGRESS_AGENT_CONCURRENCY` | 同时运行的仓库 Codex Thread 数，默认 `2` |
| 两者可选 | `PROJECT_PROGRESS_OA_WRITE_CONCURRENCY` | OA mutation 并发，当前固定为 `1` |
| 两者可选 | `AUTOMATION_MIGRATE_ON_START` | 默认 `true`；启动 Agent 前执行幂等 baseline/seed |
| 两者可选 | `AUTOMATION_MAINTENANCE_ENABLED` | 默认 `true`；仅在需要暂停自动调度时显式设为 `false` |
| 两者可选 | `AUTOMATION_MAINTENANCE_INTERVAL_SECONDS` | 默认 `30` |
| 两者可选 | `OA_SESSION_VERIFY_MAX_AGE` | 默认 `0`，只验签不限制年龄 |

Workflow 使用 `${{ github.token }}` 将镜像推送到 GHCR 作为版本备份,同时通过私有 Artifact 和 SSH 把镜像加载到服务器。服务器不登录 GHCR,不需要配置 `GHCR_PULL_TOKEN`。

当前单 `agent` 实例使用进程内手动触发限流，不读取 `REDIS_URL`。在代码接入共享 Redis 前不要新增一个看似生效但实际未使用的 Redis Secret。

Workflow 会额外校验 `DATABASE_URL` 的库名：`test` 只能连接 `oagent_test`，`production` 只能连接 `oagent`。库名填反时部署会在上传服务器配置前失败。

## 固定环境参数

| 环境 | 部署目录 | Compose 项目 | Agent 监听 | Web 监听 | 公网域名 |
| --- | --- | --- | --- | --- | --- |
| 测试 | `/opt/rwkv/apps/oa-agent-test` | `oa-agent-test` | `192.168.251.1:3003` | `127.0.0.1:3001` | `test.oa-agent.rwkvos.com` |
| 生产 | `/opt/rwkv/apps/oa-agent-prod` | `oa-agent-prod` | `127.0.0.1:3011` | `127.0.0.1:3010` | `oa-agent.rwkvos.com` |

测试服务器的 `3002` 端口由 Alphachain/OA Node 服务使用，不得分配给 OA Agent 容器。

`AGENT_BIND_ADDRESS` 只控制 Docker 发布到宿主机的监听地址。测试环境使用 `192.168.251.1` 后,OA 后端容器可通过 `http://192.168.251.1:3003` 访问 Agent；不要把该服务器专属地址硬编码到 `compose.yml`。

Workflow 会把运行配置安全写入服务器 `.env.next`;部署脚本在发布时将其提升为 `.env`。失败时会同时恢复 `.env.previous` 和 `.deploy.env.previous`。

发布通过健康检查后，部署脚本会清理服务器上本项目不再使用的旧 commit SHA 镜像。清理范围只包含本次 Agent/Web 镜像所属仓库的 40 位 SHA 标签，并会跨测试、生产部署目录保留各环境的当前版和上一版，以确保手动回滚仍可用；其他项目镜像、非 SHA 标签和数据卷不会被清理。仍被容器占用或因 Docker 异常无法删除的镜像只会产生告警，不会让已经健康的发布失败。

## 手动回滚

进入测试或生产目录后执行:

```bash
cp .env.previous .env
cp .deploy.env.previous .deploy.env
chmod 600 .env .deploy.env
docker compose --env-file .env --env-file .deploy.env -f compose.yml \
  up -d --no-build --remove-orphans --wait --wait-timeout 180
```

首次部署没有 previous 文件。不要执行 `docker compose down -v`,否则会删除 session 和 Codex thread 数据卷。
