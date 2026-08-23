# OA Agent 双环境部署:简单操作步骤

目标是在同一台服务器运行六个容器:

| 环境 | 容器 | 服务器目录 | Web 端口 | 公网域名 |
| --- | --- | --- | --- | --- |
| 测试 | `web` + `agent` + `project-progress-worker` | `/opt/rwkv/apps/oa-agent-test` | `127.0.0.1:3001` | `test.oa-agent.rwkvos.com` |
| 生产 | `web` + `agent` + `project-progress-worker` | `/opt/rwkv/apps/oa-agent-prod` | `127.0.0.1:3010` | `oa-agent.rwkvos.com` |

代码已经自动完成:

- 合并到 `test` 后测试、构建镜像并部署测试环境。
- 合并到 `main` 后测试、构建镜像并部署生产环境。
- 生产环境可通过 GitHub Required reviewer 人工确认。
- 两个环境独立使用各自分支的 commit SHA 镜像。
- 自动生成并上传两套服务器 `.env`。
- 自动隔离两套容器、网络、session 卷和 Codex 卷。
- 新版本失败时自动恢复上一版镜像和上一份 `.env`。
- 镜像以 commit SHA 备份到 GHCR,并通过私有 Artifact 和 SSH 加载到服务器,不需要 `GHCR_PULL_TOKEN`。

你只需要完成下面 6 步。

## 第 1 步:准备服务器

服务器必须安装 Docker Engine 和 Docker Compose v2.20+。检查:

```bash
docker --version
docker compose version
docker ps
```

SSH 部署用户必须能够不加 `sudo` 运行 Docker。如果不能:

```bash
sudo usermod -aG docker "$USER"
```

退出 SSH 后重新登录,然后创建两个目录。把 `<部署用户>` 换成实际 SSH 用户:

```bash
sudo install -d -m 0750 -o <部署用户> -g <部署用户> /opt/rwkv/apps/oa-agent-test
sudo install -d -m 0750 -o <部署用户> -g <部署用户> /opt/rwkv/apps/oa-agent-prod
```

不需要在服务器克隆仓库,也不需要手动创建 `.env`。

## 第 2 步:创建部署 SSH 密钥

在本地电脑执行:

```bash
ssh-keygen -t ed25519 -C "github-actions-oa-agent" -f ~/.ssh/oa_agent_deploy
ssh-copy-id -i ~/.ssh/oa_agent_deploy.pub -p 22 <部署用户>@<服务器IP或域名>
```

验证:

```bash
ssh -i ~/.ssh/oa_agent_deploy -p 22 <部署用户>@<服务器IP或域名> 'docker ps'
```

获取服务器 Host Key:

```bash
ssh-keyscan -p 22 -H <服务器IP或域名>
```

应通过云服务器控制台核对 Host Key 指纹,不要关闭 SSH Host Key 校验。

## 第 3 步:配置 GitHub Repository Secrets

打开:

```text
GitHub 仓库 -> Settings -> Secrets and variables -> Actions -> Secrets
```

添加以下 Repository Secret:

| Secret | 填写内容 | 获取方式 |
| --- | --- | --- |
| `DEPLOY_HOST` | 服务器 IP 或域名 | 云服务器控制台或 SSH 配置 |
| `DEPLOY_USER` | 可以直接运行 Docker 的 SSH 用户 | 登录服务器执行 `whoami` |
| `DEPLOY_SSH_KEY` | `~/.ssh/oa_agent_deploy` 私钥完整内容 | 第 2 步生成 |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan` 完整输出 | 第 2 步生成并核对 |
| `NEXTTOKEN_API_KEY` | Nexttoken Key | Nexttoken 控制台创建 |
| `OPENROUTER_API_KEY` | OpenRouter Key | OpenRouter 控制台创建 |
| `PROJECT_PROGRESS_GITHUB_TOKEN` | GitHub fine-grained PAT | AI GitHub 账号创建，只授予 Metadata/Contents Read |

不需要配置:

- `AGENT_API_TOKEN`
- `OA_API_TOKEN`
- `GHCR_PULL_TOKEN`
- 用户 OA token

用户 OA token 会在用户登录后自动取得,并由 Web 和 Agent 共用、验证。

## 第 4 步:配置 GitHub Repository Variables

打开:

```text
GitHub 仓库 -> Settings -> Secrets and variables -> Actions -> Variables
```

添加:

| Variable | 示例 | 怎么获得 |
| --- | --- | --- |
| `DEPLOY_PORT` | `22` | SSH 端口,默认 22 |
| `DEPLOY_PLATFORM` | `linux/amd64` | 服务器执行 `uname -m`;`x86_64` 用 `linux/amd64`,`aarch64` 用 `linux/arm64` |

目录、Compose 项目名和 Web 端口已经写入 Workflow,不需要配置。

## 第 5 步:创建 test 和 production Environments

打开:

```text
GitHub 仓库 -> Settings -> Environments
```

创建两个 Environment:

- `test`
- `production`

分别添加 Environment Variable:

| Environment | Variable | 值 |
| --- | --- | --- |
| `test` | `OA_DOCKER_API_BASE_URL` | 测试 OA API 地址 |
| `production` | `OA_DOCKER_API_BASE_URL` | 生产 OA API 地址 |
| `test` / `production` | `OA_KNOWLEDGE_BASE_API_KEY` | 各环境独立、仅用于服务端组装知识库 `Authorization: Bearer` header 的固定 Token（Secret） |
| `test` / `production` | `OA_KNOWLEDGE_API_BASE_URL` | 知识库 Agent API 地址；未填时使用默认生产地址 |
| `test` / `production` | `AUTOMATION_API_BASE_URL` | 无需配置；Compose 固定使用 `http://agent:3000` |
| `test` / `production` | `PROJECT_SYNC_API_BASE_URL` | 原 OA 项目同步服务地址；未填时继承 `OA_DOCKER_API_BASE_URL` |
| `test` | `OA_AGENT_SSO_TTL_SECONDS` | 测试环境 SSO 凭证有效期(秒),例如 `300` |
| `production` | `OA_AGENT_SSO_TTL_SECONDS` | 生产环境 SSO 凭证有效期(秒),例如 `300` |
| `test` | `AGENT_BIND_ADDRESS` | `192.168.251.1` |
| `production` | `AGENT_BIND_ADDRESS` | 可选；默认 `127.0.0.1` |
| `test` / `production` | `OA_PROJECT_SYNC_TOKEN_HEADER` | 通常为 `Authorization`；session 测试可填 `Cookie` |
| `test` / `production` | `OA_PROJECT_SYNC_TOKEN_PREFIX` | 通常为 `Bearer`；session 测试可填 `sessionid=` |
| `test` / `production` | `PROJECT_PROGRESS_HEARTBEAT_SECONDS` | 填 `10`，使取消请求及时传给 Worker |
| `test` / `production` | `AUTOMATION_MIGRATE_ON_START` | 首次部署保持 `true` |
| `test` / `production` | `AUTOMATION_MAINTENANCE_ENABLED` | 可选；默认 `true`，仅在需要暂停自动调度时显式设为 `false` |

