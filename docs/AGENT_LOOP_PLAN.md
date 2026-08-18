# 问数 Agent Loop（Harness + 工具循环）实施计划

> 2026-08-18：Loop V2 的意图保真、字段归属、结构化错误、重复动作、结果完整性与新门禁方案见 [QUERY_LOOP_V2_IMPLEMENTATION_PLAN.md](./QUERY_LOOP_V2_IMPLEMENTATION_PLAN.md)。

> 基线：当前 `query-service.mjs` 单发管道（检索 → 一次 LLM 规划 → 护栏 → 执行 → 总结，固定 3 次盲重试）；目标：引入确定性 Harness + 模型驱动的工具调用循环，使模型可以自主查结构、采样、试跑、修正、澄清，并把每一步过程展示给用户。开始日期：2026-08-13。

## 实施进度（2026-08-13）

- A0–A3 已完成：JSON 动作 Harness、全部只读工具、预算与 SQL 绑定、采样/大结果透传、SSE 时间线、可中止执行、审计回放，以及 `ask_user` pending/TTL/恢复/内容护栏和前端澄清卡片均已落地并有回归测试。
- A4 代码已完成：`prefer` 先走单发 fast path，规划器通过 `needsExploration` 自报，或单发链路首次触发确定性护栏、EXPLAIN、执行失败时立即升级 Agent；新增 Agent vs 单发 Gold SQL 对照门禁，统计通过率、P95 延迟、token、迭代、工具成功率、澄清率与预算兜底率。
- 当前默认仍为 `QUERY_AGENT_MODE=off`。仓库内的确定性门禁测试已通过，但尚未在目标真实数据源和正式评测集上取得生产门禁证据；只有实际门禁返回 `enable_agent_prefer` 后才应改默认值。
- 复查修复（2026-08-14）：pending loop 过期条目在新提问入口惰性清扫，不再常驻内存；`needsExploration` 出口只在 Agent 可升级（prefer 且未尝试）时提供给单发规划器，off 模式收到时反馈引导直接生成 SQL、重试仍坚持则安全拒答；会话详情接口对存活的 pending 澄清返回 `pendingClarification`（问题 + 澄清响应 + 工具轨迹），前端刷新后可还原澄清卡片与时间线继续回答。

## 设计原则

1. **Harness 说了算**：消息历史、工具分发、护栏、预算、截断、审计、终止全部由确定性代码执行；模型只能通过白名单工具行动，没有任何 raw DB 通道。
2. **护栏不下放**：所有触库操作必经 `guardSql`（表/列白名单、已确认 JOIN、枚举字面量）+ EXPLAIN 阈值；敏感列在 `get_schema` 层即不可见。覆盖域外（`coverage === "none"`）在进入循环前硬拒答，不交给模型判断。
3. **出口必须结构化**：`submit_answer` / `refuse` 是循环唯二出口；`submit_answer` 引用的 SQL 必须与本轮某次成功 `run_sql` 的哈希匹配，杜绝报告未执行过的 SQL。
4. **上下文有界**：工具结果按行数/字节截断后回填；中间探索数据（采样、失败查询结果）循环结束即丢弃，不落会话、不落审计。
5. **成本分层**：简单问题走现有单发管道 fast path；护栏失败或需要探索时才升级 agent loop。多数问题不付多轮调用的延迟成本。
6. **渐进可回退**：新增 `QUERY_AGENT_MODE=off|prefer|required`，与 `SEMANTIC_QUERY_PLAN_MODE` 同构；`prefer` 下 loop 失败/超预算回退单发管道。评测门禁通过前不默认开启。

## 架构

```
用户问题 → 前置硬检查(LLM配置/覆盖域) → fast path 或 Agent Loop:
  ┌─→ LLM 决定动作(带 thought) ─→ Harness 执行工具(护栏内) ─→ 截断回填 + SSE 推送 ─┐
  └───────────── 直到 submit_answer / refuse / ask_user 挂起 / 预算耗尽 ←──────────┘
→ 审计(toolTrace) + 结构化答案
```

## 工具集

全部只读、有界，复用现有模块：

| 工具 | 行为 | 复用 | 终止 |
|---|---|---|---|
| `search_context` | 关键词检索知识页、术语、规则 | `knowledge-retrieval` + `embedding-index` | 否 |
| `get_schema` | 指定表的字段/关系/枚举；敏感列不返回 | `store` | 否 |
| `sample_data` | 指定表列采样 ≤20 行，走护栏；用于确认取值格式 | `sql-guard` + `connector` | 否 |
| `run_sql` | 单条 SELECT：`guardSql` → EXPLAIN 阈值 → 执行 → 截断回填 | 现有全套护栏 | 否 |
| `validate_semantic_plan` | 编译语义 Query Plan（semantic 模式可选） | `semantic-query-plan` | 否 |
| `ask_user` | 挂起循环，向用户提出口径澄清问题 | — | 挂起 |
| `submit_answer` | 提交结论 + 最终 SQL（须匹配成功执行哈希） | — | 是 |
| `refuse` | 说明无法回答的原因 | — | 是 |

