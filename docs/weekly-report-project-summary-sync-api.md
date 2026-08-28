# 周报项目总结同步接口

## 用途

周报创建或更新后，OA 通知 OAagent。OAagent 会在防抖后读取周报和全部项目（包含归档项目），拆分项目更新内容，并调用现有项目总结接口写入。

OA 只负责投递事件，不直接调用执行接口。

## 事件入口

```http
POST /internal/automation-events
Authorization: Bearer <OA_AGENT_AUTOMATION_TOKEN>
Content-Type: application/json
```

请求体：

```json
{
  "event_id": "019fd15d-32c6-7fb2-9afb-68be0996b80f",
  "event_type": "weekly_report.updated",
  "aggregate_type": "weekly_report",
  "aggregate_id": "report-123",
  "aggregate_version": 7,
  "occurred_at": "2026-08-27T09:30:00Z",
  "actor_id": 42,
  "scope": { "user_id": 42 },
  "data": {
    "weekly_num": 202635,
    "content": "项目 51：完成联调\n项目 72：修复登录问题",
    "content_hash": "sha256:<content 的 SHA-256>",
    "updated_at": "2026-08-27T09:29:58Z"
  }
}
```

字段要求：

- `event_id`：UUID，重试时保持不变。
- `event_type`：`weekly_report.created` 或 `weekly_report.updated`。
- `aggregate_id`：周报稳定 ID。
- `aggregate_version`：周报版本号，必须递增。
- `weekly_num`：周报业务编号。
- `content`：建议传完整周报内容；不传时 OAagent 需要能够按 ID 回读。
- `content_hash`：传入时必须与 `content` 匹配。

请求字段说明：

| 字段 | 必填 | 用途 |
| --- | --- | --- |
| `event_id` | 是 | 本次事件的唯一 ID。网络重试必须复用同一个值，用于防止重复入队。 |
| `event_type` | 是 | 事件动作：`created` 表示新建周报，`updated` 表示修改周报。 |
| `aggregate_type` | 是 | 资源类型，固定填写 `weekly_report`。 |
| `aggregate_id` | 是 | 周报的稳定业务 ID，用来识别是哪一篇周报发生变化。 |
| `aggregate_version` | 是 | 周报内容版本号。OA 每次成功保存后递增，旧版本事件会被忽略。 |
| `occurred_at` | 是 | OA 产生事件的时间，使用带时区的 ISO 8601 格式。 |
| `actor_id` | 否 | 执行保存操作的 OA 用户 ID，用于审计；没有操作者时可不传。 |
| `scope.user_id` | 否 | 周报所属用户 ID，用于权限和任务范围匹配；建议传入。 |
| `data.weekly_num` | 是 | 周报业务编号，用于计算写入项目总结的 `summary_date`。 |
| `data.content` | 否 | 周报完整内容。建议传入，Worker 可直接使用本次内容。 |
| `data.content_hash` | 否 | 周报内容 SHA-256，格式为 `sha256:<64 位 hex>`，用于校验内容未被篡改。 |
| `data.updated_at` | 否 | 周报最后更新时间。用于补充来源时间；不替代 `aggregate_version`。 |

成功响应：HTTP `202`

```json
{
  "code": 202,
  "message": "accepted",
  "success": true,
  "data": {
    "event_id": "019fd15d-32c6-7fb2-9afb-68be0996b80f",
    "accepted": true,
    "deduplicated": false,
    "status": "queued",
    "run_id": "7f7dc11f-30b5-482f-a8bf-5ee72b667baf"
  }
}
```

`run_id` 是本次处理运行 ID。重复投递同一事件会返回 `deduplicated=true`，不会重复创建运行。

响应字段说明：

| 字段 | 用途 |
| --- | --- |
| `code` | HTTP 状态码；正常接收为 `202`。 |
| `message` | 简短结果描述，正常接收为 `accepted`。 |
| `success` | 请求是否被接口正常处理。 |
| `data.event_id` | OAagent 最终记录的事件 ID，应与请求中的 `event_id` 相同。 |
| `data.accepted` | 是否接受了该事件请求。 |
| `data.deduplicated` | 是否检测到重复事件；为 `true` 时不会新建运行。 |
| `data.coalesced` | 是否合并到已有的 `pending` Run；连续更新时可能为 `true`。 |
| `data.status` | 事件状态，常见为 `queued`、`deduplicated`、`stale` 或 `ignored`。 |
| `data.run_id` | 关联的运行 ID。被忽略或旧版本事件可能为 `null`。 |

## 处理规则

- 默认防抖 `60` 秒；连续更新会合并为最后一次内容。
- 任务范围固定为全部项目，包含归档项目。
- 项目匹配不确定时不写入，记录为待复核结果。
- 达到置信度阈值的不同项目会并发调用项目总结接口；并发上限由 `PROJECT_PROGRESS_OA_WRITE_CONCURRENCY` 控制，默认 4，同一项目同一周次只保留一个增量写入任务。
- `summary_date` 使用周报业务日期；`ai_note` 写入带时间的周报来源内容。

## 常见错误

| HTTP | 含义 |
| --- | --- |
| `401` | 自动化服务 Token 无效 |
| `409` | `event_id` 或周报版本冲突 |
| `422` | 请求字段缺失或格式错误 |
| `500` | OAagent 内部错误，可稍后按原 `event_id` 重试 |

事件必须在 OA 周报事务提交成功后投递。建议使用 Outbox，避免周报已保存但事件未送达。
