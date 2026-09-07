# Claude 接入重建交接

最新流程整合（2026-09-05，已上线）：数据源、探查与独立业务对象建模入口合并为“数据源与本体”。一次选表后台连续完成探查与生成，持久化阶段检查点并固定选表范围；同页确认候选、查看和修正本体、启用问答，版本历史与分域维护保留为高级操作。后端 578/578、构建、修改文件 lint、渲染测试通过，158 个运行/测试/依赖文件哈希匹配。镜像 `sha256:096f47bec8bcdecb5e46f88ac7ff529dced8523ede5a3e4b26e01e03cbb66c22`，正式 Nginx 新页面/资源、状态 API 和 health/ready 均为 200。既有设置与本体全量哈希一致，生效 id 12 / v11、Claude required / glm-5.2-fast-preview / SQL 5 不变。备份在数据盘 `/data/ontoquery-releases/source-workflow-20260905T115420Z`，详见 [统一流程交接](SOURCE_ONTOLOGY_WORKFLOW.md)。未启动真实模型重建，未执行 git commit。

最新运维变更（2026-09-05，已完成）：39.107.117.246 的 Docker / containerd 存储分别迁到 `/data/docker`、`/data/containerd`，systemd 增加数据盘挂载依赖。系统盘由 94% 降为 11%（可用 34G），数据盘使用 35G、可用 66G。原镜像、容器、环境、业务挂载、设置、知识与历史保留，网页/API/ready/Claude CLI 检查通过。回退副本、业务文件备份和切换日志位于 `/data/ontoquery-storage-migration-20260905`，系统盘已停用副本经比对后清理。两次验收回退和最终结果见 [存储迁移交接](DOCKER_DATA_MIGRATION.md)。应用源码及查询行为没有变更，未执行 git commit。

最新配置清理（2026-09-05）：删除无效的 Top K、未接通应用链路的环境概念别名，以及数据库里被忽略的 Claude 部署字段覆盖记录；设置中心按 Claude/共享参数与兼容引擎/评测区分，保存只提交当前分类。保留仍有消费者的 LLM、Embedding、旧评测配置和共享 SQL/ASK 限制。后端 573/573、渲染 1/1、构建和修改文件 lint 通过。详细依据见 [配置清理](CONFIGURATION_CLEANUP.md)。已发布到 39.107.117.246，镜像 `sha256:2b25e203d96ca97b786b7fa070dd8aa1195c2188a8870f56a52adbc03c7a954a`；仅删除线上 `retrieval.topK` 一条记录，其余 46 项设置逐值一致。Claude required / glm-5.2-fast-preview / SQL 5 保持不变，90 个运行源码校验和一致，Nginx 网页、API、就绪检查及新版设置页面资源均为 200。备份位于 `/home/ecs-user/ontoquery-backups/settings-cleanup-20260905T094101Z`。发布前发现根分区已满，仅清理未使用的 Docker 构建缓存释放约 3.3 GB，当前剩余 2.3 GB；运行与回退镜像、业务数据均保留。未执行 git commit。

最新改动（2026-09-04，已发布并验收）：按用户明确要求，Claude 链路移除表列白名单、已确认 JOIN 和先读取结构三项拦截。MCP 不再拒绝未登记表或未读取表；query-service 为 Claude 选择内核 database 模式，本体与知识只提供语义，不再兼任 SQL 权限。SQL 的实际字段和关联有效性由数据库执行结果及 Claude 自行修正。快照提供当前数据源已采集的完整物理目录，不再按本体属性、知识引用、表等级或 active 状态裁剪；新增 `get_tables`，`get_objects` 支持物理表名与 query，关系仍可作为参考。物理表读取同时返回对应业务对象和已验证知识索引，概览列出全部知识索引，避免放开拦截后仅凭物理表名选择相似产品。系统提示词与 Claude Skill 已同步。旧规划器保留原校验，不添加平台意图解析、字段覆盖检查或敏感列限制。完整后端 572/572、无跳过；SQL 上限保持 5，不修改本体版本或知识。

