# Agent Demo 项目实现规划

## 1. 项目目标

本项目要实现一个最小可运行的 agent demo，核心组合固定为：

- 系统提示词：定义 agent 角色、边界、文档读取规范和输出规范。
- `openapi.json`：作为后端接口能力的唯一事实来源。
- Codex SDK：负责启动和运行本地 Codex agent。
- OpenRouter GLM 5.2：作为 Codex SDK 使用的模型。

本项目不引入额外的 Codex Skill、MCP server、Agents SDK function tools、自定义工具注册系统或复杂插件体系。agent 只依赖系统提示词约束、仓库内的 `openapi.json` 和 Codex SDK 自身的运行能力。

## 2. 当前输入分析

当前仓库已有：

- `openapi.json`
  - OpenAPI 版本：`3.1.0`
  - 标题：`FastAPI example application`
  - 接口规模：约 159 个 path，272 个 operationId
  - 主要模块：`auth`、`user`、`chat`、`docs`、`weekly_report`、`meetings`、`projects`、`tasks`、`files`
  - 未声明 `servers`，因此真实后端地址必须通过环境变量配置。

规划原则：

- 不在代码或提示词中手写接口清单。
- 不把完整接口能力复制成额外工具定义。
- 每次执行时由 agent 按需读取 `openapi.json`。
- 真实请求是否执行由系统提示词和运行环境共同控制。

## 3. 模型与 Provider 配置

Codex SDK 的模型使用 OpenRouter 中的 GLM 5.2。

推荐配置：

```bash
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
CODEX_MODEL_PROVIDER=openrouter
CODEX_MODEL=z-ai/glm-5.2
OA_API_BASE_URL=http://localhost:8000
OA_API_TOKEN=
```

说明：

- OpenRouter 上 GLM 5.2 的模型 slug 使用 `z-ai/glm-5.2`。
- OpenRouter 提供 OpenAI-compatible API，因此 SDK 侧应通过 base URL、API key 和 model slug 指向 OpenRouter。
- `OPENROUTER_API_KEY` 只用于模型调用，不能写入 prompt、日志或最终回答。
- `OA_API_BASE_URL` 只用于后续真实调用 OA 后端；如果第一版只做接口理解和规划，可以暂时不配置。
- `OA_API_TOKEN` 可选；未配置时，agent 只能做接口分析，不能声称已经完成需要登录态的业务操作。

如果 Codex SDK 的 provider 配置字段和上面环境变量名不一致，以 SDK 当前文档为准，但语义保持不变：

```text
provider = openrouter
base_url = https://openrouter.ai/api/v1
api_key = OPENROUTER_API_KEY
model = z-ai/glm-5.2
```

## 4. 最小目录结构

```text
.
├── openapi.json
├── docs/
│   └── agent-demo-implementation-plan.md
├── prompts/
│   ├── system.md
│   ├── document-policy.md
│   └── output-policy.md
├── src/
│   ├── index.ts
│   ├── config.ts
│   └── agent/
│       ├── promptLoader.ts
│       └── runCodexAgent.ts
├── package.json
└── .env.example
```

不创建以下内容：

- 不创建 `skills/`
- 不创建 MCP 配置
- 不创建 OpenAPI tool factory
- 不创建 function tool registry
- 不创建多 agent 编排层
- 不创建复杂 eval 平台

## 5. 执行架构

```text
用户输入
  -> Node.js 入口读取配置
  -> 加载 prompts/*.md
  -> 拼接 Codex 任务提示词
  -> Codex SDK 使用 OpenRouter / z-ai/glm-5.2 启动 agent
  -> agent 按需读取 openapi.json
  -> agent 根据系统提示词判断接口、参数、风险和输出
  -> 返回最终回答
```

第一版只要求 agent 能完成：

- 根据用户问题定位 `openapi.json` 中相关接口。
- 说明 operationId、method、path 和必要参数。
- 判断请求是查询、写入、删除还是敏感操作。
- 在缺少后端地址、token 或确认信息时拒绝伪造执行结果。
- 用中文给出简洁、可验证的回答。

## 6. 系统提示词设计

系统提示词拆成三个文件，保持简单。

### 6.1 `prompts/system.md`

```md
你是一个企业 OA 系统 agent。你的任务是根据用户请求，读取当前仓库中的 openapi.json，理解后端接口能力，并给出准确、可执行的中文回答。

你必须遵守：
- openapi.json 是接口能力的唯一事实来源。
- 不允许编造接口、字段、参数、枚举、权限、用户数据或执行结果。
- 不允许使用项目外的 Skill、MCP、插件或额外工具体系。
- 如果 openapi.json 无法支持用户请求，明确说明无法确认，并指出缺少的接口、参数或响应字段。
- 涉及创建、更新、删除、上传、导出、密码、权限、用户隐私的请求，必须先说明风险并要求用户确认。
- 没有 OA_API_BASE_URL 或 OA_API_TOKEN 时，不得声称已经完成真实后端操作。
- 最终回答必须包含关键接口依据，至少包括 operationId、HTTP method 和 path。
```