再分别为两个 Environment 添加以下 Secret：

| Environment | Secret | 用途 |
| --- | --- | --- |
| `test` / `production` | `OA_AGENT_SSO_SHARED_SECRET` | OA 与 OAagent 的用户 SSO 签名；两端一致 |
| `test` / `production` | `OA_AGENT_AUTOMATION_TOKEN` | Node 与 Worker 自动任务内部接口共用的专用凭证 |
| `test` / `production` | `OA_PROJECT_SYNC_TOKEN` | Worker 调用对应原 OA 项目同步接口的专用凭证 |
| `test` / `production` | `DATABASE_URL` | 各自独立的 Node 自动任务 MySQL 连接串 |
| `test` / `production` | `OA_SESSION_SECRET` | 与对应原 OA 的 sessionid 签名密钥一致 |

两个环境必须使用不同的数据库、自动化 token、项目同步 token和 OA session 签名密钥。`OA_AGENT_AUTOMATION_TOKEN` 不得复用 SSO 密钥、用户 session、GitHub token 或模型 Key；完整 `DATABASE_URL` 只保存为 Environment Secret。

CI 会阻止环境串库：`test` 的 URL 路径必须是 `/oagent_test`，`production` 必须是 `/oagent`。

`192.168.251.1` 是当前服务器的 `docker0` 地址。测试 OA 后端容器无需加入 OAagent 的 Compose 网络,即可通过 `http://192.168.251.1:3003` 访问 Agent。换服务器后先执行 `ip -4 addr show docker0` 确认地址；生产环境仅在 OA 后端也需要跨容器访问 Agent 时配置对应地址。

如果 OA 和本项目在同一台服务器,并发布宿主机 `8010` 端口,填写:

```text
http://host.docker.internal:8010
```

如果 OA 在其他服务器,填写实际 HTTPS API 地址。不要填写容器内的 `127.0.0.1`。

如果 OA 使用的 alias 不是默认的 `default`,再在对应 Environment 添加:

```text
OA_AUTH_ALIAS=<实际 alias>
```

在 `production` Environment 中启用 `Required reviewers`,这样 `main` 分支构建成功后,GitHub 会等待你批准再部署生产。

## 第 6 步:配置 HTTPS 并发布

生产模式的登录 Cookie 带 `Secure` 属性,所以测试和生产都必须通过 HTTPS 访问。

准备两个域名并指向同一台服务器:

```text
test.oa-agent.rwkvos.com -> 47.115.88.183
oa-agent.rwkvos.com      -> 47.115.88.183
```

Nginx 分别反向代理:

```nginx
# 测试域名
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}

# 生产域名
location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

配置证书后,按下面的分支流程合并代码。不需要本地打包或上传构建产物。

自动流程:

```text
功能分支 -> 合并到 test -> 自动部署测试环境
测试验证通过 -> test 合并到 main -> 等待生产审批 -> 自动部署生产环境
```

## 发布后检查

测试环境:

```bash
cd /opt/rwkv/apps/oa-agent-test
docker compose --env-file .env --env-file .deploy.env -f compose.yml ps
```

生产环境:

```bash
cd /opt/rwkv/apps/oa-agent-prod
docker compose --env-file .env --env-file .deploy.env -f compose.yml ps
```

最后分别用浏览器验证:

1. HTTPS 页面可以打开。
2. 可以使用对应 OA 账号登录。
3. 可以进入 `/chat`。
4. 可以发送 Agent 消息并读取 OA 数据。
5. 测试和生产的会话互不混用。

Compose 已让 `agent` 容器承担 Codex 命令的外部隔离,发布后不应额外给该容器增加 `SYS_ADMIN`、关闭 seccomp/AppArmor 或启用 privileged 模式。

## 手动回滚

正常情况下失败会自动回滚。如果需要手动回滚,进入对应目录执行:

```bash
cp .env.previous .env
cp .deploy.env.previous .deploy.env
chmod 600 .env .deploy.env
docker compose --env-file .env --env-file .deploy.env -f compose.yml \
  up -d --no-build --remove-orphans --wait --wait-timeout 180
```

不要执行 `docker compose down -v`,它会删除 Agent session 和 Codex thread 数据卷。
