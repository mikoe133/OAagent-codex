# 元始知识库 Agent API 接入文档（v1）

本文档面向需要从 OA Agent、后端服务或自动化任务中读取、组织和安全编辑元始知识库的调用方。

> 当前版本提供搜索、目录浏览、页面读取、目录与元数据编辑、附件上传，以及必须经过草稿预览的 TipTap 正文写入。接口使用固定服务 Token 认证调用方，并按每次请求携带的 OA user id 执行知识库现有权限；用户无需亲自登录过知识库，但必须存在于知识库同步的 OA 活跃用户目录中。
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
| API Changelog | [`AGENT_API_CHANGELOG.md`](./AGENT_API_CHANGELOG.md) |
| 第三方接入指南 | [`AGENT_API_MCP_GUIDE.md`](./AGENT_API_MCP_GUIDE.md) |

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
| `Idempotency-Key` | 写接口必填 | 1–128 位可见 ASCII 字符；同一写请求重试时必须复用，服务端保留结果 24 小时 |

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

- `/search`、`/pages` 以及非递归的 `/pages/{id}/children`：`limit` 默认为 `20`，范围为 `1`–`50`。
- 递归的 `/pages/{id}/children`：`limit` 默认为 `200`，范围为 `1`–`500`。
- 首次请求不传 `cursor`。
- `nextCursor` 不为 `null` 时，将它原样放入下一次请求的 `cursor`。
- `nextCursor` 为 `null` 表示没有下一页。
- 游标是不透明字符串，不应解析、拼接或自行生成。

~~~http
GET /api/agent/v1/search?q=部署&limit=20
GET /api/agent/v1/search?q=部署&limit=20&cursor=djE6MjA
~~~

### 4.4 限流

只读请求默认按用户每分钟 `120` 次，JSON 写入默认 `30` 次，上传默认 `10` 次；实际值以响应头为准：

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
| `GET` | `/pages/{id}/children` | 浏览指定目录的直接子节点或批量列出子孙节点 |
| `GET` | `/capabilities` | 查询写开关、限制和 TipTap schema |
| `GET` | `/system-images` | 浏览允许作为封面的系统图库 |
| `POST` | `/pages` | 创建空页面或目录 |
| `PATCH` | `/pages/{id}` | 修改 title、emoji、封面或目录外观 |
| `PATCH` | `/pages/{id}/location` | 移动或重新排序页面/目录 |
| `POST` | `/pages/{id}/attachments` | 上传页面图片或普通附件 |
| `POST` | `/pages/{id}/content-drafts` | 创建 TipTap 正文草稿和预览链接 |
| `GET/PUT/DELETE` | `/content-drafts/{draftId}` | 读取、替换或废弃正文草稿 |
| `POST` | `/content-drafts/{draftId}/apply` | 用户确认后提交正文草稿 |
| `GET` | `/pages/{id}/revisions` | 列出正文历史版本 |
| `GET` | `/pages/{id}/revisions/{revision}` | 读取指定历史 TipTap 内容 |
| `GET` | `/pages/{id}/backlinks` | 查询反向引用 |

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

## 9. 浏览目录子节点或子孙节点

~~~http
GET /pages/{id}/children
~~~

| 参数 | 位置 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | 是 | — | 父目录 ID |
| `recursive` | query | boolean | 否 | `false` | 为 `true` 时批量返回子孙节点；为 `false` 时保持直接子节点行为 |
| `maxDepth` | query | integer | 否 | `20` | 递归的最大相对深度，范围 `1`–`20`；直接子节点深度为 `1` |
| `kind` | query | `page` \| `folder` | 否 | — | 只返回指定节点类型；筛选页面时仍会穿过目录继续遍历 |
| `limit` | query | integer | 否 | `20` / `200` | 非递归范围 `1`–`50`；递归范围 `1`–`500` |
| `cursor` | query | string | 否 | — | 上一页返回的 `nextCursor` |

返回节点按目录树的前序顺序排列，每个节点增加 `depth` 字段。响应还包含 `truncated`；其为 `true` 时表示本页因数量上限截断，应使用非空的 `nextCursor` 继续读取。权限过滤在遍历之前执行，因此接口不会越过当前用户不可见的目录。父节点不存在、不可见或不是目录时返回 `404 not_found`。

~~~bash
curl "https://oa-kb.rwkvos.com/api/agent/v1/pages/FOLDER_ID/children?limit=20" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer <AGENT_API_TOKEN>" \
  --header "X-OA-User-Id: 19"
~~~

一次批量获取最多 5 层内的所有页面：

~~~bash
curl "https://oa-kb.rwkvos.com/api/agent/v1/pages/FOLDER_ID/children?recursive=true&maxDepth=5&kind=page&limit=500" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer <AGENT_API_TOKEN>" \
  --header "X-OA-User-Id: 19"
~~~

