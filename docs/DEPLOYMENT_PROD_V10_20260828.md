# 生产部署手册 · v10（语义契约完整性 T1–T8）

- **状态**：**待执行**。代码已合入并推送 `origin/main`，本地校验通过；服务器发布动作尚未执行。
- **代码版本**：`259c995`（T7），基线 `0c6835b`（v9），共 8 个提交（T1–T8）
- **本地校验**：`npm test` **457 passed / 0 failed**；`npm run lint` 干净；`npx tsc --noEmit` 13 个错误，与 v9 基线逐条一致（均在 `app/platform-app.tsx`、`examples/`、`worker/`，非本次改动引入）
- **服务器与部署形态**：与 v9 完全一致，见 [DEPLOYMENT_PROD_V9_20260828.md](DEPLOYMENT_PROD_V9_20260828.md)

## 本次发布内容（T1–T8）

上一轮 S1–S9 打通了「拒答 → 缺口 → 提议」的治理闭环。这一轮修的是 RCA
（[RCA_CONVERSION_RATE_REFUSAL_20260828.md](RCA_CONVERSION_RATE_REFUSAL_20260828.md)）
定位的两个根因：**本体侧**没有任何已确认枚举含义，**设计侧**推导会静默覆盖已验证页面的声明。

| 步骤 | 内容 | 治理的失败模式 |
|---|---|---|
| T1 | 推导三态化（`declared`/`inferred`/`undetermined`） | 推导失败静默降级为「无约束」，错答而非拒答 |
| T2 | 知识页结构化声明块 `contract`，契约与散文分离并全链路往返 | 口径只存在于散文里，靠正则猜 |
| T3 | 证据等级冲突显性化：问句显式口径与页面声明冲突时澄清 | 推导静默覆盖已验证声明 |
| T4 | 共享语义校验器：写入期断言与消费期推导对齐 | 保存能过、查询时才炸 |
| T5 | 枚举含义闭环：列注释映射成为候选，系统主动索取确认 | 系统要求一份它从未向任何人索取过的确认 |
| T6 | 闭集成员值词表：已确认含义让「抖音渠道」这类省略操作符的筛选可解析 | 值+字段相邻在解析期就被拒，绑定层根本没被走到 |
| T7 | 健康看板 + 拒答文案脱敏 | 缺陷页无出口；拒答文案泄漏内部分面 ID |
| T8 | S2 回补：小维表标签列按「字典规模表」联合判定恢复登记资格 | S2 一刀切黑名单误删 151 个列的真实业务字典 |

### 与 v9 的数据库交互（务必读）

`applyEnumCatalogMigration` 在容器启动时自动执行，本次版本号由
`enum-dictionary-v2-identifier-blacklist` 升到 `enum-dictionary-v3-label-dimension-exception`，
**所以它会再跑一次**（v9 后写入的版本号不再匹配）：

- v3 放宽了 `…name` 标签列的删除口径（表行数 ≤ 20 且样本覆盖全表则保留），但**迁移只能删、不能恢复**。v9 已删掉的行不会自己回来。
- 因此本次迁移的预期结果是 `removedColumns` **接近 0**（该删的 v9 已删完），`removedHumanMeanings` 应为 **0**。
- **恢复被误删的字典取值，必须重跑数据源探查**（见下方第 6 步）。这是本次发布唯一的强制人工后置动作。

## 部署流程

### 1. 本地打包并上传

```bash
git archive --format=tar.gz -o /tmp/ontology-query-platform-full-20260828-v10.tgz HEAD
scp /tmp/ontology-query-platform-full-20260828-v10.tgz ecs-user@39.107.117.246:~/apps/
```

### 2. 服务器备份（代码 + 数据库）

