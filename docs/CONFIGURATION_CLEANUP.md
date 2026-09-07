# 配置清理（2026-09-05）

本次删除没有实际消费者的配置，并按真实用途整理设置中心。没有下线仍用于兼容问数、评测和本体发布门禁的旧引擎。

## 删除项

| 配置 | 根因 | 清理位置 |
| --- | --- | --- |
| `retrieval.topK` / `RETRIEVAL_TOP_K` | UI 和设置 API 可以保存，但检索调用从未传入该值，实际一直使用检索器自己的分页参数 | 环境加载、默认示例、设置定义、运行配置、前端类型/表单/提交参数；启动和重载时删除历史数据库记录；旧客户端提交返回 400 |
| `RETRIEVAL_CONCEPT_ALIASES_JSON` | 环境值在设置服务构造 `retrieval` 视图时被覆盖，应用问数链路实际无法读取 | 删除环境入口和两处空值透传；业务术语自身的别名和检索器独立的别名能力保留 |
| 数据库中的 `claudeQuery.binary/model/promptVersion` 覆盖记录 | 这些字段由部署环境固定，数据库记录一直被忽略 | 启动/重载时删除无效覆盖；API 仍展示真正的部署值，并拒绝在线修改 |

未知设置分组也返回 400，避免已删除或拼错的配置被静默接受为“保存成功”。校验通过之前不执行任何设置写入。

## 保留项的实际用途

| 配置 | 消费者 |
| --- | --- |
| `claudeQuery.*` | Claude 路由、模型标识、超时、轮数、费用预算、并发、排队和输出大小 |
| `queryAgentMaxSqlCalls / queryAgentMaxScannedRows / queryAgentPendingTtlMs` | Claude 和旧 Agent 共用的 SQL 次数、累计扫描预算、ASK 有效期；历史键名保留，避免丢失线上值 |
| `queryMaxRows / explainMaxRows / queryTimeoutMs` | 查询执行内核、SQL 连接器 |
| `llm.*` | 本体生成、关系发现、知识建议，以及兼容问数/评测 |
| `queryLlmTimeoutMs` | 知识建议与兼容规划；Claude 请求使用 `claudeQuery.timeoutMs` |
| `embedding.* / retrieval.vectorEnabled` | 知识索引、本体候选语义匹配，以及兼容检索 |
| `semanticQueryPlanMode / queryAgentMode / queryAgentTrafficPercent / queryAgentMaxIterations` | 兼容问数与评测；评测服务仍显式关闭 Claude 后调用这些引擎 |
| `retrieval.vectorWeight / minSimilarity / semanticThreshold` | 兼容引擎的词法/向量融合检索，不控制 Claude MCP 知识读取 |
| 五个 `prompts.*` | 旧 Agent、SQL/语义规划及结果总结，不参与 Claude 提示词构建 |
| `metricProposalEnabled` | 兼容问数中的指标建议拦截 |
| 本体 AI、画像、关系发现、枚举发现参数 | 本体生成/校准、数据发现、列值画像；画像参数现已改为每次探查开始时读取，对下一轮构建生效（见 SOURCE_ONTOLOGY_WORKFLOW.md） |
| `system.*RuleVersion` | 目录迁移标记，不属于问数功能开关，不能按未知配置批量清除 |

设置中心默认展示本体/知识、Claude 和共享执行参数；兼容参数与五个提示词放在明确标注用途的独立分类。保存只提交当前分类。修正旧的“全部配置即时生效”“脱敏画像”“LLM 控制 Claude SQL”说明。

2026-09-05 本体构建设置继续精简：确认方式支持管理员直接启用按分数自动确认，默认阈值 85；质量校准不再是该配置的前置条件。取消自动确认模式下保存普通参数必须先切回人工确认的限制。批次与超时保留实际消费者和 API 配置能力，页面折叠为高级设置；画像关闭时隐藏采样细项，质量校准参数独立折叠。没有改变 Claude 的 SQL 次数预算。

验证：后端 573/573、服务端渲染 1/1、前端构建、修改文件 lint 与 diff 空白检查通过。迁移测试覆盖历史记录清除、有效密钥/预算/迁移标记保留、无效提交原子拒绝。未进行新的业务数据或模型回放。

## 生产验收

- 目标：39.107.117.246；未操作 39.96.34.126。
- 镜像：`sha256:2b25e203d96ca97b786b7fa070dd8aa1195c2188a8870f56a52adbc03c7a954a`。依赖与上一镜像的 package.json/package-lock.json 校验一致，复用已运行依赖后重新构建前端。
- 备份：`/home/ecs-user/ontoquery-backups/settings-cleanup-20260905T094101Z`，含源码/环境配置、加密设置记录、构建日志和源码清单；回退镜像标签 `ontology-query-platform-ontoquery:settings-cleanup-backup`。
- 设置数据库仅删除 `retrieval.topK`；其余 46 项记录（包括加密密钥）逐值比对完全一致。GET 设置 API 不再返回 Top K；Claude required、glm-5.2-fast-preview、SQL 上限 5 不变。
- 90 个运行源码哈希与本地一致。容器健康、网页/API/ready 均返回 200；实际 Nginx 资源 `/_next/static/chunks/platform-app-DtkRCGmn.js` 与新镜像一致，含兼容分类、按分类保存且不含 Top K 控件。
- 发布前根分区满导致上传失败，仅清除未使用的 Docker 构建缓存回收约 3.3 GB；业务数据、所有运行/回退镜像及源码备份保留。发布后可用空间约 2.3 GB。
- 未执行 git commit。