~~~json
{
  "data": [
    {
      "id": "01JKBEXAMPLEPAGE00000000001",
      "title": "生产部署手册",
      "parentId": "01JKBEXAMPLEFOLDER000000001",
      "kind": "page",
      "depth": 2,
      "space": "public",
      "permission": "viewer",
      "revision": 12,
      "updatedAt": "2026-08-20T03:12:45.000Z",
      "updatedBy": "林锦豪",
      "updatedByOaUserId": "19",
      "sourceUrl": "https://oa-kb.rwkvos.com/wiki/01JKBEXAMPLEPAGE00000000001"
    }
  ],
  "nextCursor": null,
  "truncated": false,
  "requestId": "2734bd33-3807-4c7c-9cc7-803b3034d060"
}
~~~

## 10. 写入、附件与正文草稿

### 10.1 写入总则

- 生产环境只有 `KB_AGENT_WRITE_API_ENABLED=true` 时开放写接口；关闭时返回 `503 agent_write_api_disabled`，只读接口不受影响。
- 所有写请求必须携带 `Idempotency-Key`。相同 key 和相同请求会重放原结果；相同 key 对应不同请求返回 `409 idempotency_conflict`。
- 新页面只能创建为空页面。正文通过草稿写入；title、emoji 和封面既可以直接 PATCH，也可以随正文草稿一起预览和确认。
- 目录创建/改名/移动及单独的页面元数据 PATCH 直接生效；正文禁止通过页面 PATCH 直接覆盖。

### 10.2 创建页面或目录

~~~http
POST /pages
Idempotency-Key: create-page-run-123
Content-Type: application/json
~~~

~~~json
{
  "kind": "page",
  "space": "public",
  "parentId": "FOLDER_ID",
  "title": "Agent API 使用手册",
  "icon": "🤖",
  "coverImage": {
    "source": "system",
    "url": "/system-images/space/nasa-Q1p7bh3SHj8-unsplash.jpg"
  },
  "coverPositionY": 50
}
~~~

目录使用 `kind=folder`，不接受页面 emoji、封面或正文。创建子节点需要父目录 `editor`；移动源节点需要 `manager`，目标目录需要 `editor`。

### 10.3 页面元数据和位置

`PATCH /pages/{id}` 支持页面的 `title`、`icon`、`coverImage`、`coverPositionY`。`coverImage` 可为 `null`、系统图片 `{source:"system",url}`，或当前页面图片附件 `{source:"attachment",attachmentId}`。外部 URL 不受支持。

`PATCH /pages/{id}/location` 请求为 `{ "parentId": "FOLDER_ID", "index": 0 }`。`parentId=null` 表示移至空间根节点；服务端拒绝跨空间、跨私人所有者和将目录移动到自身后代。

### 10.4 上传附件

向 `POST /pages/{id}/attachments` 发送 multipart 表单：`file` 为文件，`kind` 为 `image` 或 `file`。图片支持 JPG、PNG、GIF、WebP 且不超过 10 MB；普通文件不超过 50 MB。响应同时返回附件 URL 和可直接放入正文的标准 TipTap 节点。

### 10.5 TipTap 草稿与预览

先调用 `GET /capabilities` 获取 `contentSchemaVersion`、节点、marks、自定义节点示例、正文大小限制和 `draftPageMetadata`。首版 schema 为 `1`，正文根节点必须为 `doc`；未知节点、未知属性、临时上传节点、外链资源、跨页面附件和不可见页面提及会被拒绝。

`/capabilities` 的正式字段名为 `nodes`、`marks`、`maxBytes`；`draftPageMetadata` 是包含 `fields` 和 `appliedAtomically` 的对象；`nodes`/`marks` 的元素为纯字符串。响应 `data` 是面向演进的能力发现对象，后端会持续新增字段，调用方必须忽略未知字段，不得使用拒绝额外字段的严格反序列化。完整 200 响应 schema 与 example 见 [`AGENT_API_OPENAPI.yaml`](./AGENT_API_OPENAPI.yaml) 的 `CapabilitiesResponse`，官方脱敏 fixture 见 [`fixtures/agent-api/capabilities.success.json`](./fixtures/agent-api/capabilities.success.json)。

~~~http
POST /pages/PAGE_ID/content-drafts
Idempotency-Key: draft-run-123
Content-Type: application/json

{
  "baseRevision": 12,
  "contentSchemaVersion": 1,
  "content": {
    "type": "doc",
    "content": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "待确认正文" }] }
    ]
  },
  "metadata": {
    "title": "Agent API 使用手册",
    "icon": "🤖",
    "coverImage": {
      "source": "system",
      "url": "/system-images/space/nasa-Q1p7bh3SHj8-unsplash.jpg"
    },
    "coverPositionY": 50
  }
}
~~~

`metadata` 可选，支持 `title`、`icon`、`coverImage` 和 `coverPositionY`，校验规则与页面 PATCH 相同；提供后不会立刻修改正式页面。也可用 `sourceRevision` 代替 `content`，把历史版本生成成待确认草稿。成功响应中的 `previewUrl` 有效 24 小时；链接必须由草稿对应的 OA 用户登录知识库后访问。“草稿正文”会显示待确认正文和元数据，“当前正文”显示正式页面当前状态。