```bash
cd ~/apps/ontology-query-platform
tar --exclude='./runtime' --exclude='./.env.production' --exclude='./.env.local' \
    --exclude='./compose.override.yaml' --exclude='./ontoquery-*' \
    -czf ../ontology-query-platform-pre-v10-20260828.tgz .

# 迁移会改 ds_enum，必须先备份
cp runtime/data/platform.sqlite ../platform.sqlite.bak-v10-$(date +%Y%m%d%H%M%S)
ls -lh ../platform.sqlite.bak-v10-*   # 记下文件名，回滚要用
```

### 3. 解包暂存 + rsync 同步

```bash
cd ~/apps
mkdir -p ontology-query-platform-stage-v10-20260828
tar -xzf ontology-query-platform-full-20260828-v10.tgz -C ontology-query-platform-stage-v10-20260828

# 先 dry-run 核对清单
rsync -ani --delete \
  --exclude='.env.production' --exclude='.env.local' \
  --exclude='compose.override.yaml' --exclude='runtime/' --exclude='ontoquery-*' \
  ontology-query-platform-stage-v10-20260828/ ontology-query-platform/

# 清单无误后去掉 -ni 实际执行
rsync -a --delete \
  --exclude='.env.production' --exclude='.env.local' \
  --exclude='compose.override.yaml' --exclude='runtime/' --exclude='ontoquery-*' \
  ontology-query-platform-stage-v10-20260828/ ontology-query-platform/
```

`.env.production`、`compose.override.yaml`、`runtime/` 是服务器本地文件，rsync 显式 exclude，永不被覆盖。

### 4. 构建镜像 + 重建容器

```bash
cd ~/apps/ontology-query-platform
docker compose build ontoquery
docker compose up -d --force-recreate ontoquery
```

### 5. 基础验证

```bash
docker compose ps                          # STATUS 应为 Up ... (healthy)
curl -s http://127.0.0.1:8787/api/ready | python3 -m json.tool | grep -A 6 enumDictionaryRules
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # 200
docker compose logs --since 5m ontoquery | grep -iE 'error|fail'
```

`enumDictionaryRules.version` 应为 `enum-dictionary-v3-label-dimension-exception`，
`removedHumanMeanings` 应为 `0`。若 `removedHumanMeanings > 0`，说明有人工确认的含义被删，
**立刻停止并回滚数据库**。

### 6. 重跑数据源探查（**强制**，本次发布的功能靠它才生效）

T5/T6/T8 都依赖探针重新登记枚举字典。不做这一步，「抖音渠道」仍然不可解析。

在 Web 界面数据源页点「重新探查」，或直接调接口。完成后核查：

```bash
# 进容器查库
docker compose exec ontoquery sqlite3 /var/lib/ontoquery/data/platform.sqlite \
  "SELECT COUNT(*) FROM ds_enum;"

# T8 回补是否生效：小维表标签列应重新出现
docker compose exec ontoquery sqlite3 /var/lib/ontoquery/data/platform.sqlite \
  "SELECT table_name, column_name, COUNT(*) FROM ds_enum
   WHERE column_name LIKE '%name' GROUP BY table_name, column_name;"

# T5 是否生成了枚举含义待确认项
docker compose exec ontoquery sqlite3 /var/lib/ontoquery/data/platform.sqlite \
  "SELECT COUNT(*) FROM ds_question WHERE kind='枚举含义' AND status='pending';"
```

第三条应 **> 0**。若为 0，说明列注释里没有可解析的字典映射，需要人工在知识工作台补含义。

### 7. 功能验收（建议按顺序做）

1. **枚举含义确认**：知识工作台 → 待确认项 → 筛选「枚举含义」，确认
   `source_data_channel` 的取值含义（如 `2` = 抖音）。确认写入 `meaning_source='human'`，
   这是绑定层唯一信任的等级。
2. **T6 主验收**：问「抖音渠道的线索有多少」。
   - 修复前：解析期就拒（`filters` 为空，`FILTER_EXPRESSION_UNSUPPORTED`）
   - 期望：解析出 `channel = 抖音`，经 `verified_enum_meaning` 绑定为 `source_data_channel = 2` 并出结果
   - 若仍拒答：先确认第 1 步已完成——**没有已确认含义，T6 的闭集是空的，行为与旧版一致**（这是设计，不是 bug）