最终镜像为 `sha256:f411e22a5c705117d474e53bae33ff6c7c2f6dff962d3b4943a4d76a6d05296d`。正式 Nginx SSE 回放原问题成功：会话 `0e154b72-db83-41c6-ac91-6946554cd8ba`、审计 142，3 个工具步骤、1 次 SQL、0 失败，17.959 秒完成；使用 `alpha_account_user` 与 `alpha_account_user_business_details`，未走 Alpha 用户路径，返回 1 行完整结果，包含 `WRITING_GPT` / 文书起草和消耗额度 9。工具过程已持久化为 3 步，审计 `intent_json` / `retrieval_trace_json` 均为空。运行配置仍为 `required / 100%`、`glm-5.2-fast-preview`、SQL 上限 5，网页与 API 均为 200，9 个关键运行文件 SHA256 与本地一致。未执行 git commit。

首次发布镜像 `sha256:bd105b5afb4bddd2266c25764fd7dc77ecdc7ea41c409c06bbcaf8d9cd88da43` 已移除三项拦截，但新 `get_tables` 当时只返回物理字段，丢失业务对象和知识背景。原问题回放因此再次误入 Alpha 路径并耗尽预算（会话 `acbbaf19-eea4-4449-92e5-8f1c27ee2542`、审计 141），未作为验收通过。最终版本从工具契约根部补回业务上下文后才完成验收；没有增加 GPT 专用路由、关键词选表或平台意图前置判断。

更新：2026-09-04。Claude 直接问数、浅色问答页及手机号查询 GPT 使用情况修复已发布到 39.107.117.246。当前本体 id 12 / version 11，最新回放通过正式 Nginx SSE 使用 4 个工具步骤、2 次 SQL 完成，全部成功，23.950 秒返回结果；使用 AlphaGPT 账号、额度明细及日统计表，结果和过程已保存。平台意图解析和字段覆盖前置判断仍未启用，审计 intent_json / retrieval_trace_json 为空。最新正常设置 API 读到 Claude 为 required / 100%，模式来源 db，本轮没有修改路由设置；SQL 上限仍为 5。容器及网页/API 健康，后端 566/566，未执行 git commit。

根因诊断补充：上述原句验收不能证明所有业务结论可靠。后续合成回放发现，即使字段齐全且仅执行一次 SQL，平台仍接受由 Alpha 空结果推导的“没有 GPT 使用记录”。语义映射兼任列授权及 `get_objects` 忽略 query 已在最新改动中消除；自由文本结论的业务正确性仍由 Claude 判断。证据和改造边界见 [Claude 问数根因诊断](CLAUDE_QUERY_ROOT_CAUSE.md)。

## 已完成

- `server/test/claude-query-integration.test.mjs` 的 15 项契约全部通过，包含直接读取本体、无映射表列与未登记 JOIN、无需先读结构、Claude ASK 续答、回退、预算/模型检查、关闭行为、可信执行注册表和异常保留。
- 用户已明确要求移除敏感列限制。手机号等字段和字面值正常通过，旧交接中的脱敏、字段剔除及 typed-literal 拒绝要求已失效。
- 补齐遗漏的敏感列过滤移除：知识引用、结果探针、画像、候选生成/评分/校验、关系文档与模型、指标提议、术语导入、Claude MCP/快照及界面。保留历史数据库标记和兼容响应字段，但不能以此限制查询或模型生成。
- 修复知识硬冲突的包含匹配误判：对象名称不能仅因是属性名称的前缀就构成映射冲突。明确的同名属性或结构化映射冲突仍然生效。
- 修复 Alpha / AlphaGPT 规则混用、通用账号表抢占已确定产品根表、跨表同名机构字段覆盖直接字段的问题。过滤器执行范围来自实际绑定字段。
- “用户”识别为账号；机构专名中的“律师事务所”不再触发独立业务规则。
- 对包含律所专名、“这套系统”和唯一未标注 opaque ID 的问题，将 ID 绑定到已发布的律所 ID 属性。已明确字段的 ID 不重新解释；无发布映射或多个未标注 ID 时要求澄清，不能丢弃 ID。
- 补齐旧 `ontology-domain-plan.test.mjs` 的 store stub（`excludedTableNames` 返回 Set），原先的 4 个失败用例恢复通过。
- 修复 query-service 到快照的 context 参数及到内核的 columns 参数；快照直接复用 `buildQueryResultContract`，将必需主体、物理字段绑定、执行有效性条件提供给初始提示词和 `ontology_read overview`，避免深度裁剪丢失约束。Claude 提示词补充 SQL 前逐项核对步骤和失败调用消耗预算的说明。
- 实测 GLM 在只有一个执行结果时返回单个 ID 字符串。bridge 将数组、JSON 数组字符串、单个 ID 字符串归一化，再核验 ID 格式、去重及当前请求注册表。重复、畸形和未登记 ID 的拒绝测试通过。

