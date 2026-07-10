# 认证 API

## 模块概览

- Tag：`auth`
- Prefix：`/auth`
- 默认登录：无默认登录依赖
- 接口数量：5
- 源码：`fast/apps/routers/authentication.py`

## 通用响应

大多数接口返回统一 JSON 响应壳：

```json
{ "code": 200, "message": "ok", "data": {}, "success": true }
```

历史接口、文件下载、导出接口可能直接返回对象或文件流，已在对应接口的出参中标注。

## 接口列表

### 1. `POST /auth/change-password`

- 路由：`POST /auth/change-password`
- 功能：创建或提交 change password。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/authentication.py:100`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| alias | Alias | 否 | Alias | default |

**body（application/json，整体必填：是）**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| old_passwd | string | 是 | Old Passwd | - |
| new_passwd | string | 是 | New Passwd | - |

#### 出参

- 成功响应：
  - 统一响应壳；data: null 或未显式返回。 message: ok。

- 常见错误：
  - `422: FastAPI 参数校验失败`
  - `400: The new password is the same as the old one.`
  - `400: old passwd is incorrect`

### 2. `POST /auth/login`

- 路由：`POST /auth/login`
- 功能：创建或提交 login。
- 登录：未登录态辅助（允许未登录；若已登录会读取当前用户）
- 源码：`fast/apps/routers/authentication.py:66`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| alias | Alias | 否 | Alias | default |

**body（application/json，整体必填：是）**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| email | string | 是 | Email | - |
| password | string | 是 | Password | - |
| remember | boolean | 否 | Remember | true |

#### 出参

- 成功响应：
  - 统一响应壳；data: id: user.id, email: user.email。 message: User is already logged in.。
  - 统一响应壳；data: id: user.id, email: user.email, token: data.decode('utf-8')。

- 常见错误：
  - `422: FastAPI 参数校验失败`
  - `400: login failed`
  - `400: 账号或密码不正确`

### 3. `GET /auth/logout`

- 路由：`GET /auth/logout`
- 功能：查询 logout。
- 登录：已登录用户（session/token）
- 源码：`fast/apps/routers/authentication.py:91`

#### 入参

无

#### 出参

- 成功响应：
  - 统一响应壳；data: null 或未显式返回。

### 4. `GET /auth/ping`

- 路由：`GET /auth/ping`
- 功能：查询 ping。
- 登录：无需登录
- 源码：`fast/apps/routers/authentication.py:25`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| alias | Alias | 否 | Alias | default |

#### 出参

- 成功响应：
  - 统一响应壳；data: null 或未显式返回。

- 常见错误：
  - `422: FastAPI 参数校验失败`

### 5. `POST /auth/register`

- 路由：`POST /auth/register`
- 功能：创建或提交 register。
- 登录：无需登录
- 源码：`fast/apps/routers/authentication.py:33`

#### 入参

**Query 参数**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| alias | Alias | 否 | Alias | default |

**body（application/json，整体必填：是）**

| 字段 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| password | string | 是 | Password | - |
| email | string | 是 | Email | - |

#### 出参

- 成功响应：
  - 统一响应壳；data: id: new_user.id, email: new_user.email。

- 常见错误：
  - `422: FastAPI 参数校验失败`
  - `400: email:{...} already exists`
  - `500: create user failed`
