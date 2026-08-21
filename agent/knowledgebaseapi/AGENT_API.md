# 元始知识库 Agent API 接入文档（v1）

本文档面向需要从 OA Agent、后端服务或自动化任务中读取元始知识库的调用方。

> 当前版本仅提供只读能力：搜索、浏览目录、读取页面。接口使用固定服务 Token 认证调用方，并按每次请求携带的 OA user id 执行知识库现有权限；用户无需亲自登录过知识库，但必须存在于知识库同步的 OA 活跃用户目录中。
>
> **上线状态：待生产部署。** 当前生产地址尚未开放这些路由，请等待接口提供方确认上线后再开始联调。上线后，无 Token 请求应返回 JSON 格式的 `401 missing_token`；如果仍返回 HTML `404`，表示路由尚未部署。

## 1. 接口信息

| 项目 | 值 |
| --- | --- |
| 生产基础地址 | `https://oa-kb.rwkvos.com/api/agent/v1` |
| 协议 | HTTPS |
| 数据格式 | JSON（UTF-8） |
| 调用方鉴权 | 固定 Agent API Bearer Token |
| 权限用户 | 每次请求的 `X-OA-User-Id` |
| OpenAPI 3.1 | [`AGENT_API_OPENAPI.yaml`](./AGENT_API_OPENAPI.yaml) |

所有响应均包含 `X-Request-Id` 响应头和同值的 `requestId` JSON 字段。排障时请提供该值。

## 2. 快速开始

### 2.1 搜索

~~~bash
curl --get "https://oa-kb.rwkvos.com/api/agent/v1/search" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer <AGENT_API_TOKEN>" \
  --header "X-OA-User-Id: 19" \
  --header "X-OA-Agent-Id: knowledge-agent" \
  --header "X-OA-Run-Id: run-123" \
  --data-urlencode "q=部署" \
  --data-urlencode "limit=20"
~~~

### 2.2 读取页面

~~~bash
curl "https://oa-kb.rwkvos.com/api/agent/v1/pages/PAGE_ID?format=markdown" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer <AGENT_API_TOKEN>" \
  --header "X-OA-User-Id: 19"
~~~

### 2.3 Node.js / TypeScript

~~~ts
const baseUrl = "https://oa-kb.rwkvos.com/api/agent/v1"

async function searchKnowledgeBase(token: string, oaUserId: string, query: string) {
  const url = new URL(baseUrl + "/search")
  url.searchParams.set("q", query)
  url.searchParams.set("limit", "20")

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "X-OA-User-Id": oaUserId,
      "X-OA-Agent-Id": "knowledge-agent",
      "X-OA-Run-Id": crypto.randomUUID(),
    },
  })
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(
      response.status + " " + payload.error?.code + ": "
        + payload.error?.message + " (" + payload.requestId + ")",
    )
  }
  return payload
}
~~~

## 3. 鉴权与权限

每个请求都必须携带双方预先配置的固定 Agent API Token：

~~~http
Authorization: Bearer <固定 Agent API Token>
X-OA-User-Id: <当前终端用户的稳定 OA ID>
~~~

知识库按以下流程处理身份和权限：

1. 将 Bearer Token 与服务端 `KB_AGENT_API_TOKEN` 做安全比较，验证调用方身份。
2. 读取必填的 `X-OA-User-Id`，并在知识库同步的 OA 活跃用户目录中校验；不存在、未同步或已停用时返回 `403`。
3. 目录中的知识库管理员保留管理员角色，其他活跃 OA 用户按普通成员授权；用户不需要亲自登录过知识库。
4. 根据 OA user id、页面空间、权限继承和页面 ACL 计算实时权限。搜索和列表自动过滤无权内容；读取不存在或无权访问的资源统一返回 `404`。

调用方必须遵守以下要求：

- 固定 Token 只能放在 `Authorization` 请求头中，不要写入 URL、日志、错误或链路追踪。
- 每次请求必须根据当前已登录终端用户填写真实的稳定 OA user id，不能缓存、硬编码或沿用上一位用户的值。
- 管理员必须先执行 OA 用户目录同步，并在 OA 成员变化后及时重同步；知识库不会在每次 Agent 请求中使用用户登录 Token 回查 OA。
- 固定 Token 的持有方可声明任意 OA user id，因此只能保存在受信任的 OA 后端，不得下发到浏览器或客户端。
- Token 与用户 ID 共同决定访问上下文：Token 验证调用方，`X-OA-User-Id` 决定权限用户。
- `private` 表示当前用户自己的私人空间。
- `public` 页面仍可能配置自定义 ACL，不代表所有用户都能访问。
- 响应中的 `permission` 是当前用户的有效权限：`viewer`、`editor` 或 `manager`。