## 问答页优化

- 浅色主题已发布至 39.107.117.246：全局采用白色/浅灰背景、深色文字和青绿色强调色；侧栏、会话记录、消息气泡、输入框、ASK 选项、工具 SQL、结果表格及图表同步适配。颜色集中为 CSS 变量，清理旧深色背景和浅色文字常量；主次文字、强调色和状态色在相应浅色背景上的静态对比度均达到 4.5:1。构建、服务端渲染 1/1 和修改的图表文件 lint 通过。本次仅调整配色，不修改查询逻辑或服务器设置。容器健康，网页和 API 均为 200；样式及图表源码 SHA256 与本地一致，Nginx 实际加载的 `/_next/static/css/layout.CzunC8zW.css` 已验证包含浅色主题。
- 问数工作台改为 AI 问答：连续消息、左侧会话记录、底部固定输入框，回答不再使用结果卡片；结果表格和图表直接随消息展示，查询依据可展开。
- 工具过程修复：query-service 将请求级 `onEvent` 传给 MCP，在 `ontology_read` / `db_query` 真正开始及结束时发送 SSE。记录工具名、操作、SQL、结果条数、耗时和失败原因；并发调用使用独立步号，历史按发起顺序保留，客户端断开不改变执行结果。bridge 保留工具 SQL，不再只留 hash。
- 执行过程默认展开并放在回答正文之前；SQL 默认可见，ASK 等待回答时保留已完成步骤，旧记录缺少描述时使用工具名称作为回退标题。没有历史记录的内容不会伪造补齐。
- ASK 追问在当前对话中展示选项，选择后在底部确认；允许自由回答时可直接补充。沿用真实 `pendingId` 续答接口，已完成的确认问答随结果保留，刷新可恢复尚未过期的待确认问题。
- 支持 Enter 发送、Shift+Enter 换行、中文输入法确认保护、停止生成、移动端会话抽屉和 CSV 导出。
- 页面构建和 lint 通过；会话、ASK 澄清及 Claude 集成测试 21/21，通过服务端渲染测试 1/1。界面已发布，容器健康，页面源码及样式 SHA256 与本地一致，网页和 API 检查均返回 200；Claude 仍为 prefer / 100%。
- 工具过程修复的相关回归 58/58、最终完整后端测试 555/555、构建、修改文件 lint 和服务端渲染 1/1 均通过。运行容器的前端、类型和 Claude 源码共 6 个文件 SHA256 与本地一致。单独 TypeScript 检查仍有 4 条已有诊断（流事件联合类型 1 条、评测按钮 disabled 类型 3 条）；与上一版已部署源码对比完全一致，本次未新增，不将其描述为全量类型检查通过。

## 验证

### 手机号查询 GPT 使用情况（已发布并验收）