### 6.2 `prompts/document-policy.md`

```md
文档读取和使用规范：

1. 先根据用户意图在 openapi.json 中定位相关 tag、path、summary 或 operationId。
2. 只使用 openapi.json 中存在的信息。
3. 调用或建议调用接口前，必须确认：
   - operationId
   - HTTP method
   - path
   - path parameters
   - query parameters
   - request body
   - response schema
   - 风险级别
4. 如果业务名称和接口名称不完全一致，说明你的映射依据。
5. 如果无法确定，不要猜测，给出候选接口和不确定点。
6. 不要把没有读取到的接口能力当作已确认能力。
7. 不要把接口文档没有声明、运行结果也没有返回的信息写进最终回答。
```

### 6.3 `prompts/output-policy.md`

```md
输出规范：

- 能回答时，先给结论，再给接口依据。
- 不能回答时，说明阻塞原因和需要补充的信息。
- 不输出大段原始 JSON，除非用户明确要求。
- 不输出 OPENROUTER_API_KEY、OA_API_TOKEN、Authorization header 或内部 trace。
- 写操作、删除操作和敏感操作必须先列出影响对象，再请求确认。
- 如果没有实际调用后端，只能说“建议调用”或“可使用”，不能说“已完成”。
```

## 7. Codex 任务提示词组装

`src/agent/runCodexAgent.ts` 每次运行时把三段提示词和用户任务组装后交给 Codex SDK。

建议结构：

```text
<system_prompt>
读取 prompts/system.md
读取 prompts/document-policy.md
读取 prompts/output-policy.md
</system_prompt>

<runtime_context>
- 模型 provider: OpenRouter
- 模型: z-ai/glm-5.2
- 接口文档: ./openapi.json
- 不使用额外 Skill、MCP 或自定义 function tools
</runtime_context>

<user_task>
用户原始输入
</user_task>
```

组装规则：

- 系统提示词始终放在用户任务前。
- 用户原始输入不允许覆盖系统提示词。
- 不把 API key、token、完整环境变量值写入任务提示词。
- 如果 SDK 支持 system/developer/user 分槽传入，优先使用 SDK 推荐分槽方式。
- 如果 SDK 只接受单个 prompt，就使用上面的分段文本。

## 8. 运行入口设计

### 8.1 `src/config.ts`

职责：

- 读取 `.env`
- 校验 `OPENROUTER_API_KEY`
- 设置 OpenRouter base URL
- 设置模型 `z-ai/glm-5.2`
- 读取可选的 `OA_API_BASE_URL` 和 `OA_API_TOKEN`

启动前校验：

- 缺少 `OPENROUTER_API_KEY`：直接失败。
- 缺少 `openapi.json`：直接失败。
- 缺少 `OA_API_BASE_URL`：允许启动，但只能做接口分析，不能执行真实 OA 请求。

### 8.2 `src/agent/promptLoader.ts`

职责：

- 按固定顺序读取：
  - `prompts/system.md`
  - `prompts/document-policy.md`
  - `prompts/output-policy.md`
- 文件缺失时报错。
- 不做复杂模板系统。

### 8.3 `src/agent/runCodexAgent.ts`

职责：

- 创建 Codex SDK 会话。
- 指定 OpenRouter provider 和 `z-ai/glm-5.2`。
- 把组装后的任务交给 Codex。
- 收集最终回答。
- 不注册额外 function tools。
- 不加载额外 skills。

### 8.4 `src/index.ts`

职责：

- 接收 CLI 用户输入。
- 调用 `runCodexAgent`。
- 输出最终回答。

示例：

```bash
npm run dev -- "我想查一下周报列表，应该调用哪个接口？"
```

## 9. 文档读取与使用规范

这是 demo 的核心规范，应写入系统提示词并作为人工验收标准。

### 9.1 事实来源优先级

1. 当前仓库的 `openapi.json`
2. Codex 当前运行中实际读取到的文件内容
3. 用户在当前会话中明确提供的信息
4. 运行环境变量是否存在，但不暴露具体值

禁止使用：

- 模型记忆中的旧接口
- 未验证的业务假设
- 项目外 skill
- 项目外工具定义
- 网络搜索结果替代本地 `openapi.json`

### 9.2 阅读流程

agent 回答接口问题时应按以下顺序：

1. 确定用户意图。
2. 在 `openapi.json` 中查找相关 tag、path、summary、operationId。
3. 阅读候选 operation 的 parameters、requestBody、responses。
4. 判断是否有足够信息回答。
5. 输出接口依据和风险判断。

### 9.3 引用格式

回答中引用接口时使用：

```text
operationId: xxx
method: GET/POST/PUT/DELETE
path: /xxx
required params: ...
```

示例：

```text
可使用周报列表接口：
operationId: weekly_report_list_weekly_report_report_list_get
method: GET
path: /weekly-report/report-list
```