用户在 Agent 对话中确认后，Agent 使用新的 `Idempotency-Key` 调用 `POST /content-drafts/{draftId}/apply`。服务端先刷新实时 Yjs 状态，再检查 `baseRevision` 和元数据基准。成功时正文、正式修订以及草稿中的 title、emoji、封面会原子写入。页面正文期间被其他人修改时返回 `409 revision_conflict`；草稿涉及的元数据被修改时返回 `409 metadata_conflict`。草稿会变为 `stale`，必须重新读取页面并创建新草稿；不支持强制覆盖。

### 10.6 历史与反向引用

`GET /pages/{id}/revisions` 返回历史摘要，`GET /pages/{id}/revisions/{revision}` 返回 TipTap JSON 和 `contentSchemaVersion`。`GET /pages/{id}/backlinks` 只返回当前 OA 用户可见的引用页面。

## 11. 字段说明

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

### DirectoryPageSummary 附加字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `depth` | integer | 相对于请求目录的深度；直接子节点为 `1` |

目录响应还包含 `truncated` 布尔值，用于明确表示当前响应是否因分页上限截断。

### SearchResult 附加字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `icon` | string \| null | 页面图标 |
| `path` | string[] | 从顶层目录到直接父目录的标题路径 |
| `excerpt` | string | 最多约 120 个字符的正文摘要 |
| `titleMatch` | MatchRange \| null | 标题命中范围 `[start, end)` |
| `excerptMatch` | MatchRange \| null | 摘要命中范围 `[start, end)` |

## 12. 错误码与重试

| HTTP | `error.code` | 含义 | 调用方建议 |
| --- | --- | --- | --- |
| `400` | `invalid_request_context` | Agent ID 或 Run ID 不合法 | 修正请求头，不要原样重试 |
| `400` | `missing_oa_user_id` | 缺少 `X-OA-User-Id` | 补充当前终端用户的 OA user id |
| `400` | `invalid_oa_user_id` | `X-OA-User-Id` 格式不合法 | 修正 OA user id，不要原样重试 |
| `400` | `invalid_query` | 搜索词超过 100 个字符 | 缩短搜索词 |
| `400` | `invalid_pagination` | `limit` 或 `cursor` 不合法 | 重新使用服务端返回的游标 |
| `400` | `invalid_directory_query` | `recursive`、`maxDepth` 或 `kind` 不合法 | 修正目录遍历参数，不要原样重试 |
| `400` | `invalid_space` | `space` 不合法 | 使用 `public` 或 `private` |
| `400` | `invalid_format` | `format` 不受支持 | 使用支持的三种格式之一 |
| `401` | `missing_token` | 缺少 Bearer Token | 补充固定 Agent API Token |
| `401` | `invalid_token` | Token 格式错误或与固定 Token 不一致 | 检查双方配置，必要时轮换固定 Token |
| `403` | `oa_user_not_active` | OA user id 不存在、未同步或已停用 | 同步 OA 活跃用户目录，并确认调用方传入正确 ID |
| `404` | `not_found` | 资源不存在、不是目录或不可见 | 重新搜索或刷新目录，不要反复重试 |
| `429` | `rate_limited` | 超过请求频率限制 | 按 `Retry-After` 延迟重试 |
| `500` | `internal_error` | 知识库内部临时错误 | 指数退避重试，并记录 `requestId` |
| `503` | `agent_api_not_configured` | 知识库未正确配置固定 Token | 联系知识库运维配置 `KB_AGENT_API_TOKEN` |
| `400` | `missing_idempotency_key` | 写请求缺少有效幂等键 | 生成幂等键，并在同一请求的所有重试中复用 |
| `400` | `invalid_tiptap_content` | TipTap JSON、节点或引用不合法 | 按 `/capabilities` 返回的 schema 修正 |
| `409` | `idempotency_conflict` | 同一幂等键被用于不同请求 | 为新操作生成新 key |
| `409` | `revision_conflict` | 正文基准版本已过期 | 重新读取页面并生成新草稿 |
| `409` | `metadata_conflict` | title、emoji 或封面基准已变化 | 重新读取页面和元数据并生成新草稿 |
| `409` | `draft_not_active` | 草稿已提交、废弃、过期或失效 | 查询草稿状态或创建新草稿 |
| `503` | `agent_write_api_disabled` | 生产环境尚未开启写能力 | 完成迁移和协作服务升级后开启 |

建议只对 `429` 和 `500` 自动重试。`500` 可采用带随机抖动的指数退避，例如等待 1 秒、2 秒、4 秒，最多重试 3 次。

## 13. 对接验收清单

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
- [ ] 每个写操作生成独立 `Idempotency-Key`，网络重试复用同一 key。
- [ ] 正文严格执行读取 revision、创建草稿、打开预览、用户确认、apply；`409` 后不会强制覆盖。
- [ ] Agent 使用 `/capabilities` 的 TipTap schema，只引用目标页面附件和当前用户可见页面。