## 预算与终止

- 迭代上限 8–10 步；整轮耗时预算（扩展 `queryLlmTimeoutMs` 语义）；`run_sql` ≤ 5 次；累计 EXPLAIN 扫描行预算。
- 预算将尽时 Harness 注入系统消息强制下一步 `submit_answer`/`refuse`；仍不收敛则兜底：有成功 SQL 就以其结果收尾，否则拒答。
- SSE 连接断开 → AbortSignal 中止循环，停止消耗 token。

## 结果回填策略

SQL 结果必须回填上下文（自我修正与结论生成都依赖它；现有 `summarize` 已回填 ≤100 行，非新增暴露面），但严格截断：

- 元信息全量：列名、类型、总行数、耗时。
- 数据行截断：`run_sql` 回填前 30–50 行 + 总行数说明；`sample_data` 仅 10–20 行。
- 单元格截断：长文本 ≤200 字符。
- 大结果集透传：明细类查询模型只看行数和列名写结论，行数据沿现有 `answer.rows` 通道直达前端，不经 LLM。
- 敏感数据天然隔离：敏感列在白名单层已拦截，SELECT 不出即进不了上下文。

## ask_user 澄清机制

**挂起**：模型调用 `ask_user({question, options?, allowFreeText})` → Harness 保存 pending loop（消息历史、工具轨迹、已耗预算），返回新响应形态 `{clarification: {pendingId, question, options}, sessionId}`。

**恢复**：`POST /query` 增加可选 `pendingId`；带 pendingId 的请求把用户输入作为 tool result 回填、从断点续跑，预算延续不重置。同会话新问题直接作废 pending loop。

**存储与过期**：内存 Map + TTL（10 分钟），每会话最多 1 个 pending。不落 SQLite——循环状态含中间结果数据，落盘违反"会话不保存结果数据"原则。

**防滥用**（比机制更重要）：

1. 每轮问答最多 1 次 `ask_user`（Harness 强制，超出即报错回填）。
2. assumption-first：有合理默认口径时直接按默认回答并在结论中声明假设；`ask_user` 仅用于分支结果实质不同且无明显默认的情况。
3. 先探索再问：prompt 要求先用 `search_context`/`sample_data` 自行消歧。
4. 问题内容护栏：Harness 校验问题文本不含 SQL、表名、敏感列名——问的是业务口径，不是技术细节。

**复利**：澄清结论摘要（如"收入=净收入"）写入 session planning history，同会话追问自动沿用口径，不重复问。

## 过程展示（SSE + 步骤时间线）

**传输**：`/query` 新增 SSE 分支（`Accept: text/event-stream`）；降级备选为现有 `BackgroundTask` 轮询。

**事件协议**（Harness 是唯一发射方）：

```
step | thought | tool_call | tool_result | clarification | final | refused
```

每事件携带 Harness 生成的展示层摘要，不透传原始参数/结果。每工具展示白名单：

| 工具 | 展示 | 不展示 |
|---|---|---|
| `search_context` | 命中页面标题、术语名 | 正文、向量细节 |
| `get_schema` | 表名 + 字段数（可展开） | — |
| `sample_data` | 采样了哪表哪列 + 一句结论 | 采样行数据 |
| `validate_semantic_plan` | Ontology 版本 + 确定性编译结果摘要 | 物理映射、中间校验细节 |
| `run_sql` | SQL 全文、行数、耗时；失败时护栏原因 | 中间结果行数据 |

SQL 全文展示与现有 `evidence.sql`/`attemptedSql` 口径一致。

**思考过程**：不透传原始 CoT。动作协议每步必填一句面向用户的 `thought`（中文、一句话），Harness 截断 + 过滤（无 key/token 模式）后推送。

**前端**：答案卡片上方渲染步骤时间线——进行中 spinner + thought；完成折叠为一行（工具名 + 摘要 + 耗时），可展开；回答完成后整体折叠为"共 N 步，用时 X 秒"。失败步骤标红原因（让用户看得到护栏在工作）。`ask_user` 卡片是时间线中的特殊节点，回复后新 SSE 流续接同一时间线。

**留存**：展示层事件序列存入审计 `toolTrace`（不含中间结果行数据）；`QuerySessionDetail` 从审计回放，刷新后历史时间线仍可查看。

## LLM 客户端扩展

新增 `callLlmTools(llm, messages, tools, options)`：

- 首选实现：JSON 动作协议——沿用 `response_format: json_object`，模型返回 `{"thought":"...","tool":"run_sql","args":{...}}`。与现有 `callLlmJson` 行为一致，dashscope 等网关兼容性最稳。
- 增强：OpenAI 原生 function calling，tools schema 中每工具加必填 `thought` 参数；按 provider 能力自动选择。

## 审计与会话

- `addAudit` 增加：`planningMode: "agent"`、`iterations`、`clarificationCount`、`toolTrace`（每步工具名、参数哈希、耗时、展示摘要）；新增 verdict `"clarified"`。
- 会话延续现有做法：仅（问题、最终 SQL、结论摘要、澄清口径）入 planning history；探索过程数据不落。

