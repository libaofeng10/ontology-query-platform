# HTTP API

默认地址：`http://localhost:8787/api`

除 `/health`、`/ready` 和 CORS 预检外，所有请求都必须带 `Authorization: Bearer <token>`。身份角色和数据源范围由 `API_IDENTITIES_JSON` 配置；限流响应为 `429` 并带 `Retry-After`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/ready` | SQLite 就绪检查 |
| GET | `/bootstrap?sourceId=1` | 工作台初始数据 |
| GET / POST | `/sources` | 数据源列表 / 新建 MySQL 数据源 |
| POST | `/sources/:id/test` | 连接和物理只读校验 |
| POST | `/sources/:id/credential` | 管理员轮换加密凭据并关闭旧连接池 |
| POST | `/sources/:id/discover` | 创建持久化异步探查任务（202） |
| GET | `/sources/:id/discovery` | 探查摘要 |
| GET | `/tasks?sourceId=1`、`/tasks/:id` | 任务列表 / 进度与结果 |
| GET | `/questions?sourceId=1` | 待决问题 |
| POST | `/questions/:id/answer` | 回答问题并写回关系/规则/wiki |
| POST | `/query` | 自然语言问数 |
| GET / POST | `/knowledge` | 知识页列表 / 保存并写 Markdown |
| POST | `/knowledge/sync` | 将人工 Markdown 变更校验后回灌 SQLite |
| GET | `/graph?sourceId=1` | 当前数据源的发布版业务对象、物理表、知识节点、映射/语义/JOIN 关系和统计 |
| GET | `/ontology/schemas?sourceId=1` | 业务对象 Schema 版本历史与校验摘要 |
| GET | `/ontology/catalog?sourceId=1` | 结构化建模可选的表、字段和物理 JOIN 目录 |
| GET | `/ontology/schemas/:id` | 业务对象 Schema 完整版本 |
| GET | `/ontology/schemas/:id/diff?against=:baseId` | 比较同一数据源的两个 Schema 版本 |
| GET | `/ontology/published?sourceId=1` | 当前已发布的业务对象 Schema |
| POST | `/ontology/validate` | 针对最新物理元数据校验 Schema，不保存 |
| POST | `/ontology/schemas` | 保存不可变 Schema 草稿版本 |
| POST | `/ontology/schemas/:id/publish` | 重新校验并发布 Schema；无效时返回 422 |
| POST | `/ontology/generation-scope` | editor 按服务端当前表/字段预算预览批次、截断和关系过滤，不创建任务 |
| GET / POST | `/ontology/generation-runs` | 查询或创建 AI 本体候选生成批次 |
| GET / POST | `/sources/:id/relation-docs` | 列出或上传 Markdown/纯文本关系文档；通过断言只生成 `review` 关系 |
| POST | `/ontology/calibration/threshold/adopt` | 人工采纳当前逐数据源自动确认阈值建议并写入审计记录 |
| GET | `/ontology/generation-runs/:id/traces` | editor 查看受限的模型调用审计摘要 |
| GET | `/ontology/generation-runs/:id/traces/:file` | editor 按需查看完整 Prompt 与模型原始输出 |
| GET | `/ontology/candidates?sourceId=1&runId=:run` | 查询候选、评分与校准标签 |
| GET | `/ontology/candidates/:id/events` | 查看候选追加式状态与校准时间线 |
| POST | `/ontology/candidates/:id/decision` | editor 确认、拒绝或撤回候选 |
| GET | `/ontology/calibration?sourceId=1` | 获取真实源校准报告、评测集 Gold/Held-out 完整度与发布后门禁证据 |
| POST | `/ontology/calibration/gates` | editor 固化当前校准门禁快照 |
| POST | `/ontology/calibration/gates/:id/activate` | admin 复验快照后启用 `auto_draft` |
| POST | `/eval/cases` | 新建评测用例 |
| POST | `/eval/cases/:id` | 更新评测用例 |
| POST | `/eval/cases/:id/archive` | 软归档评测用例 |
| POST | `/eval/import` | 批量导入 1–500 条 JSON 用例；正式清单可传 `manifestStatus=approved` 与 `minimumCases`，接口会校验审核/规模并幂等处理完全相同的用例 |
| POST | `/eval/run` | 创建异步结果等价评测任务（202） |
| POST | `/eval/gate` | 创建语义或 Agent 对照门禁；语义门禁固化 Schema 版本、发布时刻和评测集校验和 |
| GET | `/eval/runs?sourceId=1` | 评测运行明细和修复建议 |
| GET | `/audits?sourceId=1` | 审计记录 |

新建数据源请求体：

```json
{"name":"只读副本","host":"127.0.0.1","port":3306,"dbName":"billing","userName":"ontoquery_ro","password":"..."}
```

问数请求体：

```json
{"sourceId":1,"question":"今年每月有效客户数","sessionId":"可选会话 ID"}
```

Held-out 用例的 Gold SQL 仅供服务端评测执行器读取，不会从 bootstrap、用例列表或新增/更新响应返回。

语义 `/eval/gate` 响应和持久化记录包含 `ontologySchemaVersion`、`ontologySchemaPublishedAt` 与 `evaluationChecksum`。草稿发布保护允许发布时刻为空；AI 本体校准只接受发布时刻与当前发布版本完全匹配、评测集校验和仍然有效且候选组确实进入 `prefer` 语义计划的发布后门禁。

`/ontology/calibration` 的 `evalSets` 只返回评测集名称、总数、已有 Gold SQL 数、Held-out 数和 `ready` 标记，不返回 Gold SQL 内容。前端只有在试点草稿仍为当前发布版本且所选评测集 `ready=true` 时，才允许直接调用 `/eval/gate` 并轮询后台任务；任务成功后重新读取校准报告，而保存与启用门禁时服务端仍会再次验证证据新鲜度。

业务对象 Schema 的写接口要求 `editor` 或更高角色。草稿允许带校验错误保存；发布时会重新检查对象、属性、主键、物理字段映射、关系端点和已确认 JOIN。发布新版本后，同数据源的旧发布版本自动转为 `deprecated`。完整契约与示例见 [`ONTOLOGY_OPTIMIZATION_PLAN.md`](./ONTOLOGY_OPTIMIZATION_PLAN.md)。

`/graph` 只读取当前 `published` Schema，不展示未发布草稿。返回的业务对象节点带属性及字段映射摘要，语义关系使用 `semantic` 边，对象到表的映射使用 `mapping` 边；没有发布版本时仍返回真实物理图谱。

`/ontology/catalog` 只返回建模所需的结构元数据，不返回数据库凭据或字段值。Diff 将变化分为 `compatible / review / breaking`；删除定义以及主键、类型、物理映射和关系端点变化会标记为 `breaking`。

`/ontology/generation-scope` 与实际创建批次复用同一个范围构建器和运行时配置。响应给出 `limits`、批次与字段计数、超宽表截断数、批内/跨批确认关系数，以及因敏感或失效端点被过滤的关系数；空 `tableNames` 可用于只读取当前预算。