### 请求头

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | 格式必须为 `Bearer <AGENT_API_TOKEN>`，值固定且与知识库配置一致 |
| `X-OA-User-Id` | 是 | 当前终端用户的稳定 OA ID，最长 120 个字符，且必须在已同步的 OA 活跃用户目录中 |
| `Accept` | 否 | 推荐 `application/json` |
| `X-OA-Agent-Id` | 否 | Agent 或调用方标识，仅用于审计，最长 120 个字符 |
| `X-OA-Run-Id` | 否 | 单次任务、对话或执行标识，仅用于审计，最长 160 个字符 |
| `X-Request-Id` | 否 | 调用方链路 ID；仅接受 1–64 位字母、数字、`.`、`_`、`:`、`-`，不符合格式时服务端会生成新值 |

`X-OA-Agent-Id` 和 `X-OA-Run-Id` 不参与用户识别或权限判断。

## 4. 通用约定

### 4.1 成功响应

列表类接口：

~~~json
{
  "data": [],
  "nextCursor": null,
  "requestId": "9dc9f73e-9408-4185-9d42-584ffec09f34"
}
~~~

详情接口：

~~~json
{
  "data": {},
  "requestId": "9dc9f73e-9408-4185-9d42-584ffec09f34"
}
~~~

### 4.2 错误响应

~~~json
{
  "error": {
    "code": "invalid_token",
    "message": "Agent API Token 不正确"
  },
  "requestId": "9dc9f73e-9408-4185-9d42-584ffec09f34"
}
~~~

调用方应以 HTTP 状态码和 `error.code` 判断错误类型，不要依赖可能调整的中文 `message`。

### 4.3 分页

`/search`、`/pages` 和 `/pages/{id}/children` 使用游标分页：

- `limit` 默认为 `20`，范围为 `1`–`50`。
- 首次请求不传 `cursor`。
- `nextCursor` 不为 `null` 时，将它原样放入下一次请求的 `cursor`。
- `nextCursor` 为 `null` 表示没有下一页。
- 游标是不透明字符串，不应解析、拼接或自行生成。

~~~http
GET /api/agent/v1/search?q=部署&limit=20
GET /api/agent/v1/search?q=部署&limit=20&cursor=djE6MjA
~~~

### 4.4 限流

默认按用户限制为每分钟 `120` 次，实际值以响应头为准：

| 响应头 | 说明 |
| --- | --- |
| `RateLimit-Limit` | 当前窗口请求上限 |
| `RateLimit-Remaining` | 当前窗口剩余请求数 |
| `RateLimit-Reset` | 窗口重置时间，Unix 秒级时间戳 |
| `Retry-After` | `429` 时建议等待的秒数 |

收到 `429` 后，应至少等待 `Retry-After` 指定的时间再重试。

## 5. 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/search` | 搜索当前用户可见的页面和目录 |
| `GET` | `/pages` | 浏览公共或私人空间根节点，也可浏览指定目录 |
| `GET` | `/pages/{id}` | 读取单个页面或目录的内容与元数据 |
| `GET` | `/pages/{id}/children` | 浏览指定目录的直接子节点 |

## 6. 搜索知识库

~~~http
GET /search
~~~

### 查询参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `q` | string | 是 | — | 搜索词；规范化后最长 100 个字符。缺失或仅含空格时返回空列表 |
| `limit` | integer | 否 | `20` | 每页数量，范围 `1`–`50` |
| `cursor` | string | 否 | — | 上一页返回的 `nextCursor` |

排序优先级为：标题完全匹配、标题包含、正文匹配；同一优先级内优先返回最近更新的内容。

### 响应示例

~~~json
{
  "data": [
    {
      "id": "01JKBEXAMPLEPAGE00000000001",
      "title": "生产部署手册",
      "icon": null,
      "space": "public",
      "path": ["工程中心", "运维"],
      "excerpt": "发布前请确认数据库迁移、镜像版本和部署窗口。",
      "titleMatch": {
        "start": 2,
        "end": 4
      },
      "excerptMatch": {
        "start": 17,
        "end": 19
      },
      "parentId": "01JKBEXAMPLEFOLDER000000001",
      "kind": "page",
      "permission": "viewer",
      "revision": 12,
      "updatedAt": "2026-08-20T03:12:45.000Z",
      "updatedBy": "19",
      "updatedByOaUserId": "19",
      "sourceUrl": "https://oa-kb.rwkvos.com/wiki/01JKBEXAMPLEPAGE00000000001"
    }
  ],
  "nextCursor": null,
  "requestId": "d3f789cf-74f2-4c53-aed6-ae402063e122"
}
~~~

