# Copilot 记录 API

## 模块概览

- Tag：`copilot`
- Prefix：`/copilot`
- 默认登录：已登录用户
- 接口数量：5
- 源码：`fast/apps/routers/copilot.py`

## 通用响应

大多数接口返回统一 JSON 响应壳：

```json
{ "code": 200, "message": "ok", "data": {}, "success": true }
```

历史接口、文件下载、导出接口可能直接返回对象或文件流，已在对应接口的出参中标注。

## 接口列表

### 1. `GET /copilot/list`

- 路由：`GET /copilot/list`
- 功能：查询 list。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/copilot.py:16`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| page | integer | 否 | Page | 1 |
| size | integer | 否 | Size | 10 |
| alias | Alias | 否 | Alias | default |

#### 出参

- 成功响应：
  - 统一响应壳；data: total: total, page: page, size: size, items: array。

- 常见错误：
  - `422: FastAPI 参数校验失败`

### 2. `GET /copilot/record`

- 路由：`GET /copilot/record`
- 功能：查询 record。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/copilot.py:35`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| record_id | integer | 是 | Record Id | - |
| alias | Alias | 否 | Alias | default |

#### 出参

- 成功响应：
  - 统一响应壳；data: item.detail()。

- 常见错误：
  - `422: FastAPI 参数校验失败`
  - `404: copilot record not found: {...}`

### 3. `POST /copilot/record`

- 路由：`POST /copilot/record`
- 功能：创建或提交 record。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/copilot.py:50`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| alias | Alias | 否 | Alias | default |

**body（application/json，整体必填：是）**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| body | object | 是 | Copilot record JSON 对象 | - |

#### 出参

- 成功响应：
  - 统一响应壳；data: item.detail()。

- 常见错误：
  - `422: FastAPI 参数校验失败`

### 4. `PATCH /copilot/record`

- 路由：`PATCH /copilot/record`
- 功能：更新已有 Copilot record，整体覆盖 `record` 字段。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/copilot.py:62`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| record_id | integer | 是 | Record Id | - |
| alias | Alias | 否 | Alias | default |

**body（application/json，整体必填：是）**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| body | object | 是 | 完整 Copilot 会话 JSON 对象，会整体覆盖原 `record` 字段 | - |

#### 出参

- 成功响应：
  - 统一响应壳；data: item.detail()。

- 常见错误：
  - `401: 未登录`
  - `404: copilot record not found: {...}`
  - `422: FastAPI 参数校验失败`

### 5. `DELETE /copilot/record`

- 路由：`DELETE /copilot/record`
- 功能：删除 record。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/copilot.py:86`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| record_id | integer | 是 | Record Id | - |
| alias | Alias | 否 | Alias | default |

#### 出参

- 成功响应：
  - 统一响应壳；data: record_id: record_id。

- 常见错误：
  - `422: FastAPI 参数校验失败`
  - `404: copilot record not found: {...}`

## 相关 detail() 字段参考

以下字段来自同名模块 model 的 `detail()` 方法，仅用于辅助理解旧接口 `data` 结构。

- `CopilotRecord.detail()`：`id`, `user_id`, `record`, `updated_at`, `created_at`