- 用户反馈对应审计 138：Claude 先查 `alpha_user` / `alpha_user_gpt_cost_info`，随后用 `user.is_alpha_user=0` 和 Alpha 空结果推断没有 GPT 使用记录，并在 5 次 SQL 预算耗尽后仍返回 answered。这些证据不能否定独立的 AlphaGPT 产品账号。
- 生产本体已有 `alpha_product_account` → `alpha_account_user`、额度明细和日统计对象，以及通过 `user_id` 关联的已确认关系。遗漏的是 `alpha_account_user.phone` 和 `user_name` 的属性映射；概览又只给通用对象名称，省掉了描述中的产品归属。`get_knowledge` 接收 query 却不筛选，返回全部 3 条旧知识；`search` 把空格分隔的多关键词当成连续字符串，导致 `user phone mobile` 返回 0。
- 快照概览补充简短对象描述和物理表索引；知识搜索按关键词匹配排序后分页，与指定 IDs 取交集，未命中返回空集。搜索仍只作用于当前已授权快照，不重新引入平台意图规划。`get_knowledge` 同时返回实际命中页面关联的已发布对象索引、字段和枚举，MCP 在响应大小裁剪后按真正返回的结构记录披露，未知表和未授权列不被放开。
- 提示词明确核对产品归属，不能用另一产品的空结果或标记推导目标产品无记录。桥接层在可信 MCP 轨迹存在 SQL/扫描预算耗尽、仍有查询未执行时，将 answered 转为明确的查询未完成拒答；不提高预算，不接受辅助定位结果包装成完整结论。
- 通过正常校验、草稿、差异检查和发布 API，从 id 11 / version 10 更新至 id 12 / version 11，只新增 `alpha_product_account.phone` 和 `user_name` 两项非必填 string 映射。新增已验证知识 id 1514 / `alphagpt-customer-usage`：依据用户确认的产品表、实际字段注释、枚举和已发布关联描述 GPT 账号及消耗路径；`type=1` 为可用、`type=2` 为消耗、`quota` 为额度，不能当成次数或 Token。
- 首次回放会话 `75324c08-db69-42ee-b1fa-25a6e640e06a` / 审计 139 已查到正确产品及消耗数据，但模型读到新知识后未读取对应结构，发生两次 TABLE_NOT_DISCLOSED，随后自行修正；这次未通过“所有步骤无失败”的验收。针对这个真实剩余问题补齐知识返回结构，并增加 snapshot/MCP 回归；不是物理表名 ID 解析问题。
- **最终验收会话 `11aa684d-5c6b-4ecb-b696-fee82d88fd89` / 审计 140**：原问题不加路由或模型提示，通过正式 Nginx 和指定 DashScope / `glm-5.2-fast-preview`，4 个工具步骤、2 次 SQL、0 失败，首事件 5.400 秒，总耗时 23.950 秒。使用 `alpha_account_user`、`alpha_account_user_business_details` 和 `alpha_account_user_business_details_day`，未查询 Alpha 用户路径；当前额度和日明细各返回 1 行，未截断，同一消耗事实不相加。重新读取会话确认 4 步完整恢复，审计意图/检索字段为空。最终正常设置 API 确认 required / 100%、来源 db、SQL 上限 5；本轮保留了读取到的配置。
- 6 个新增回归先复现失败再验证修复，最终完整后端 566/566、修改代码 lint、diff 检查及服务器镜像构建通过。容器健康，网页与 API 均为 200，snapshot、bridge、Claude Skill 的 SHA256 与本地一致。

### Claude 直接问数（已发布并验收）

