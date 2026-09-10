# 本体构建与 Claude 问数职责（当前实现）

平台负责数据接入、结构探查、关系核验、知识编辑、本体生成、版本管理与发布验证。Claude Code 负责理解问题、查阅业务知识、选择数据表、生成 SQL、判断是否需要澄清及撰写回答。

## 问数链路

1. 前端通过 `/api/query` 发起请求，平台验证用户和数据源权限并管理会话。
2. 平台为当前请求构造本体快照，正常问数使用已发布版本；评测可指定同一数据源的候选草稿。
3. Claude Code 通过请求级 MCP 调用 `ontology_read` 与 `db_query`。
4. 执行层检查只读 SQL、数据库范围、EXPLAIN 扫描预算、调用次数、超时和结果上限，保存实际执行回执。
5. Claude 返回本次请求的 execution ID；平台校验回执，向前端交付真实结果、图表、工具轨迹和审计信息。
6. 澄清保存在有期限的请求状态中，续答校验用户、数据源和会话；浏览器断开连接会取消当前执行。

前端的会话、SSE、澄清、结果表、图表、CSV 导出与审计保留。数据库账号权限是查询范围的最终边界，本体是业务参考，不再用规则式意图解析或本体映射限制 Claude 的 SQL 规划。

## 已移除

- 平台单发 SQL 规划器、语义 Query Plan 编译器和 Agent Loop。
- 规则式问题解析、问数检索规划、意图结果契约与零结果探测。
- 问数期间自动生成并确认口径的分支；业务知识仍通过本体编辑流程维护。
- 演示数据启动加载、演示答案和演示连接旁路。
- 旧引擎评测和灰度入口、自定义旧问数提示词与未使用的超时配置。

知识定义校验所需的字段、指标与枚举推导保留在 `server/src/knowledge-concepts.mjs`，不处理用户问数。

## 发布质量验证

每个用例执行一次经过同一执行护栏的 Gold SQL，再调用一次 Claude。比较真实结果，并拒绝把澄清或截断结果视为等价通过。门禁绑定数据源、本体版本、发布状态和评测集校验和。历史 off/prefer 门禁不能证明当前 Claude 链路可用，需重新运行。

已修复的衔接问题包括：评测使用指定草稿而非悄悄切换到已发布版本；Claude 失败原因和错误码丢失；门禁仍要求旧引擎证据；将候选结果错误地复制为基线指标；就绪检查因旧 mode 默认值跳过部署校验。

## 升级与验证

- 问数部署配置：`CLAUDE_QUERY_BINARY`、`CLAUDE_QUERY_MODEL`、`ANTHROPIC_API_KEY`。
- `QUERY_AGENT_MAX_SQL_CALLS` → `QUERY_MAX_SQL_CALLS`。
- `QUERY_AGENT_MAX_SCANNED_ROWS` → `QUERY_MAX_SCANNED_ROWS`。
- `QUERY_AGENT_PENDING_TTL_MS` → `QUERY_PENDING_TTL_MS`。
- SQLite 中已保存的旧预算自动迁移；已有新配置优先。环境变量仍需按上述名称更新。
- 移除旧 planner mode / traffic 参数；`CLAUDE_QUERY_MAX_BUDGET_USD=0` 暂停问数。
- `npm run claude:preflight -- --local-only` 只检查部署前置条件；不加 `--local-only` 会执行一个小型模型请求。
- `npm run check` 运行类型检查、lint、构建、服务端回归与页面渲染验证。

生产效果仍需使用业务审核的 Gold SQL 集，在实际 Claude 服务和只读 MySQL 上评估。优先补充会改变结果的实体定义、时间字段、指标口径、关系与反例，再用固定评测集衡量修改效果。
