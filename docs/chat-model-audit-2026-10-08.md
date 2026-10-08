# OAagent 对话模型核对（2026-10-08）

核对范围为 OAagent 对话菜单中的 OpenRouter 与 Nexttoken 型号。以厂商当前旗舰定位、OpenRouter 实时可用模型目录及公开评测为依据；“最强”指综合能力档位，不保证在每个单项任务上领先，也不是 OA 业务场景的实测排名。

## 本次变更

- 对话菜单与后端模型白名单：`deepseek/deepseek-v4-flash` → `deepseek/deepseek-v4.1-flash`。
- 已下架 `deepseek/deepseek-v4-pro`：从对话菜单、后端白名单和 Codex 自定义模型元数据中移除；新对话和自动化配置不再接受该型号。浏览器保存的 Pro 对话选择在刷新后回退到 V4.1 Flash。
- 前端默认值、后端默认值、本地 `.env`、`.env.example` 和部署环境生成脚本同步更新。
- 添加 Codex SDK 自定义模型元数据：1,048,576 token 上下文、996,147 token 自动压缩阈值。
- 浏览器保存的旧 V4 Flash 对话选项不再属于有效对话型号，沿用现有恢复逻辑，在刷新后回退到 V4.1 Flash。
- 轻量语义路由的候选型号继续独立配置；默认竞速组合已经包含 V4.1 Flash。

线上服务需重新部署后生效；本地已运行的后端进程需重新启动以加载更新后的环境配置。

## 核对结果

| 厂商 / 提供商 | 当前对话选项 | 结论 |
| --- | --- | --- |
| DeepSeek / OpenRouter | DeepSeek V4.1 Flash（本次更新） | 当前综合能力优先选项。OpenRouter 展示的 Artificial Analysis 最高思考档综合智能指数为 39.5，高于 V4 Pro 0813 的 36.0；部分单项仍由 Pro 领先。 |
| 智谱 / OpenRouter | `z-ai/glm-5.3` | 当前旗舰能力档。新出的 GLM-5.3 Prime 继承其能力，主要提高推理吞吐速度。 |
| 月之暗面 / OpenRouter | `moonshotai/kimi-k3` | 当前旗舰；官方称其为迄今能力最强的 Kimi 模型。 |
| 阿里 / OpenRouter | `qwen/qwen3.8-max-0902` | 当前 Qwen 旗舰能力档，0902 为更新快照。Qwen3.8 Max Prime 是更高吞吐版本，没有依据说明它在综合智能上更强。 |
| DeepSeek / OpenRouter | `deepseek/deepseek-v4-pro`（已下架） | 旧的 V4 Pro 0423 预览版，既不是较新的 Pro 0813 正式版，也不是目前综合能力优先选项。OAagent 已移除该选项，默认使用 V4.1 Flash。 |
| OpenAI / Nexttoken | GPT-5.6 Terra、Sol、Luna，及 GPT-5.5 / 5.4 / 5.4 Mini | 不是 OpenAI 当前最强系列。官方旗舰为 GPT-6 Astra；Nexttoken 的认证 `/v1/models` 查询已经返回 `gpt-6-astra`，但 OAagent 当前白名单和菜单尚未开放它。当前菜单中的 GPT-5.6 Sol 是 5.6 系列旗舰，默认 Terra 是平衡档。 |

本次已升级 DeepSeek Flash 对话型号并下架 V4 Pro。其他厂商型号的升级建议属于核对结果，尚未实施。Nexttoken 返回型号代表网关列出了该型号，本次未对 GPT-6 Astra 做推理调用或质量验证。

后端 OpenRouter 白名单还保留 `openai/gpt-5.5` 与 `openai/gpt-5.4`，它们未显示在前端 OpenRouter 对话菜单，也不是 OpenAI 当前最强型号。

## 验证

- 已通过 OAagent 的模型中继真实调用 OpenRouter Responses API，使用 `deepseek/deepseek-v4.1-flash` 与 `reasoning.effort=high`。
- 接口返回 HTTP 200、`status=completed`，成功生成指定 `connectivity_check` 工具调用及预期参数。该检查仅确认接入、推理参数和工具调用可用，不构成业务质量评测。
- 模型选择、Codex 元数据、后端 HTTP 对话与附件处理相关测试：79 项通过。
- 部署环境生成及工作流配置测试：26 项通过。
- 前端输入框、对话代理与 HTTP 集成测试：24 项通过。
- 前后端 TypeScript 类型检查通过。
- V4 Pro 下架后，模型选择、自动化配置、Codex 元数据、附件处理、推理参数和对话代理相关测试共 86 项通过；前后端类型检查再次通过。

## 来源

- [OpenRouter 实时模型目录](https://openrouter.ai/api/v1/models)
- [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)
- [DeepSeek V4 Pro 0813](https://openrouter.ai/deepseek/deepseek-v4-pro-0813)
- [DeepSeek V4 Pro 0423](https://openrouter.ai/deepseek/deepseek-v4-pro)
- [Z.ai GLM-5.3 官方文档](https://docs.z.ai/guides/llm/glm-5.3)
- [OpenRouter GLM-5.3 Prime](https://openrouter.ai/z-ai/glm-5.3-prime)
- [MoonshotAI Kimi K3 官方仓库](https://github.com/MoonshotAI/Kimi-K3)
- [阿里云 Qwen3.8 Max 官方文档](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max)
- [OpenRouter Qwen3.8 Max 0902](https://openrouter.ai/qwen/qwen3.8-max-0902)
- [OpenRouter Qwen3.8 Max Prime](https://openrouter.ai/qwen/qwen3.8-max-prime)
- [OpenAI GPT-6 Astra 官方文档](https://developers.openai.com/api/docs/models/gpt-6-astra)
