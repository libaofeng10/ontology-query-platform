# Claude 接入重建 — 交接文档

- **日期**：2026-09-03
- **状态**：重建进行中，query-service claude 分支为初稿，尚未对齐契约测试
- **上游方案**：[CLAUDE_CODE_QUERY_PLAN.md](./CLAUDE_CODE_QUERY_PLAN.md)
- **实施计划**：[CLAUDE_CODE_QUERY_IMPLEMENTATION_PLAN.md](./CLAUDE_CODE_QUERY_IMPLEMENTATION_PLAN.md)

## 背景

此前误剥离 Claude 接入（依赖未打包导致生产启动崩溃），后恢复代码并补齐依赖。当前生产服务健康（HEAD `dba4259`，无 claude）。本任务是**把 query-service 的 claude 分支重建完整**，使已有的集成测试全绿。

## 当前 git 状态（未提交）

- 恢复的 claude 模块（暂存 A）：`server/src/claude-query-{bridge,mcp,snapshot,readiness,local-eval}.mjs`、`server/claude/ontology-query/SKILL.md`、相关测试、`scripts/claude-query-{preflight,eval-local}.mjs`、`examples/evaluation/claude-local.fake.json`
- `package.json` / `package-lock.json`（M）：加了 `@anthropic-ai/claude-code@2.1.258`、`@modelcontextprotocol/sdk@1.30.0`
- `server/src/query-service.mjs`（M）：**我新写的 claude 分支初稿**

## 已完成并可验证的

1. **依赖已装**（本地 node_modules 有 MCP SDK + claude-code），全部 claude 模块 `import` 加载 OK。
2. **claude 模块本体完整**：`claude-query-bridge.test.mjs`(19过0)、`claude-query-mcp.test.mjs`、`claude-query-snapshot.test.mjs`、`claude-query-readiness.test.mjs` 单独跑全过。
3. **`query-execution-kernel.mjs`**(756行) 与 `query-agent-loop.mjs`(用 kernel) 自洽，42 过 0。
4. **`query-service.test.mjs`** 现有的 agent 路径测试 20 过 0 —— 我的 claude 分支（默认 `off`）未破坏现有查询链。
5. `createQueryService` 加依赖注入 `claudeBridge/claudeSnapshotBuilder/claudeMcpFactory`；`ask()` 加 `claudeQueryMode` 路由 + `tryClaudeQuery` 分支；模块级加 `normalizeClaudeMode`/`selectClaudeQueryRollout`/`claudeFailureCanFallback`/`runClaudeQueryBranch`/`redactClaudeBoundaryValue`；闭包内加 `finalizeClaudeOutcome`。

## 未完成：对齐集成测试（精确规格）

`server/test/claude-query-integration.test.mjs`（423行，从 aaf8994 恢复）定义了 claude 分支的**精确契约**，当前我的初稿实现有 `answer.evidence undefined`（分支未走通）等不匹配，10 个测试失败。**该测试文件就是规格**，需逐项对齐使全绿：

| 测试 | 契约要求 |
|---|---|
| routes required Claude attempt | `ask({claudeQueryMode:"required"})` 成功 → evidence.planningMode="claude"，rows 只含非敏感列，sql 带 LIMIT |
| redacts typed literals | conclusion/delta/trace 中手机号/邮箱必须 `[REDACTED]` |
| sensitive typed-literal fail-closed | 问题含手机号→`SENSITIVE_BINDING_UNAVAILABLE`，bridgeCalls=0，providerCalls=0 |
| prefer infra failure falls back | claude 基础设施失败→回退 legacy planner，audit 记 claude failed |
| bridge shutdown failure | 停机时 bridge 抛 `BRIDGE_CLOSED`→refused，**不**回退启动 legacy，llmCalls=0 |
| zero budget refuses | `maxBudgetUsd:0`→`budget_disabled`，snapshot/mcp/bridge 全不调用 |
| missing model refuses | `model:""`→`model_missing`，"精确模型 ID"，snapshot/mcp/bridge 全不调用 |
| ignores forged runs | 伪造 execution ID 不在 registry→`protocol_error`，queryCalls=0 |
| preserves non-Error throw | adapter 抛字符串 `"transport exploded"`→reason 保留原信息 |
| snake-case sensitive metadata | registry run 归一化敏感列（is_sensitive），敏感列不进 answer.rows/columns |

## 关键实现点（从测试推断）

1. `runClaudeQueryBranch` 传给 bridge.run 的字段是 `{ mcp: mcpSession, snapshot, kernel, ... }`（测试解构 `{mcp}`，见已修正）。
2. **bridge.run 前置检查**（在 snapshot/mcp 构造之前，避免付昂贵调用）：
   - `maxBudgetUsd===0` → `budget_disabled`
   - 无精确 `model` → `model_missing`
   - 问题含 typed literal（手机/邮箱/身份证/银行卡）且无参数化 binding → `SENSITIVE_BINDING_UNAVAILABLE`
   - bridge 关闭时（`BRIDGE_CLOSED`）→ refused，不回退
3. 只在 `runtime`（executionId 在 registry 中）时接受 answered；伪造 executionId → `protocol_error`。
4. adapter 抛非 Error 值 → 用 `String(error)` 保留信息，不吞成 "Cannot ... undefined"。
5. 答案 rows/columns 从 registry 归一化，敏感列（is_sensitive / snake_case）剔除。

## 部署注意（上次崩溃教训）

- `git archive HEAD` 部署时，**package.json/lockfile 的 MCP 依赖必须随 HEAD 提交**，否则镜像 `npm ci` 缺包 → 启动崩（`ERR_MODULE_NOT_FOUND @modelcontextprotocol/sdk`）。
- 容器 `read_only: true`，Claude CLI 在 **Docker build 阶段**安装（Dockerfile `npm ci --include=dev`）。
- claude 分支**默认 `off`**，不触发不付昂贵调用；生产先验证 `mode=off` 时现有查询不受影响。
- `ANTHROPIC_API_KEY` 由部署环境变量注入，**不写进 git**。

## 待办（建议新会话执行，按序）

1. 读集成测试全文（423行），逐项实现缺失契约，跑绿 `claude-query-integration.test.mjs`。
2. `server.mjs` 加 `createClaudeQueryBridge` 依赖注入并传给 `createQueryService`（当前 server.mjs 未接 bridge）。
3. 全量测试 + `npm run lint` + `npm run build`。
4. 补充/更新契约测试与 SKILL.md 的对应关系。
5. 提交（含 package.json/lockfile 的 MCP 依赖），`git archive` 部署前确认依赖随 HEAD。
6. P0 真实验证：ECS 上 `claude-query-preflight.mjs --check-enabled --local-only`，再用真实 key 调一次最小请求。