`titleMatch` 和 `excerptMatch` 使用左闭右开区间 `[start, end)`，分别对应返回的 `title` 和 `excerpt`；没有匹配位置时为 `null`。`path` 是从顶层目录到直接父目录的标题数组，不包含当前结果自身。

## 7. 浏览根节点或指定目录

~~~http
GET /pages
~~~

### 查询参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `space` | string | 否 | `public` | 根节点空间，只能为 `public` 或 `private` |
| `parentId` | string | 否 | — | 指定后返回该目录的直接子节点 |
| `limit` | integer | 否 | `20` | 每页数量，范围 `1`–`50` |
| `cursor` | string | 否 | — | 上一页返回的 `nextCursor` |

未传 `parentId` 时返回指定空间的根节点。传入 `parentId` 后，空间由父目录决定，`space` 参数会被忽略。父节点不存在、不可见或不是目录时返回 `404 not_found`。

### 响应示例

~~~json
{
  "data": [
    {
      "id": "01JKBEXAMPLEFOLDER000000001",
      "title": "工程中心",
      "parentId": null,
      "kind": "folder",
      "space": "public",
      "permission": "editor",
      "revision": 3,
      "updatedAt": "2026-08-19T09:30:00.000Z",
      "updatedBy": "27",
      "updatedByOaUserId": "27",
      "sourceUrl": "https://oa-kb.rwkvos.com/wiki/01JKBEXAMPLEFOLDER000000001"
    }
  ],
  "nextCursor": "djE6MjA",
  "requestId": "bdaff737-9300-44a9-af78-2f7ef2deac12"
}
~~~

## 8. 读取页面内容

~~~http
GET /pages/{id}
~~~

### 参数

| 参数 | 位置 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | 是 | — | 页面或目录 ID；放入 URL 前应进行 URL 编码 |
| `format` | query | string | 否 | `markdown` | `markdown`、`text` 或 `tiptap-json` |

| `format` | `content` 类型 | 适用场景 |
| --- | --- | --- |
| `markdown` | string | Agent 上下文、RAG、通用文本消费；推荐默认使用 |
| `text` | string | 纯文本检索、摘要或不需要格式的场景 |
| `tiptap-json` | object | 需要保留编辑器节点与 marks 的高级场景 |

### 响应示例

~~~json
{
  "data": {
    "id": "01JKBEXAMPLEPAGE00000000001",
    "title": "生产部署手册",
    "parentId": "01JKBEXAMPLEFOLDER000000001",
    "kind": "page",
    "space": "public",
    "permission": "viewer",
    "revision": 12,
    "format": "markdown",
    "content": "# 生产部署手册\n\n发布前请完成以下检查：\n\n- 数据库迁移\n- 镜像版本\n- 健康检查",
    "createdAt": "2026-07-01T08:00:00.000Z",
    "updatedAt": "2026-08-20T03:12:45.000Z",
    "updatedBy": "林锦豪",
    "updatedByOaUserId": "19",
    "sourceUrl": "https://oa-kb.rwkvos.com/wiki/01JKBEXAMPLEPAGE00000000001"
  },
  "requestId": "2734bd33-3807-4c7c-9cc7-803b3034d060"
}
~~~

资源不存在或当前用户无权访问时均返回 `404 not_found`，调用方不能据此判断资源是否真实存在。

## 9. 浏览目录子节点

~~~http
GET /pages/{id}/children
~~~

| 参数 | 位置 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | 是 | — | 父目录 ID |
| `limit` | query | integer | 否 | `20` | 每页数量，范围 `1`–`50` |
| `cursor` | query | string | 否 | — | 上一页返回的 `nextCursor` |

响应结构与 `GET /pages` 相同。父节点不存在、不可见或不是目录时返回 `404 not_found`。

~~~bash
curl "https://oa-kb.rwkvos.com/api/agent/v1/pages/FOLDER_ID/children?limit=20" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer <AGENT_API_TOKEN>" \
  --header "X-OA-User-Id: 19"
