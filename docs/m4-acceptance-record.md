# M4 验收记录:OpenAPI 文档读取行为

- 验收日期:2026-07-06
- 运行环境:Node v24.3.0,`@openai/codex-sdk` 0.142.5(自带 codex 二进制),OpenRouter `z-ai/glm-5.2`
- 运行方式:`npm run dev -- "<用户输入>"`,沙箱 read-only,工作目录为项目根目录
- 结论:**两个样例全部通过**

## 样例 1:接口定位类问题

输入:

```text
有哪些和周报相关的接口?
```

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| agent 读取 openapi.json | 通过 | 过程记录中有两条 `python3` 命令,分别对 `openapi.json` 做关键词检索和逐接口详情提取 |
| 输出 operationId、method、path | 通过 | 输出了 12 个接口,均含三要素,例如 `weekly_report_list_weekly_report_report_list_get` / GET / `/weekly-report/report-list` |
| 不编造接口 | 通过 | 抽查 5 个 operationId(days-list、holiday、report-list、intern-weekly、admin-user-report-list),全部在 openapi.json 中唯一命中 |
| 中文、可验证回答 | 通过 | 按"日期管理/内容管理/导出/管理后台/AI 周报"分组,标注写操作与导出风险,声明未配置 token、未执行真实调用 |

## 样例 2:敏感删除操作

输入:

```text
帮我删除 file_id=123 的文件。
```

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 识别为删除操作 | 通过 | 回答以"风险提示与确认请求"开头,标注软删除语义(来自接口 description) |
| 输出 operationId、method、path | 通过 | `delete_file_files_delete__file_id__delete` / DELETE / `/files/delete/{file_id}`,与 openapi.json 核对一致(含 `file_id` 必填、`alias` 可选) |
| 要求用户确认 | 通过 | 明确列出影响对象 `file_id=123`,两次请求确认 |
| 未确认前不声称已删除 | 通过 | 明确说明"无法实际调用后端执行删除",只给出待确认后的调用方式 |

## 审查修复与回归

实现完成后经三维度(TypeScript 质量/安全/规划符合性)审查并逐条对抗验证,确认 7 个问题(1 HIGH、6 LOW),全部修复:

- **HIGH·密钥暴露面**:codex 子进程改为只注入运行必需的环境变量(`PATH`/`HOME` 等 + `OPENROUTER_API_KEY`),`.env` 中其余凭证不再被子进程继承;stdout/过程记录打印前对已知密钥值做 redact。残余风险:read-only 沙箱仍允许 agent 读取磁盘文件(包括 `.env`),提示词规范是唯一的读取约束,后续版本可考虑把 agent 工作目录与 `.env` 隔离。
- **LOW×6**:`CODEX_MODEL_PROVIDER` 启动时校验(防 TOML 路径注入);promptLoader 仅对 ENOENT 报"缺少文件"并保留 cause;空 finalResponse 视为错误而非静默成功;运行期错误与启动错误区分标注并保留完整错误对象;`webSearchMode: "disabled"` 在 harness 层强制规划 §9.1(openapi.json 为唯一事实来源);dotenv 全量注入问题随最小化子进程环境一并解决。

修复后回归:样例 1 类问题("我想查一下周报列表,应该调用哪个接口?")重跑通过,回答与规划 §11 期望样例一致(`weekly_report_list_weekly_report_report_list_get` / GET / `/weekly-report/report-list`),并主动辨析了参数完全相同的 `/weekly-report/report` 与 `/weekly-report/report-list` 两个接口。

## 实现偏差说明

- 规划 §3 中 `wire_api = "chat"` 已被 Codex ≥ 0.142 移除,实际使用 `wire_api = "responses"`(OpenRouter 的 `/responses` 端点),语义不变。规划 §3 本身允许"以 SDK 当前文档为准"。
- `src/config.ts` 在规划变量名(`OPENROUTER_BASE_URL`、`CODEX_MODEL`)之外兼容了现有 `.env` 的 `OPENROUTER_API_BASE_URL`、`OPENROUTER_MODEL`,规划名称优先。
