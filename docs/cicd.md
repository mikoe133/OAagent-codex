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
2. 构建一次 Agent/Web 镜像并以 commit SHA 推送 GHCR。
3. 自动部署到 `test` Environment。

合并到 `main`:

1. 完成全部质量检查。
2. 构建一次 Agent/Web 镜像并以 commit SHA 推送 GHCR。
3. 如果 production 配置了 Required reviewer,等待人工批准。
4. 自动部署到 `production` Environment。

两个环境独立发布。推荐先把功能分支合并到 `test`,验证通过后再把 `test` 合并到 `main`。

## GitHub 配置

Repository Secrets:

| Secret | 用途 |
| --- | --- |
| `DEPLOY_SSH_KEY` | GitHub Actions 登录服务器的 SSH 私钥 |
| `DEPLOY_KNOWN_HOSTS` | 已核对的服务器 SSH Host Key |
| `OPENROUTER_API_KEY` | Agent 模型服务凭证 |

Repository Variables:

| Variable | 用途 |
| --- | --- |
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | 可以直接运行 Docker 的 SSH 用户 |
| `DEPLOY_PORT` | SSH 端口,默认 `22` |
| `DEPLOY_PLATFORM` | 默认 `linux/amd64`;ARM 使用 `linux/arm64` |

Environment Variables:

| Environment | Variable | 用途 |
| --- | --- | --- |
| `test` | `OA_DOCKER_API_BASE_URL` | 测试 OA API 地址 |
| `production` | `OA_DOCKER_API_BASE_URL` | 生产 OA API 地址 |
| 两者可选 | `OA_AUTH_ALIAS` | OA 数据源 alias,默认 `default` |

Workflow 使用 `${{ github.token }}` 登录 GHCR,不需要配置 `GHCR_PULL_TOKEN`。

## 固定环境参数

| 环境 | 部署目录 | Compose 项目 | Web 监听 |
| --- | --- | --- | --- |
| 测试 | `/opt/rwkv/apps/oa-agent-test` | `oa-agent-test` | `127.0.0.1:3001` |
| 生产 | `/opt/rwkv/apps/oa-agent-prod` | `oa-agent-prod` | `127.0.0.1:3000` |

Workflow 会把运行配置安全写入服务器 `.env.next`;部署脚本在发布时将其提升为 `.env`。失败时会同时恢复 `.env.previous` 和 `.deploy.env.previous`。

## 手动回滚

进入测试或生产目录后执行:

```bash
cp .env.previous .env
cp .deploy.env.previous .deploy.env
chmod 600 .env .deploy.env
docker compose --env-file .env --env-file .deploy.env -f compose.yml pull agent web
docker compose --env-file .env --env-file .deploy.env -f compose.yml \
  up -d --no-build --remove-orphans --wait --wait-timeout 180
```

首次部署没有 previous 文件。不要执行 `docker compose down -v`,否则会删除 session 和 Codex thread 数据卷。
