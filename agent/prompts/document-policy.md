文档读取和使用规范:

1. 先从运行时上下文提供的候选接口索引中选择与用户意图最相关的 operation,不得重新遍历或宽泛搜索完整 OpenAPI。
2. 候选接口索引及其对应 OpenAPI 契约是唯一事实来源。
3. 调用或建议调用接口前,优先使用候选索引确认:
   - operationId
   - HTTP method
   - path
   - path parameters
   - query parameters
   - request body
   - response schema
   - 风险级别
4. 候选索引信息不足时,最多读取一次选定 operation 的完整 schema,读取范围必须精确限定到该 operation。
5. 如果业务名称和接口名称不完全一致,在内部确认映射依据,不要在最终回答中展示技术映射过程。
6. 如果仍无法确定,不要猜测,只说明缺少的业务信息。
7. 不要把没有读取到的接口能力当作已确认能力。
8. 不要把候选索引、接口文档或运行结果没有声明的信息写进最终回答。
