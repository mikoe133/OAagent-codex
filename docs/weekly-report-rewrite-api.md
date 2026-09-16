# 当天 Commit 总结更新整篇周报

## 实际流程

`github_project_progress_sync` 沿用原有 GitHub Commit 读取和每日总结流程：

1. 读取当天 Commit，生成并保存当天的项目总结。
2. 按 GitHub 作者和总结日期，汇合同一天相关项目的总结。
3. 从 OA 读取该作者当前周报全文。
4. Agent 以「当前周报 + 当天 Commit 总结」重写整篇正文，合并重复内容、更新旧状态，保留之前其他工作与手写内容。
5. 独立审核通过后，覆盖保存全文；不在旧正文末尾追加。

例如：原文「完成接口文档，正在修复登录问题；完成客户沟通」，当天总结「登录问题已修复」，重写为「完成接口文档和登录问题修复；完成客户沟通」。

不额外查询整周项目动态，不从团队项目库重建周报。没有当天总结时不更新周报。若显式选择了历史日期/最新提交等原有运行范围，则处理该范围实际产生的日期；多个日期按时间顺序处理，每次重新读取当前周报，不混成一批整周事实。

## 原接口兼容扩展

沿用 `OA_PROJECT_SYNC_TOKEN`、GitHub 作者映射与写周报权限。目标用户须唯一、在职且允许写周报；周报周期由 `weekly_report_days` 解析，目标周报必须已存在。

### 读取当前周报

```http
GET /internal/project-sync/weekly-reports/style-context?mode=rewrite&github_id=alice&summary_date=2026-09-16
```

响应沿用 `{code,message,success,data}`，`data` 为：

```json
{
  "report_id": 12,
  "weekly_num": 121,
  "owner_id": 7,
  "github_id": "alice",
  "start_date": "2026-09-14",
  "end_date": "2026-09-20",
  "content": "完成接口文档，正在修复登录问题。",
  "content_hash": "当前完整正文的64位小写SHA256"
}
```

查询仅涉及作者身份、周历和已有周报，不查询项目历史或辅助状态表。旧调用省略 `mode` 时仍返回历史风格参考。

### 替换完整正文

```http
POST /internal/project-sync/weekly-reports/append
```

```json
{
  "mode": "replace",
  "report_id": 12,
  "github_id": "alice",
  "summary_date": "2026-09-16",
  "expected_content_hash": "读取到的完整旧正文的64位小写SHA256",
  "content": "完成接口文档和登录问题修复。",
  "origin": "project_progress_sync"
}
```

后端锁定目标作者、周期及周报，检查 report_id 和原正文 SHA-256 后才覆盖。即使两次人工编辑发生在同一秒，也能通过正文哈希检测变化，不依赖 updated_at 精度，不新增版本列。

返回 `data`：

```json
{
  "report_id": 12,
  "weekly_num": 121,
  "owner_id": 7,
  "github_id": "alice",
  "content_hash": "保存后的完整正文的64位小写SHA256",
  "updated": true
}
```

若当前内容已等于请求的新内容，返回 `updated=false`，不重复写入，支持响应丢失后的安全重放。生成时正文已被其他人修改，则返回 `409 weekly_report_version_conflict`；OAagent 重新读取新正文，融合相同的当天总结并再次审核，最多重试一次。

旧调用省略 `mode` 仍按 `marker` 追加。新 Worker 固定使用 `mode=replace`，失败不降级为追加。服务使用既有服务认证与正文 CAS；此路径不实现运行级 fencing，Worker 调用前仍检查取消/租约状态。

## 生成质量与已有内容

生成和审核都能看到完整当前周报及本次当天总结。当前周报是工作底稿，包含手写内容、原有项目和旧自动生成内容，不再尝试区分手写/机器来源；新的明确进展用于更新旧状态，其他已有信息应保留。

模型输入中只去掉旧 `oaagent-project-progress` 注释标记，保留标记两侧全部正文。无需先清理旧追加块，也不会因为段内人工修改而阻止后续生成。原始全文仍用于保存前哈希比较。

输出必须引用底稿和每条当天总结，不能出现思考过程或无依据的新功能。独立审核检查遗漏、状态冲突、重复及个人贡献归属。全文最多 1000 字；输入超出预算不截断。生成或审核失败保留原文。审核依赖模型，不能保证修复底稿中原有的所有错误。

当天总结已反映在周报中时，提示模型保持原文，后端按内容相同去重；不新增持久化生成缓存，因此重新运行仍可能调用模型。自动替换不投递反向周报事件，OAagent 对意外收到的 `origin=project_progress_sync` 事件也做 ignored 防护。

## 上线与验证

**没有新表、没有数据库字段变更、无需执行建表 SQL。** 先部署 OAbackend 的原接口扩展，再部署 OAagent。未部署接口扩展时周报更新会失败并保留原文，不退回追加。

测试覆盖：当天总结与当前底稿同时输入、保留其他工作、更新旧状态、处理旧标记和段内手改、多项目同日合并、不同日期依次更新、审核拒绝、正文冲突重读、旧接口兼容、权限及事务回滚。数据库与模型采用模拟数据，不对生产库执行操作；真实模型质量和 MySQL 并发需在隔离环境验收。