## 阶段与出口条件

### A0｜Harness 骨架与 JSON 动作协议

- `callLlmTools`（JSON 动作协议路径）、Harness 主循环、预算控制、`get_schema`/`search_context`/`run_sql`/`submit_answer`/`refuse` 五工具。
- `QUERY_AGENT_MODE=prefer` 下失败回退单发管道；`off` 时行为与现状完全一致。
- 审计写入 `planningMode:"agent"`、`iterations`、`toolTrace`。
- 出口：真实数据源上一个多步问题（首次 SQL 被护栏拦截后修正成功）可完整走通并留有轨迹；`off` 模式回归测试全绿。

### A1｜采样与结果回填收敛

- `sample_data` 工具；`run_sql`/`sample_data` 行数、字节、单元格三级截断；大结果集透传模式。
- 强制 submit SQL 哈希匹配；预算耗尽兜底路径。
- 出口：长文本表、千行结果集下上下文不膨胀（有截断断言测试）；submit 未执行 SQL 被拒绝的用例通过。

### A2｜SSE 过程展示

- `/query` SSE 分支 + AbortSignal 中止；事件协议与每工具展示白名单；`thought` 必填与过滤。
- 前端 `askQuestion` 改 SSE 消费；步骤时间线三态组件；`QuerySessionDetail` 从 toolTrace 回放。
- 出口：提问可实时看到逐步过程，断开连接后服务端循环终止；刷新页面历史时间线可查看；非 SSE 客户端仍可用一次性 POST 结果。

### A3｜ask_user 澄清

- `ask_user` 工具、pending loop 内存存储 + TTL、`pendingId` 恢复、每轮 1 次上限、内容护栏。
- 前端澄清卡片（选项 chips + 自由输入）、时间线续接；澄清口径入 planning history。
- 审计 `clarified` verdict 与 `clarificationCount`。
- 出口：歧义口径问题（如"上个月收入"）触发澄清 → 回答 → 续跑得出正确结果；同会话追问不重复澄清；TTL 过期与新问题作废路径有测试。

### A4｜评测门禁与默认开启

- fast path 升级判据调优（护栏失败/模型自报需探索时升级）。
- `eval/run`、`eval/gate` 跑 agent vs 单发管道的 Gold SQL 对比；统计迭代数、token、延迟分布。
- 出口：agent 模式 Gold SQL 通过率 ≥ 单发管道，且 P95 延迟与成本在可接受阈值内；达标后 `prefer` 设为默认，否则保持 `off` 并记录差距。

实施说明：评测中心已增加“运行 Agent 门禁”，统一入口为 `POST /api/eval/gate` + `gateKind: "agent"`（旧 `/api/eval/agent-gate` 保留兼容）；普通 `POST /api/eval/run` 可显式选择 `queryAgentMode: off|prefer|required`。候选组强制使用 `required`，避免配置中的回退掩盖 Agent 真实表现；基线组强制使用 `off`。每次运行持久化 Agent 执行、迭代、工具调用/成功、澄清、预算兜底和 token 指标。门禁要求结果等价率不低于基线，并同时校验 P95 延迟、token usage 覆盖与成本、工具成功率、澄清率和预算兜底率。真实评测尚未运行，因此本阶段的“默认开启”出口条件仍未满足，默认值保持 `off`。

### 本轮验证证据

- `npm run check` 全量通过：lint、生产构建、92 个服务端测试、1 个服务端渲染测试均无失败。
- `prefer` fast path、首次护栏失败升级、Agent 失败回退、预算收尾、大结果透传、混合检索、澄清恢复、SSE 中止/回放均有回归断言。
- `validate_semantic_plan` 已端到端覆盖：发布 Ontology → 对象/属性计划 → 确定性 SQL → 策略绑定执行 → answer/audit 语义证据。
- Agent 门禁 API 已覆盖真实数据源形态的后台任务、off-vs-required 对照、token 缺失拒绝开启及运行指标持久化；目标数据库正式 Gold 集仍需由部署环境执行。

## 风险与代价

- **延迟与 token**：一个问题 3–8 次 LLM 调用。缓解：fast path 分层（A4 调优）、严格截断、预算硬上限。
- **网关兼容**：部分网关 function calling 不稳。缓解：JSON 动作协议为首选路径，原生 tool calling 仅作增强。
- **pending loop 单实例限定**：内存存储在多实例下失效。与现有"本地单实例基线"一致，分布式属后续扩展。
- **模型滥用 ask_user / thought 泄漏**：Harness 硬上限 + 内容护栏 + 展示白名单兜底，不依赖 prompt 自觉。

## 明确不做

- 模型直连数据库或绕过 `guardSql` 的任何通道。
- 原始 CoT 透传给用户。
- 中间探索数据（采样行、失败查询结果）落 SQLite 或会话。
- pending loop 持久化与跨实例恢复。
- 覆盖域判定交给模型。