- 用户明确要求去掉 Claude 链路的「平台解析意图、检查字段覆盖」。Claude 现在先于旧规划链路运行，直接加载当前数据源的已发布本体、物理目录和已验证知识；不调用 `buildContext` / `parseQueryIntent` / `retrieveKnowledge`，不执行旧的覆盖、匹配冲突或指标提议前置判断。仅在 Claude 基础设施失败且原有配置允许回退时，旧规划器才构建自己的意图与检索上下文。
- Claude 的快照与执行内核均不接收平台意图或检索绑定；SQL 的主体、产品和筛选语义由 Claude 依据原始问题、会话历史和工具证据决定。提示词及 Claude Skill 已同步，不再要求读取平台意图合同。预算、模型配置、数据源/用户权限、已发布表列/关系范围、只读 SQL、结构披露、EXPLAIN、行数和执行 ID 校验保留。
- 读取完整范围内的已验证知识，取消构建快照时只留前 200 条的截断；工具仍分页并限制单次响应大小。支持中文对象名称/知识 slug 的精确读取，保留业务反例。答案的知识依据只记录工具实际读到的页面和规则。
- 修复 Claude 返回 ASK 后缺少 resume 回调的问题。续答启动新请求，沿用原问题与本体快照内容，显式传递用户澄清记录；通过 Claude 结果处理保存答案，不能误走旧 Agent finalizer。
- 测试先复现「未命中术语提前拒答」、旧提示词合同残留、知识截断、ASK 的 `pending.resume is not a function` 和未读取知识被列为依据，再验证修复。完整后端 560/560、修改文件 lint、diff 空白检查通过。未执行 git commit。
- 首次直接链路真实回放会话 `69a8de8f-f8fb-438b-9068-b09fab21d5d3` 已证明无平台解析/检索，4.884 秒出现工具调用，34.485 秒完成；但返回 Alpha 335 + AlphaGPT 186 条。随后只读聚合确认 Alpha 多出的 12 条为 `is_deleted=1`，其余 323 条为 `is_deleted=0`，全部 `is_valid=1`。根因是快照虽允许状态字段，原 `get_objects` / `search` 没有把未单独映射为本体属性的物理状态字段和枚举交给 Claude。已补齐允许范围内的字段、注释、枚举披露，并明确由 Claude 根据证据生成常规查询的逻辑删除过滤；不重新引入平台意图或覆盖判定。回归覆盖元数据可见性及未授权字段不可见，最终回放已排除这 12 条。
- 第二次回放会话 `f97b47b3-b73c-4731-a710-3f9237256c99` 发现 Claude 先消耗了 5 次 SQL 做定位和校验，第 6 次已生成的正确 Alpha 明细被预算拦下，最终错误提交了辅助结果与部分产品明细。本次不视为验收通过。自动审批拒绝持久将 SQL 上限从 5 增加到 10，理由是缺少对持续资源边界变更的明确授权；没有执行该设置变更，也没有通过其他路径提高上限。改用安全替代：`get_objects` 增加相关业务知识索引，提示词要求 SQL 前读取定义、优先完成各目标产品明细、最终排除辅助结果，仍保留原 SQL/扫描/费用限制。最终仅两次 SQL 即完成，不再需要提额，当前无此阻断。
- **最终验收会话 `7927cc2d-220f-4605-8658-0b95792b06e1`**：正式 Nginx SSE、实际 DashScope / `glm-5.2-fast-preview`、prefer / 100%，无测试路由覆盖；6 次工具调用全部成功（4 次读取、2 次 SQL），首事件 4.558 秒，总耗时 23.415 秒。Alpha 323 + AlphaGPT 186，共 509 条且未截断；Alpha 使用 `alp_office_name`，AlphaGPT 使用 `user_office_name`。历史结果与工具过程一致；响应 queryIntent 为 null、retrievalMode 为 claude，审计 intent_json 和 retrieval_trace_json 均为 null。正常设置 API 确认 SQL 上限仍为 5。只记录统计和执行元数据，未导出账户明细。

### 多产品律所筛选修复（已发布并验收）

