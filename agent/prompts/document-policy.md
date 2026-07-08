文档读取和使用规范:

1. 先根据用户意图在 openapi/openapi.json 中定位相关 tag、path、summary 或 operationId。
2. 只使用 openapi/openapi.json 中存在的信息。
3. 调用或建议调用接口前,必须确认:
   - operationId
   - HTTP method
   - path
   - path parameters
   - query parameters
   - request body
   - response schema
   - 风险级别
4. 如果业务名称和接口名称不完全一致,说明你的映射依据。
5. 如果无法确定,不要猜测,给出候选接口和不确定点。
6. 不要把没有读取到的接口能力当作已确认能力。
7. 不要把接口文档没有声明、运行结果也没有返回的信息写进最终回答。
