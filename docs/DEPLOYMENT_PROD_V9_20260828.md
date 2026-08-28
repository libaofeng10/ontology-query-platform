# 生产部署记录 · v9（知识缺口治理 S1–S9）

- **部署日期**：2026-08-28
- **代码版本**：`611ffce`（S9），基线 `8c19bf7`，共 9 个提交（S1–S9），已推送 `origin/main`
- **服务器**：39.107.117.246（阿里云 ECS，Ubuntu，主机名 `rock-ontology-query-node01-0-111`），登录账号 `ecs-user`（凭据不入库，见运维口令管理）
- **部署形态**：单机 Docker Compose，容器 `ontology-query-platform-ontoquery-1` 同时跑 API（8787）与 Web（3000），仅绑定 127.0.0.1，由宿主机 nginx 对外反代

## 部署架构速览

```
~/apps/
├── ontology-query-platform/            # 部署目录（非 git 仓库，rsync 同步产物）
│   ├── compose.yaml                    # 随代码发布
│   ├── compose.override.yaml           # 服务器本地：runtime/ 目录挂载 + NEXT_PUBLIC_API_BASE_URL=/api
│   ├── .env.production                 # 服务器本地：密钥、LLM 配置、QUERY_AGENT_MODE=required 等
│   ├── runtime/data/platform.sqlite    # 生产数据库（bind mount 进容器 /var/lib/ontoquery/data）
│   └── runtime/wiki/                   # 知识 Markdown
├── ontology-query-platform-stage-v9-20260828/   # 本次解包暂存目录
├── ontology-query-platform-full-20260828-v9.tgz # 本次发布包（git archive HEAD）
├── ontology-query-platform-pre-v9-20260828.tgz  # 部署前代码备份（旧版本目录打包）
└── platform.sqlite.bak-v9-20260828101516        # 部署前数据库备份
```

关键点：`.env.production`、`compose.override.yaml`、`runtime/` 是**服务器本地文件，永远不被发布覆盖**（rsync 显式 exclude）。

## 本次发布内容（S1–S9）

| 步骤 | 内容 | 失败模式治理 |
|---|---|---|
| S1 | 枚举字典判定收紧（覆盖全表 + 基数比 + 命名黑名单三条件） | 标识列被登记为值域白名单 → 错误拒答 |
| S2 | 存量 ds_enum 清理迁移（幂等，服务启动自动执行） | 存量误登记枚举 |
| S3 | 工具协议格式违规一次不计预算重试；语义违规立即终止 | 一次笔误终止整轮查询 / 越权被宽容重试 |
| S4 | 拒答审计 intent 回填 + failureClass 新增 4 类取值 | intent_json 覆盖率 4/59，无法归类 |
| S5 | 首页分类覆盖计数 + 拒答卡片脱敏缺口透出 | "625 个条目"聚合失真 |
| S6 | 缺口聚合服务（纯读实时计算，含退化路径） | 拒答散落审计无人聚合 |
| S7 | GET /api/capability-gaps + 知识工作台缺口面板（editor 门禁） | 缺口无出口 |
| S8 | 口径提议服务（LLM 只出结构化公式，模板渲染保证可解析） | 补口径只能人工从零写 |
| S9 | 提议接入查询链路（拒答变澄清，确认落库重查，开关默认关） | 补口径要离开问数上下文 |

## 标准部署流程（本次执行的完整命令）

### 1. 本地打包并上传

```bash
# 本地机器（代码已合入 main 并 push）
git archive --format=tar.gz -o /tmp/ontology-query-platform-full-20260828-v9.tgz HEAD
scp /tmp/ontology-query-platform-full-20260828-v9.tgz ecs-user@39.107.117.246:~/apps/
```

### 2. 服务器备份（代码 + 数据库）

```bash
# 代码备份（排除本地文件）
cd ~/apps/ontology-query-platform
tar --exclude='./runtime' --exclude='./.env.production' --exclude='./.env.local' \
    --exclude='./compose.override.yaml' --exclude='./ontoquery-*' \
    -czf ../ontology-query-platform-pre-v9-20260828.tgz .

# 数据库备份（本次因 S2 迁移会删 ds_enum 行，必须先备份）
cp runtime/data/platform.sqlite ../platform.sqlite.bak-v9-$(date +%Y%m%d%H%M%S)
```

### 3. 解包暂存 + rsync 同步