- 用户截图原句对应审计 130：「北京市百伦律师事务所 帮我查询一下这个所 alpha与 alphaGpt账号的明细」。机构和两个产品均被识别，拒答发生在 Claude 调用之前：机构过滤被误标为 retrieval_budget 缺口。
- 已验证的两条律所名称知识均要求 AlphaGPT 使用 `alpha_account_user.user_office_name`（当前所属律所），但版本 9 的 `alpha_product_account` 只映射 `office_name`（开通时律所），遗漏了当前归属字段。宽泛字段同义词又将多个同表字段视为同分候选。
- 检索修复按照同一筛选概念的已验证 SQL 定义，在每个产品自己的表内绑定唯一字段；正文和反例不参与正向绑定，冲突定义、无定义的同表歧义仍不能擅自选列。回归覆盖截图原句和两种等价问法。
- 在服务器临时元数据副本中，通过正常 Schema 校验/发布流程补充 `alpha_product_account.user_office_name` → `alpha_account_user.user_office_name`，非必填 string，显示名称「用户所属律所」。三种问法及之前单独 Alpha 的问题均无 missing、歧义或知识冲突。
- 指定 DashScope / `glm-5.2-fast-preview` 在临时副本中真实回放原句成功，约 51 秒，Alpha 323 条、AlphaGPT 186 条，共 509 条。没有输出账号业务明细；副本已删除。完整后端测试 556/556，修改文件 lint 通过。
- 正式模型通过正常校验/发布 API 从 id 10 / version 9 更新为 id 11 / version 10，只补充上述非必填字段；发布前模型 JSON 保存在本次备份目录的 `ontology-before.json`，原版本也保留，可通过正常 rollback API 恢复。
- 正式 Nginx SSE 回放截图原句成功，约 57.9 秒，5 对工具开始/完成事件（先读表要求导致的两次拒绝随后自动修正），两个结果集 323 / 186 条，`planningMode=claude`、`ontologySchemaVersion=10`。会话 `ab087a94-7eda-4db5-aaf1-fd081c55942f` 保存了结果和完整过程。核对 SQL 分别使用 `alp_office_name` / `user_office_name`，结果中的 `product_key` 全部为 AlphaGPT（186 条）；`product_account_type` 是天使/付费/试用等账号类型，不是产品标识。
- 两种额外等价问法完成本地及服务器隔离元数据回归，没有额外调用生产模型比较。自动审批拒绝了最初两次生产回放，后用已部署 MCP 和合成数据证明单次工具只返回 20 行 / 24KB 预览、完整 509 行留在服务器，验收缩小为原句一次；一次审批超时后按指示重试一次，通过并完成。没有向模型外发完整结果集。

```sh
node --test server/test/*.test.mjs
# 556 / 556 通过；本地 HTTP/MCP 测试需要允许 loopback socket。
npm run lint -- --ignore-pattern .claude
# 通过；排除 .claude 内历史 worktree 的独立旧代码。
npm run build
# 通过。
npm run test:rendered
# 1 / 1 通过。
```

诊断和隔离回放使用服务器内的临时元数据副本，用完删除；正式发布和最终验收通过正常生产 API 完成。没有下载生产元数据或业务明细：

1. 原失败问题来自数据源 2、审计记录 124。修复后检索 missing、ambiguities 和知识硬冲突均为空。
2. 原版本 id 9 / version 8 的 `alpha_user_profile` 缺少姓名和手机号。新增 `name` → `alpha_user.alp_name`、`mobile` → `alpha_user.alp_cell`，均为非必填 string；通过正常 API 校验并正式发布为 id 10 / version 9，未跳过发布门禁。
3. 禁用全部外部 fetch，使用进程内固定代码适配器调用真实 MCP 和查询内核。以原问题中的律所 ID、律所名称及有效性条件执行只读 SELECT，返回 16 条，包含 `alp_name`、`alp_cell`、`alp_active_time`、`expire_time`。明细未输出到日志或外部模型。
4. 用户授权后的真实 Claude 回放通过：使用指定 DashScope 端点与 `glm-5.2-fast-preview`，`planningMode=claude`，16 条结果，列名为姓名、手机号、激活时间、到期时间。核对 SQL 保留原系统 ID、连续律所名称，以及 `is_deleted=0`、`is_valid=1`；可信执行注册表及共享 finalizer 均通过。调用运行于服务器临时元数据副本，结束后已删除副本；未修改生产路由。
5. 用户随后明确授权生产全量 Claude 优先及后续必要数据发送。通过 `PUT /api/settings` 设置 `claudeQuery.mode=prefer`、`trafficPercent=100`，GET 确认两项来源均为 `db`，已持久生效。
6. 通过生产 `POST /api/query` 回放原问题，未传入任何路由覆盖参数。约 34.8 秒完成，`planningMode=claude`，16 条结果，四个物理字段与原系统 ID 均匹配；会话 ID 为 `418ef2d3-1414-4408-b12f-e9b0b1f2796b`。公网入口对应的 Nginx 网页和 `/api/ready` 检查均为 200。
7. 工具过程修复后，通过容器到宿主机 Nginx（网关 `172.18.0.1`，Host `39.107.117.246`）回放原问题。SSE 依次收到 `db_query` 拒绝（尚未披露表）、`ontology_read get_objects` 成功、`db_query` 成功；共 3 对开始/完成事件，首个事件 8161 ms，最终答案 16800 ms，确认为不同 HTTP 数据块逐步到达。`planningMode=claude`，16 条、四个字段及原系统 ID 均匹配。通过 GET 会话确认 3 个步骤、摘要、实际执行 SQL 均已持久保留；会话 `c0254dcf-1836-4769-907b-ebbcfad714e0`。验收日志只输出事件名称、时间、计数及字段名，没有业务明细。