~~~

## 10. 字段说明

### PageSummary

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 页面或目录唯一 ID |
| `title` | string | 标题 |
| `parentId` | string \| null | 直接父目录 ID；根节点为 `null` |
| `kind` | `page` \| `folder` | 节点类型 |
| `space` | `public` \| `private` | 所属空间 |
| `permission` | `viewer` \| `editor` \| `manager` | 当前用户的有效权限 |
| `revision` | integer | 当前内容修订号 |
| `updatedAt` | string | 最后更新时间，ISO 8601 |
| `updatedBy` | string | 最后更新者的显示姓名或历史标识，保留用于展示和兼容 |
| `updatedByOaUserId` | string \| null | 最后更新者的稳定 OA user id；系统更新或历史姓名无法唯一匹配时为 `null` |
| `sourceUrl` | string | 可在浏览器中打开的知识库页面地址 |

### SearchResult 附加字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `icon` | string \| null | 页面图标 |
| `path` | string[] | 从顶层目录到直接父目录的标题路径 |
| `excerpt` | string | 最多约 120 个字符的正文摘要 |
| `titleMatch` | MatchRange \| null | 标题命中范围 `[start, end)` |
| `excerptMatch` | MatchRange \| null | 摘要命中范围 `[start, end)` |

## 11. 错误码与重试

| HTTP | `error.code` | 含义 | 调用方建议 |
| --- | --- | --- | --- |
| `400` | `invalid_request_context` | Agent ID 或 Run ID 不合法 | 修正请求头，不要原样重试 |
| `400` | `missing_oa_user_id` | 缺少 `X-OA-User-Id` | 补充当前终端用户的 OA user id |
| `400` | `invalid_oa_user_id` | `X-OA-User-Id` 格式不合法 | 修正 OA user id，不要原样重试 |
| `400` | `invalid_query` | 搜索词超过 100 个字符 | 缩短搜索词 |
| `400` | `invalid_pagination` | `limit` 或 `cursor` 不合法 | 重新使用服务端返回的游标 |
| `400` | `invalid_space` | `space` 不合法 | 使用 `public` 或 `private` |
| `400` | `invalid_format` | `format` 不受支持 | 使用支持的三种格式之一 |
| `401` | `missing_token` | 缺少 Bearer Token | 补充固定 Agent API Token |
| `401` | `invalid_token` | Token 格式错误或与固定 Token 不一致 | 检查双方配置，必要时轮换固定 Token |
| `403` | `oa_user_not_active` | OA user id 不存在、未同步或已停用 | 同步 OA 活跃用户目录，并确认调用方传入正确 ID |
| `404` | `not_found` | 资源不存在、不是目录或不可见 | 重新搜索或刷新目录，不要反复重试 |
| `429` | `rate_limited` | 超过请求频率限制 | 按 `Retry-After` 延迟重试 |
| `500` | `internal_error` | 知识库内部临时错误 | 指数退避重试，并记录 `requestId` |
| `503` | `agent_api_not_configured` | 知识库未正确配置固定 Token | 联系知识库运维配置 `KB_AGENT_API_TOKEN` |

建议只对 `429` 和 `500` 自动重试。`500` 可采用带随机抖动的指数退避，例如等待 1 秒、2 秒、4 秒，最多重试 3 次。

## 12. 对接验收清单

- [ ] OA 后端与知识库配置相同的固定高熵 Token，且与其他系统密钥分开。
- [ ] 固定 Token 仅放在 `Authorization` 请求头，未下发到浏览器，日志和错误中已脱敏。
- [ ] 每次请求都传递当前终端用户真实的 `X-OA-User-Id`，切换用户时不会复用旧值。
- [ ] 已同步完整的 OA 活跃用户目录；未登录过知识库的有效用户可以访问，乱写或停用的 ID 返回 `403`。
- [ ] 消费方使用 `updatedByOaUserId` 识别更新者，并允许该字段在系统更新或无法唯一匹配的历史数据上为 `null`。
- [ ] 分页时原样传递 `nextCursor`。
- [ ] 页面读取默认使用 `format=markdown`，确有结构化需求时才使用 `tiptap-json`。
- [ ] 对 `404` 不区分“资源不存在”和“无权访问”。
- [ ] 保存或透传 `X-Request-Id`，便于双方排查请求。
- [ ] 已使用不同权限用户验证返回内容符合知识库 ACL。