```bash
cd ~/apps
mkdir -p ontology-query-platform-stage-v9-20260828
tar -xzf ontology-query-platform-full-20260828-v9.tgz -C ontology-query-platform-stage-v9-20260828

# 先 dry-run（-ani）核对变更清单，再实际执行（-a）
rsync -a --delete \
  --exclude='.env.production' --exclude='.env.local' \
  --exclude='compose.override.yaml' --exclude='runtime/' --exclude='ontoquery-*' \
  ontology-query-platform-stage-v9-20260828/ ontology-query-platform/
```

### 4. 构建镜像 + 重建容器

```bash
cd ~/apps/ontology-query-platform
docker compose build ontoquery
docker compose up -d --force-recreate ontoquery
```

### 5. 验证

```bash
docker compose ps                          # STATUS 应为 Up ... (healthy)
curl -s http://127.0.0.1:8787/api/ready    # ok:true，且 enumDictionaryRules 字段可见
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/   # 200
docker compose logs --since 5m ontoquery | grep -iE 'error|fail'
```

## 本次验证结果

- 容器 `Up (healthy)`，Web 200。
- `/api/ready` 返回：
  ```json
  "enumDictionaryRules": {"version":"enum-dictionary-v2-identifier-blacklist","removedColumns":494,"removedHumanMeanings":0,"skipped":false}
  ```
  即 S2 迁移在容器首次启动时自动执行：删除 494 个误登记枚举列（2344 行），无人工含义损失。
- 库内核查：`ds_enum` 中 `%cell%` 行 **0**（基线 14），总行数 9279 → 6935。
- 迁移幂等：版本号已写入 `system.enumDictionaryRuleVersion`，后续重启自动跳过（`skipped:true`）。
- 近 3 分钟日志无 error/fail。

## 新增配置项（本次引入，均有安全默认值，未改 .env.production）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ENUM_MAX_DISTINCT_RATIO` | 0.05 | S1 枚举字典基数比阈值；设置中心 discovery 分组可在线调整 |
| `METRIC_PROPOSAL_ENABLED` | **false** | S9 口径提议开关。默认关闭，拒答行为与旧版逐字一致；确认灰度策略后再在 `.env.production` 或设置中心打开 |

注意：S9 要求查询链路带用户角色，只有 `editor`/`admin` 会触发口径提议，`analyst`/`viewer` 始终走原拒答——开关打开后也不影响分析师体验。

## 回滚流程

```bash
cd ~/apps/ontology-query-platform

# 1. 回滚代码
tar -xzf ../ontology-query-platform-pre-v9-20260828.tgz -C .

# 2. 如需回滚数据库（S2 删除的枚举行只有恢复备份才能找回）
docker compose down
cp ../platform.sqlite.bak-v9-20260828101516 runtime/data/platform.sqlite
rm -f runtime/data/platform.sqlite-shm runtime/data/platform.sqlite-wal

# 3. 重建
docker compose build ontoquery && docker compose up -d --force-recreate ontoquery
```

数据库回滚注意：恢复备份后旧代码不含 `enumDictionaryRules` 版本号消费逻辑，无副作用；若恢复备份却继续跑 v9 代码，启动时迁移会再次执行清理（幂等，结果一致）。

## 上线后观测要点（来自实施清单）

- **S1/S2**：同时观测拒答率与错答率。枚举收紧在超过采样上限的大表上会让值域校验从"字典校验"退化为"不校验"，方向是少拒不错答，但必须确认没有换来错答上升。
- **S3**：`protocol_retry` 已进评测统计（agent 门禁的 `protocolRetries` 指标）；重试率超阈值说明该修 prompt 而不是靠重试兜底。
- **S4 起**：每条新拒答的审计行 `intent_json` 应非空（`llm_unconfigured` 除外）。
- **手工验证**（建议尽快做一次）：重跑数据源探查；以手机号 `13774665233` 提问"查询 Alpha 到期时间"应不再因枚举字典外取值失败；首页显示分类覆盖且指标 0 带警示；editor 登录知识资产页可见"知识缺口"面板。

## 历史版本对照

| 版本 | 日期 | 发布包 |
|---|---|---|
| v8 | 2026-08-27 | ontology-query-platform-full-20260827-v8.tgz |
| **v9（本次）** | **2026-08-28** | **ontology-query-platform-full-20260828-v9.tgz** |

旧的 stage 目录与 tgz 会持续累积在 `~/apps/`，确认 v9 稳定后可清理 v7 及更早的暂存目录。