## 服务器核对

用户已澄清 **39.107.117.246** 才是目标。**39.96.34.126**（node02）的 dsh / Nginx 本轮仅做只读核对，未改动或重启：

- Nginx 80 → `127.0.0.1:3080`。
- Node 进程为 `@deepseek-ai/dsh ... web`，目录 `/var/lib/deepseek-harness/workspace`。
- 未发现运行中的 OntoQuery API/网页，也未安装 Docker。

仓库部署记录及现有问数服务位于 **39.107.117.246**（node01）：

- 目录 `/home/ecs-user/apps/ontology-query-platform`，容器 `ontology-query-platform-ontoquery-1`，服务健康，已运行本次工作区修复；源码关键文件及依赖文件 SHA256 与本地一致。
- runtime data/wiki 属主为 1000:1000，容器以 node 用户运行，写入正常。
- 本次完整备份 `/home/ecs-user/ontoquery-backups/reconnect-release-20260904044356`：源码/环境、SQLite 一致性快照、runtime 附属文件及 wiki。
- 旧镜像标签 `ontology-query-platform-ontoquery:reconnect-backup-20260904044356`。
- 当前镜像 `sha256:f411e22a5c705117d474e53bae33ff6c7c2f6dff962d3b4943a4d76a6d05296d`，已移除 Claude 表列白名单、已确认 JOIN 与先读结构拦截，并保留浅色主题、ASK 续答和实时工具过程。snapshot、bridge、SQL guard、执行内核、query-service、MCP、Claude Skill、样式和图表共 9 个关键文件 SHA256 与本地一致。
- 本次发布备份 `/home/ecs-user/ontoquery-backups/schema-removal-20260904102917`，权限 700；`source-config.tgz` 保存发布前源码与配置，验收脚本及构建日志权限 600。回滚标签 `ontology-query-platform-ontoquery:schema-removal-backup-20260904102917` 对应发布前镜像 `a485d643…`；未通过业务验收的第一版保留为 `ontology-query-platform-ontoquery:schema-removal-first-pass-20260904102917`，对应 `bd105b5a…`，不能作为验收基线。
- GPT 修复前备份 `/home/ecs-user/ontoquery-backups/gpt-usage-20260904092542`：`source-config.tgz` 为原源码/配置，`ontology-before.json` 保存本体 v10 与新知识原状态，`metadata-candidate.json` / `metadata-published.json` 保存候选和正式发布记录；敏感运维文件权限 600，目录 700。回滚镜像标签 `ontology-query-platform-ontoquery:gpt-usage-backup-20260904092542` 对应浅色版 `ace7e08b…`。第一版已能返回正确业务数据但有结构重试的镜像 `a6dbe614…` 保留为 `ontology-query-platform-ontoquery:gpt-usage-first-pass-20260904092542`。最终验收脚本保留在该备份目录，不入仓库。
- 浅色主题发布前备份 `/home/ecs-user/ontoquery-backups/light-theme-20260904085626`，镜像标签 `ontology-query-platform-ontoquery:light-theme-backup-20260904085626`，对应已验收的 `sha256:55f1c2ae7642139b161d6f0f58e62bceb3d5d66c0ef3aff8cfd9ab07c0d8b0bf`。
- 本轮移除前置解析之前的备份 `/home/ecs-user/ontoquery-backups/direct-claude-20260904070733`，镜像标签 `ontology-query-platform-ontoquery:direct-claude-backup-20260904070733`，对应已验收的前一版 `sha256:7fc81325d78087dbd9be4b873e297f30e98fcd3b3ce0095cbeb02901b483c275`。本轮未修改本体版本或查询资源上限。
- 最后发布前备份 `/home/ecs-user/ontoquery-backups/direct-claude-knowledge-20260904072942`，中间备份 `/home/ecs-user/ontoquery-backups/direct-claude-schema-20260904071829`；分别保留本轮中间镜像 a1c3b69e…、b6cb32f6…。这些中间版本未通过最终查询验收，不应作为业务验收基线。
- 多产品律所修复发布前源码/配置与模型备份 `/home/ecs-user/ontoquery-backups/organization-filter-20260904062046`，镜像标签 `ontology-query-platform-ontoquery:organization-filter-backup-20260904062046`，对应旧镜像 `sha256:3b2989b90fc70669d14abc4c0d097336a3345d45fab734038a3b791a198735c6`。
- 工具过程发布前源码/配置备份 `/home/ecs-user/ontoquery-backups/tool-process-20260904055712`，镜像标签 `ontology-query-platform-ontoquery:tool-process-backup-20260904055712`，对应上一版界面镜像 `sha256:8e9d0f0c201b56422d6816bb6379106f53cd9293817dd5c0f120558953322245`。
- UI 发布前源码/配置备份 `/home/ecs-user/ontoquery-backups/chat-ui-20260904053551`，镜像标签 `ontology-query-platform-ontoquery:chat-ui-backup-20260904053551`，对应上一版已通过真实回放的镜像 `sha256:03910cd778949dcea5896474a6713a9215f3b17d47037be1c951d749f8ae922b`。
- Claude 契约发布前源码/配置备份 `/home/ecs-user/ontoquery-backups/claude-contract-20260904050917`，对应镜像标签 `ontology-query-platform-ontoquery:claude-contract-backup-20260904050917`；完整数据备份仍使用上面的 reconnect-release 目录。
- Claude 已配置用户指定的 Anthropic 兼容端点和 `glm-5.2-fast-preview`；密钥仅在服务器环境中，不入库。
- CLI 版本、本地 readiness 和真实最小 preflight 通过。**最新应用 rollout 为 required / 100%，模式来源为数据库设置**；模型 `glm-5.2-fast-preview`。GPT 修复没有修改路由或资源配置。

