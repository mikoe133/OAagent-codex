# 国产路由模型实测 — 2026-09-28

建议优先采用 `z-ai/glm-5.3-flash`，设置 `reasoning.effort=low`，并要求供应商支持请求参数。`deepseek/deepseek-v4.1-flash` 关闭推理后是同样值得考虑的候选。模型升级应与候选召回修复一起评估；本次没有修改生产配置。

## 测试范围与口径

- 通过本地配置的官方 OpenRouter API 实际调用；只测试国产模型，实际供应商另列于下文。
- 使用仓库本地 OA/知识库契约、真实 `createOpenApiSemanticRouter`、候选召回、路由提示词、解码器、最多两次尝试、512 token 上限和共享 8 秒超时。读取本地凭据但不写入结果。
- 本地已启用数据库读取模式：OA 读取统一用 `oa_database_read`，写操作使用 OA OpenAPI。使用合成中文请求，不读取真实用户会话，不执行 OA 或知识库业务操作。
- 24 个用例覆盖 OA 查询/统计/周报、知识库读写、项目/议题写入、代词引用、专有名词歧义、跨域查询、读写混合、否定写操作、引用内容注入、RWKV 模块。每个模型独立对照重复两轮，共 48 次；是 24 个不同问题，不是 48 个独立场景。
- 独立对照：每个问题使用完全相同的固定 20 个候选（含干扰接口），保证正确接口可见。这是诊断实验，不是当前线上召回结果。6 款关闭推理且设置 `provider.require_parameters=true`；GLM 5.3 的端点拒绝关闭推理，改用 low。
- 完整链路：恢复全部 167 个本地索引项，每次由现有代码召回 20/40 个候选。当前默认 GLM 使用原始参数，两个升级候选使用上述适配参数。此比较包含参数与供应商筛选的变化，不能归因于模型本身。
- 严格任务通过：8 秒内有效语义路由、预期接口域匹配、必需操作命中、读写意图正确，读取请求不选择写操作。缺失 accessMode 按生产解码器默认 read 计分；字段完整性另计。已核查独立对照中所有通过项的最终候选仍包含必需操作。
- 耗时为完整路由时间（包括重试），不是首 token。p95 使用 nearest-rank，失败/超时也纳入。主对照并发 3，GLM 5.3 单独并发 1，部分时间重叠；没有固定供应商和运行时段，结果是模型、端点、参数与当前网络的组合表现。

## 独立对照结果

| 模型 | 严格任务通过 | 有效语义路由 | 字段符合 JSON schema | 中位耗时 | p95 | 返回的费用合计（美元） |
|---|---:|---:|---:|---:|---:|---:|
| GLM 5.3 Flash（low） | 48/48（100.0%） | 48/48 | 48/48 | 1.72s | 2.60s | $0.007813 |
| DeepSeek V4.1 Flash | 46/48（95.8%） | 48/48 | 48/48 | 1.60s | 2.89s | $0.014674 |
| Qwen 3.8 Flash | 46/48（95.8%） | 47/48 | 47/48 | 3.06s | 6.96s | $0.008471 |
| DeepSeek V4 Flash | 41/48（85.4%） | 45/48 | 45/48 | 3.06s | 8.00s | $0.005669 |
| GLM 4.7 Flash（关闭推理） | 39/48（81.2%） | 43/48 | 44/48 | 2.51s | 8.00s | $0.005459 |
| MiMo V2.6 Flash | 34/48（70.8%） | 38/48 | 38/48 | 3.16s | 8.00s | $0.005833 |
| Qwen 3.5 Flash | 26/48（54.2%） | 46/48 | 0/48 | 1.41s | 2.61s | $0.005642 |

字段符合 schema 不代表接口选择正确；例如 JSON 合法但不存在的 tag/operation 仍会被生产解码器拒绝。

**人工复核：DeepSeek V4.1 的两次扣分都是 `kb-draft`。它正确选择了创建草稿接口，同时增加读取页面/草稿用于预览；严格最小域口径扣分，但业务上可接受。允许这类辅助读取时为 48/48，与 GLM 5.3 同分。不能据此宣称 GLM 的语义准确率显著更高。**

GLM 5.3 本轮 p95 略低，响应计费也较低，因此推荐优先集成；DeepSeek V4.1 的中位耗时略低。两者只做了小样本短时测试，尚未验证高并发和长期可用性。

## 当前完整路由链路

| 模型/参数 | 严格任务通过 | 有效语义路由 | 中位耗时 | p95 |
|---|---:|---:|---:|---:|
| GLM 4.7 Flash（当前原始参数） | 0/24 | 0/24 | 8.00s | 8.01s |
| GLM 5.3 Flash（low） | 15/24 | 23/24 | 1.82s | 3.75s |
| DeepSeek V4.1 Flash | 15/24 | 24/24 | 1.63s | 3.53s |