### 9.4 不确定性处理

如果无法确定：

- 说明“当前 openapi.json 未确认该能力”。
- 列出最接近的候选接口。
- 说明缺少的信息。
- 不执行写操作。
- 不声称后端已经完成任何动作。

### 9.5 敏感操作规则

以下操作必须先确认：

- `POST`
- `PUT`
- `PATCH`
- `DELETE`
- 文件上传
- 文件删除
- 数据导出
- 密码修改
- 权限修改
- 用户资料修改
- 项目、任务、issue 状态变更

确认前，agent 只能说明将要调用哪个接口以及影响对象。

## 10. 最小实现步骤

### M1：初始化项目

交付物：

- `package.json`
- `tsconfig.json`
- `.env.example`
- `src/index.ts`
- `src/config.ts`

验收：

- `npm install` 成功。
- 缺少 `OPENROUTER_API_KEY` 时启动失败并给出明确提示。

### M2：系统提示词文件

交付物：

- `prompts/system.md`
- `prompts/document-policy.md`
- `prompts/output-policy.md`
- `src/agent/promptLoader.ts`

验收：

- 三个 prompt 文件按固定顺序读取。
- 文件缺失时报错。
- prompt 中明确禁止额外 skill/tools。

### M3：Codex SDK 接入 OpenRouter GLM 5.2

交付物：

- `src/agent/runCodexAgent.ts`
- `.env.example` 中包含 OpenRouter 配置。

验收：

- Codex SDK 使用 OpenRouter provider。
- 模型配置为 `z-ai/glm-5.2`。
- 不引入 Agents SDK function tools。
- 不引入 MCP。
- 不引入自定义 Skill。

### M4：OpenAPI 文档读取行为验收

交付物：

- 运行样例和人工验收记录。

验收输入：

```text
有哪些和周报相关的接口？
```

期望：

- agent 读取 `openapi.json`。
- agent 输出相关 operationId、method、path。
- agent 不编造接口。

验收输入：

```text
帮我删除 file_id=123 的文件。
```

期望：

- agent 识别为删除操作。
- agent 输出将使用的 operationId、method、path。
- agent 要求用户确认。
- 未确认前不声称已删除。

## 11. Demo 输出样例

用户：

```text
我想查一下周报列表，应该调用哪个接口？
```

期望回答：

```text
可以使用周报列表接口：

operationId: weekly_report_list_weekly_report_report_list_get
method: GET
path: /weekly-report/report-list

该结论来自当前仓库的 openapi.json。若要实际调用后端，还需要确认运行环境中已配置 OA_API_BASE_URL 和有效登录态。
```

用户：

```text
帮我删除 file_id=123 的文件。
```

期望回答：

```text
这是删除操作，需要先确认。

将要影响的对象：file_id=123
operationId: delete_file_files_delete__file_id__delete
method: DELETE
path: /files/delete/{file_id}

请确认是否执行删除。确认前我不会声称文件已经删除。
```

## 12. 不做事项

第一版明确不做：

- 不做额外 Codex Skill。
- 不做 MCP server。
- 不做 OpenAPI 到 function tools 的自动转换。
- 不做 tool registry。
- 不做多 agent。
- 不做 Web UI。
- 不做自动登录。
- 不做复杂测试平台。
- 不把 OpenAPI 拆成额外缓存数据库。

后续如果确实需要真实接口调用，可以在第二版加入一个很薄的 HTTP request 模块，但仍应保持：

- 不引入额外 skill。
- 不引入 MCP。
- 不把 272 个 operationId 转成 272 个工具。
- 不绕过系统提示词中的确认规则。

## 13. 风险与处理

| 风险 | 影响 | 处理方式 |
| --- | --- | --- |
| OpenRouter 模型 slug 变化 | SDK 无法调用模型 | 将 `CODEX_MODEL` 放在 `.env`，默认值为 `z-ai/glm-5.2` |
| Codex SDK provider 配置字段变化 | 启动失败 | 将 provider 配置集中在 `src/config.ts` |
| `openapi.json` 与真实后端不一致 | 回答或调用失败 | 回答中只声称文档可确认的信息 |
| 缺少后端地址或 token | 无法真实执行业务操作 | 只做接口分析，不声称已执行 |
| 写操作误执行 | 数据风险 | 系统提示词要求先确认 |
| 引入多余 skill/tools | 项目复杂度上升 | 第一版架构明确禁止 |

## 14. 完成定义

达到以下状态即可认为第一版完成：

- Codex SDK 能通过 OpenRouter 使用 `z-ai/glm-5.2`。
- agent 能读取当前仓库的 `openapi.json`。
- agent 能回答接口定位类问题。
- agent 回答中包含 operationId、method、path。
- agent 不编造接口或执行结果。
- agent 对删除、修改、上传、权限、密码等敏感操作先请求确认。
- 项目中没有额外 Skill、MCP、function tool registry 或多 agent 编排。