网页入口 `http://39.107.117.246/`，Nginx 将网页和 /api 分别代理到本机 3000 / 8787。发布后的网页与 API 检查均返回 200；没有迁移或修改 node02 服务。

## 授权与运维记录

自动审批拒绝过整份生产元数据导出到本地，已改为服务器内副本和窄范围诊断。用户先授权单次真实回放，随后明确授权生产 Claude 全量优先，并允许后续问数所需的问题、结构、知识及包含姓名、手机号的结果预览发送到指定 DashScope。该授权已落实，无需再次询问同一范围。

此前全量切换因仅有单次回放授权而被自动审批拒绝；用户补充授权后已通过正常设置 API 完成，当前无此阻断。

1. 最早切换前为 `off / 0%`，此前验收为 `prefer / 100%`；GPT 修复最后一次正常 API 读取为 `required / 100%`，模式来源 db，本轮没有写入这个变更。后续操作应保留实际配置，不能按旧交接的 prefer 值覆盖。
2. 用户要求不主动 commit；部署工作区修改时不能使用 git archive HEAD。最终业务上下文源码包 `/tmp/ontoquery-schema-removal-context-20260904.tar.gz` 的 SHA256 为 `45a0052611589693ae6371bd925e5a22c727c3a1e9d597f5922f9bc90170c4bf`；第一版源码包 `/tmp/ontoquery-schema-removal-20260904.tar.gz` 的 SHA256 为 `e0826a4c21edeb4ed87601f76535410cfb78e4f418a3f1af2724492336e02b21`。前一版 GPT 源码包 `/tmp/ontoquery-gpt-usage-schema-20260904.tar.gz` 的 SHA256 为 `3545416163b8788dc51ec90e2f4172282353736bf48f93f54e2ecf2c07e867d5`。交接文档的发布后状态更新另行同步到服务器源码目录，不在最终业务上下文包内。