新模型完整链路均为 15/24，显著低于固定候选实验。GLM 5.3 为 23/24 有效语义路由、DeepSeek 为 24/24：有效 JSON/有效路由不代表选对业务操作。当前默认配置本轮超时会触发安全降级；这里测的是语义路由，不是最终业务回答成功率。

不调用模型的候选召回审计：首轮 20 个候选覆盖 15/24；强制模拟失败扩大到 40 个后覆盖 19/24。议题状态/优先级、知识库改标题/移动/草稿等 5 个用例，扩大后仍缺必要操作。扩大不是每轮都会发生；模型选了一个“合法但不相关”的候选时不会触发修复。

例如“查询项目28当前状态和负责人”，第一轮可能只有项目写接口，没有 `oa_database_read`。路由模型无法从看不见的接口中做正确选择；不应把这种失败当成模型语义能力不足。

## 兼容性与实施建议

1. 首选 GLM 5.3 Flash：`reasoning: {effort: "low"}`、`provider: {require_parameters: true}`，保留 JSON schema 与 8 秒预算。当前端点使用 `enabled:false` 时实测返回 400，提示推理不能关闭。
2. 备选 DeepSeek V4.1 Flash：`reasoning: {enabled: false}` 与相同 provider 限制。本次独立对照全部已返回响应由 Together 提供；GLM 5.3 主要也是 Together，另有 Parasail。因此不能视为已经验证供应商独立性的容灾组合。
3. 修复候选召回：数据库读取能力应稳定保留；知识库写能力与 OA 精确写操作不能被其他同域接口挤出。为上述 5 个缺失用例补候选召回回归测试。
4. 强化字段/语义校验：Qwen 3.5 在本次供应商路径中经常缺 accessMode、searchTerms 为字符串。当前容错可能把明确写请求按 read 处理。不能只以 HTTP 200 或能解析 JSON 判断成功。
5. 当前双模型竞速选的是最先有效的结果，不是最准确结果；单独换可选模型而保留固定 GLM 4.7 竞速，会使旧模型仍可能先获胜。双模型组合效果未在本次验证，不将单模型分数当作组合效果。

## 费用、供应商与局限

已落盘的实测路由样本 428 次（含冒烟、兼容性失败和重复运行），API 返回的费用合计约 **$0.071791**。费用是下限：超时/取消/中断后未返回 usage 的请求不计入，不能当成最终账单。召回审计的 24 次是本地 dry-run，没有模型调用。

供应商由 OpenRouter 自动选择，以下仅统计有完整响应并返回 provider 的请求：

- GLM 4.7 Flash（关闭推理）: Cloudflare 48 次
- Qwen 3.5 Flash: Alibaba 50 次
- DeepSeek V4 Flash: Venice 39 次, Alibaba 2 次, StreamLake 5 次, DigitalOcean 1 次
- Qwen 3.8 Flash: Alibaba 51 次
- DeepSeek V4.1 Flash: Together 49 次
- MiMo V2.6 Flash: DeepInfra 37 次, Xiaomi 3 次
- GLM 5.3 Flash（low）: Together 47 次, Parasail 2 次

两轮重复受缓存、动态供应商、网络、限流和同一时间窗口影响。本地契约可能与线上最新契约不同；没有生产真实用户问题标注集，也没有测最终执行或双模型竞速。公开模型目录最低价不等于本次命中的供应商价格。

## 复现与原始数据

从仓库根目录运行（会产生真实 OpenRouter 费用；从现有 .env 读取 key）：

```bash
node_modules/.bin/tsx agent/src/benchmark/routerModels.ts --mode=tuned --reasoning-effort=auto --candidates=controlled --rounds=2 --limit=24 --concurrency=3
```

完整召回实验去掉 `--candidates=controlled`；当前默认参数使用 `--mode=native --models=z-ai/glm-4.7-flash`；只审计召回加 `--dry-run`。

- [独立对照原始结果](../artifacts/router-benchmark/2026-09-28T08-42-07-187Z-tuned/summary.json)
- [GLM 5.3 low 原始结果](../artifacts/router-benchmark/2026-09-28T08-45-08-483Z-tuned/summary.json)
- [完整链路升级候选](../artifacts/router-benchmark/production-candidates/summary.json)
- [当前默认完整链路](../artifacts/router-benchmark/production-default/summary.json)
- [候选召回审计](../artifacts/router-benchmark/recall-audit/metadata.json)
- [OpenRouter 模型目录快照](../artifacts/router-benchmark/model-catalog-snapshot.json)
- [测试脚本及完整问题/预期接口](../agent/src/benchmark/routerModels.ts)

每个结果目录包含 metadata.json、逐用例结果（候选ID、返回文本、耗时、状态、usage、provider）和 summary.json。首次两题冒烟只用于检查连通性/参数，不进入排名；主对照目录中残留的 6 条 GLM 5.3 禁止关闭推理的兼容性记录不进入其 low 档排名。

验证：`node_modules/.bin/tsc --noEmit -p agent/tsconfig.json` 通过；独立对照全部通过项已核查最终候选覆盖。生产模型目录、默认值、路由实现均未改动。