3. **T7 脱敏**：随便问一个会被拒的问题，拒答文案应显示「筛选「渠道」」这类业务面，
   **不得出现** `filter:channel:0` 这类内部 ID，也不得出现筛选值本身。
4. **T7 看板**：以 editor 登录知识资产页 → 知识缺口面板，语义有缺陷的已验证页面应作为
   open 缺口出现，`remedy=edit_knowledge_page`，点击直达该页编辑器。
5. **T3 冲突澄清**：对一个已声明 `contract.timeRole` 的指标页，用与之冲突的时间口径提问
   （如页面声明 `entry`，问句问「按成单时间」），应得到澄清而不是静默按其中一个执行。
6. **T1 回归**：确认原有正常问答未变化——推导成功的路径行为与 v9 一致，
   只有推导失败的路径从「静默无约束」变成 `undetermined`。

## 回滚流程

```bash
cd ~/apps/ontology-query-platform

# 1. 回滚代码
tar -xzf ../ontology-query-platform-pre-v10-20260828.tgz -C .

# 2. 回滚数据库（仅在 removedHumanMeanings > 0 或探查结果异常时需要）
docker compose down
cp ../platform.sqlite.bak-v10-<你的时间戳> runtime/data/platform.sqlite
rm -f runtime/data/platform.sqlite-shm runtime/data/platform.sqlite-wal

# 3. 重建
docker compose build ontoquery && docker compose up -d --force-recreate ontoquery
```

**回滚数据库的注意点**：恢复到 v10 部署前的备份，`system.enumDictionaryRuleVersion`
会回到 v2；若此时跑的是 v9 代码则无副作用；若继续跑 v10 代码，启动时迁移会按 v3
规则再执行一次（幂等，结果一致）。**若已经做过第 6 步重探并确认过枚举含义，
回滚数据库会丢掉那些人工确认**——此时应优先只回滚代码、保留数据库。

## 配置项

本次未引入新环境变量。v9 引入的两项沿用：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ENUM_MAX_DISTINCT_RATIO` | 0.05 | 枚举字典基数比阈值 |
| `METRIC_PROPOSAL_ENABLED` | **false** | S9 口径提议开关，仍建议保持关闭直到灰度策略确定 |

T8 新增的两个判定常量（`ENUM_LABEL_SUFFIX`、`ENUM_LABEL_DICTIONARY_MAX_ROWS=20`）
写死在 `server/src/db-probe.mjs`，不走配置——它们必须与迁移逻辑保持逐字一致，
可配置化会让两边漂移。

## 上线后观测要点

- **T5/T6**：观测拒答率下降的同时**必须看错答率**。T6 只在闭集内放开省略操作符的筛选，
  但闭集的正确性完全依赖人工确认的含义质量；一条确认错了，就是一个被提升为权威的错误。
- **T1/T3**：`undetermined` 与新增的冲突澄清都会**提高**拒答/澄清率。方向是少错答，
  但若澄清率高到影响体验，说明知识页缺 `contract` 声明——该补声明，而不是关掉冲突检测。
- **T7**：看板上 `page_health` 类缺口的数量即「已验证但语义有缺陷」的页面数。
  这个数字应该单调下降；长期不降说明缺陷页无人认领。
- **T8**：确认 `alpha_crm_channel.channel_name` 这类小维表标签列重探后回到 `ds_enum`。

## 历史版本对照

| 版本 | 日期 | 发布包 |
|---|---|---|
| v8 | 2026-08-27 | ontology-query-platform-full-20260827-v8.tgz |
| v9 | 2026-08-28 | ontology-query-platform-full-20260828-v9.tgz |
| **v10（本次）** | **2026-08-28** | **ontology-query-platform-full-20260828-v10.tgz** |

