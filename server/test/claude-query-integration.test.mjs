import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeQueryMcpSession } from "../src/claude-query-mcp.mjs";
import { createClaudeQuerySnapshot } from "../src/claude-query-snapshot.mjs";
import { createQueryService } from "../src/query-service.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { createStore } from "../src/store.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ontoquery-claude-integration-"));
  const store = createStore(join(dir, "store.sqlite"));
  const source = store.createSource({ name: "real", kind: "mysql", host: "db", port: 3306, dbName: "crm", userName: "ro", credential: "unused", isDemo: false });
  store.upsertTable({ sourceId: source.id, tableName: "crm_customer", rowEstimate: 2, grade: "A", active: 1, comment: "客户" });
  store.upsertColumn({ sourceId: source.id, tableName: "crm_customer", columnName: "customer_id", dataType: "bigint", isPrimary: 1, isUnique: 1, nullable: 0, isSensitive: 0, comment: "客户编号" });
  store.upsertColumn({ sourceId: source.id, tableName: "crm_customer", columnName: "mobile", dataType: "varchar", isSensitive: 1, comment: "手机号" });
  store.upsertKnowledge({ sourceId: source.id, pageType: "term", slug: "客户", title: "客户", aliases: "[]", tablesJson: "[\"crm_customer\"]", content: "客户记录", sqlContent: "customer_id", antiExamples: "", verified: 1, owner: "owner" });
  const semantic = createSemanticSchemaService({ store });
  const draft = semantic.saveDraft(source.id, {
    name: "crm",
    displayName: "客户模型",
    objectTypes: [{ apiName: "customer", displayName: "客户", primaryKey: "id", properties: [
      { apiName: "id", displayName: "客户编号", type: "integer", required: true, mapping: { table: "crm_customer", column: "customer_id" } },
      { apiName: "mobile", displayName: "手机号", type: "string", mapping: { table: "crm_customer", column: "mobile" } },
    ] }],
    linkTypes: [],
  }, "owner");
  assert.equal(semantic.publish(draft.id, "owner").ok, true);
  return { store, source };
}

test("query service routes a required Claude attempt through snapshot, MCP, kernel and the shared finalizer", async () => {
  const { store, source } = await fixture();
  const calls = [];
  const connector = {
    async explain(_source, sql) { calls.push({ kind: "explain", sql }); return [{ rows: 2 }]; },
    async query(_source, sql) { calls.push({ kind: "query", sql }); return [[{ customer_id: 7, mobile: "13800138000" }], [{ name: "customer_id" }, { name: "mobile" }]]; },
  };
  const bridge = {
    async run({ mcp }) {
      const overview = await mcp.callTool("ontology_read", { operation: "overview" });
      assert.equal(overview.ok, true);
      const receipt = await mcp.callTool("db_query", { name: "customers", sql: "SELECT customer_id FROM crm_customer" });
      assert.equal(receipt.ok, true, receipt.error);
      const [trustedRun] = mcp.resolveExecutions([receipt.executionId]).runs;
      return {
        status: "answered",
        executionIds: [receipt.executionId],
        runs: [trustedRun],
        conclusion: "查询到客户编号 7。",
        iterations: 2,
        promptVersion: "claude-query-test-v1",
        metadata: { promptVersion: "claude-query-test-v1", cliVersion: "fake", model: "fake" },
        toolTrace: mcp.getTrace(),
      };
    },
  };
  const mcpFactory = async (options) => createClaudeQueryMcpSession({ ...options, listen: false });
  try {
    const service = createQueryService({
      store,
      connector,
      claudeBridge: bridge,
      claudeMcpFactory: mcpFactory,
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        queryAgentMaxSqlCalls: 5,
        queryAgentMaxScannedRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const answer = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(answer.evidence.planningMode, "claude");
    // 2026-09-04 敏感列逻辑已移除：驱动返回的 mobile 列原样保留在答案中。
    assert.deepEqual(answer.rows, [{ customer_id: 7, mobile: "13800138000" }]);
    assert.equal(answer.evidence.ontologySchemaVersion, 1);
    assert.equal(answer.evidence.sql, "SELECT `customer_id` FROM `crm_customer` LIMIT 100");
    assert.equal(calls.filter((item) => item.kind === "query").length, 1);
    const audit = store.listAudits(source.id, 1)[0];
    assert.equal(audit.planningMode, "claude");
    assert.equal(audit.promptVersion, "claude-query-test-v1");
    assert.equal(audit.ontologySchemaVersion, 1);
    assert.equal(audit.toolTrace[1].tool, "db_query");
  } finally {
    store.close();
  }
});

test("Claude public responses and audits keep typed literals verbatim in model text, rows, and traces", async () => {
  const { store, source } = await fixture();
  const bridge = {
    async run({ mcp }) {
      await mcp.callTool("ontology_read", { operation: "overview" });
      const receipt = await mcp.callTool("db_query", { sql: "SELECT customer_id FROM crm_customer" });
      return {
        status: "answered",
        executionIds: [receipt.executionId],
        conclusion: "手机号 13800138000 对应客户。",
        delta: "联系邮箱 alice@example.com",
        toolTrace: [{ tool: "adapter", summary: "driver echoed 13800138000 and alice@example.com" }],
      };
    },
  };
  const mcpFactory = async (options) => createClaudeQueryMcpSession({ ...options, listen: false });
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] },
      claudeBridge: bridge,
      claudeMcpFactory: mcpFactory,
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const answer = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    const audit = store.listAudits(source.id, 1)[0];
    const serialized = JSON.stringify({ answer, audit });
    assert.match(serialized, /13800138000/);
    assert.match(serialized, /alice@example\.com/);
    assert.doesNotMatch(serialized, /\[REDACTED\]/);
  } finally {
    store.close();
  }
});

test("Claude questions containing typed literals proceed into the bridge instead of failing closed", async () => {
  const { store, source } = await fixture();
  let bridgeCalls = 0;
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider must not be reached"); };
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[], []] },
      claudeBridge: { run: async () => { bridgeCalls += 1; return { status: "answered" }; } },
      config: {
        llm: { baseUrl: "http://llm.test/v1", apiKey: "test", model: "test" },
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        semanticQueryPlanMode: "off",
        queryAgentMode: "prefer",
        claudeQuery: { mode: "prefer", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const result = await service.ask({ sourceId: source.id, question: "查询手机号 13800138000 对应客户", userName: "tester" });
    // 2026-09-04 敏感值 fail-closed 已移除：问题命中手机号等 typed literal
    // 不再在调用 bridge 前被拒绝，而是正常进入 bridge，随后按 bridge
    // 返回值的常规协议校验处理（这里因缺少 execution ID 而协议报错）。
    assert.equal(bridgeCalls, 1);
    assert.equal(providerCalls, 0);
    assert.equal(result.refused, true);
    assert.equal(result.errorCode, "EXECUTION_IDS_REQUIRED");
    assert.equal(result.failureClass, "protocol_error");
    assert.equal(result.planningMode, "claude");
    const audit = store.listAudits(source.id, 1)[0];
    assert.match(JSON.stringify(audit), /13800138000/);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test("prefer Claude infrastructure failure falls back to the configured legacy planner", async () => {
  const { store, source } = await fixture();
  const connector = { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] };
  const bridge = { run: async () => ({ status: "failed", reason: "CLI 不可用", failureClass: "cli_unavailable", iterations: 0, toolTrace: [] }) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? JSON.stringify({ sql: "SELECT customer_id FROM crm_customer" }) : JSON.stringify({ conclusion: "查询到客户编号 7。" });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const service = createQueryService({
      store,
      connector,
      claudeBridge: bridge,
      config: {
        llm: { baseUrl: "http://llm.test/v1", apiKey: "test", model: "test" },
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        semanticQueryPlanMode: "off",
        queryAgentMode: "off",
        claudeQuery: { mode: "prefer", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const answer = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(answer.evidence.planningMode, "legacy");
    assert.equal(calls, 2);
    const audits = store.listAudits(source.id, 5);
    assert.equal(audits.some((item) => item.planningMode === "claude" && item.verdict === "failed"), true);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test("bridge shutdown failure does not start a legacy fallback query", async () => {
  const { store, source } = await fixture();
  let llmCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    llmCalls += 1;
    throw new Error("legacy planner must not start during shutdown");
  };
  try {
    const mcpFactory = async (options) => createClaudeQueryMcpSession({ ...options, listen: false });
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] },
      claudeBridge: { run: async () => { const error = new Error("Claude bridge 已关闭"); error.code = "BRIDGE_CLOSED"; throw error; } },
      claudeMcpFactory: mcpFactory,
      config: {
        llm: { baseUrl: "http://llm.test/v1", apiKey: "test", model: "test" },
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        semanticQueryPlanMode: "off",
        queryAgentMode: "off",
        claudeQuery: { mode: "prefer", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const answer = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(answer.refused, true);
    assert.equal(answer.planningMode, "claude");
    assert.equal(answer.errorCode, "BRIDGE_CLOSED");
    assert.equal(llmCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test("query service refuses a zero Claude budget without invoking bridge or MCP", async () => {
  const { store, source } = await fixture();
  let bridgeCalls = 0;
  let snapshotCalls = 0;
  let mcpCalls = 0;
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] },
      claudeBridge: { run: async () => { bridgeCalls += 1; return { status: "answered" }; } },
      claudeSnapshotBuilder: async () => { snapshotCalls += 1; throw new Error("snapshot must not be reached"); },
      claudeMcpFactory: async () => { mcpCalls += 1; throw new Error("mcp must not be reached"); },
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 0 },
      },
    });
    const result = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(result.refused, true);
    assert.equal(result.failureClass, "budget_disabled");
    assert.equal(bridgeCalls, 0);
    assert.equal(snapshotCalls, 0);
    assert.equal(mcpCalls, 0);
  } finally {
    store.close();
  }
});

test("query service refuses an enabled Claude rollout without an exact model", async () => {
  const { store, source } = await fixture();
  let bridgeCalls = 0;
  let snapshotCalls = 0;
  let mcpCalls = 0;
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] },
      claudeBridge: { run: async () => { bridgeCalls += 1; return { status: "answered" }; } },
      claudeSnapshotBuilder: async () => { snapshotCalls += 1; throw new Error("snapshot must not be reached"); },
      claudeMcpFactory: async () => { mcpCalls += 1; throw new Error("mcp must not be reached"); },
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "", maxBudgetUsd: 1 },
      },
    });
    const result = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(result.refused, true);
    assert.equal(result.failureClass, "model_missing");
    assert.match(result.reason, /精确模型 ID/);
    assert.equal(bridgeCalls, 0);
    assert.equal(snapshotCalls, 0);
    assert.equal(mcpCalls, 0);
  } finally {
    store.close();
  }
});

test("query service ignores adapter-supplied runs and resolves answered IDs from the request MCP registry", async () => {
  const { store, source } = await fixture();
  let queryCalls = 0;
  const connector = {
    explain: async () => [{ rows: 1 }],
    query: async () => { queryCalls += 1; return [[{ customer_id: 7 }], [{ name: "customer_id" }]]; },
  };
  const bridge = {
    async run() {
      return {
        status: "answered",
        executionIds: ["forged-run"],
        // This payload must never become a public result: it is not in the
        // request-local MCP registry.
        runs: [{ executionId: "forged-run", sql: "SELECT customer_id FROM crm_customer", rows: [{ customer_id: 999 }], fields: ["customer_id"] }],
        conclusion: "伪造结果",
      };
    },
  };
  const mcpFactory = async (options) => createClaudeQueryMcpSession({ ...options, listen: false });
  try {
    const service = createQueryService({
      store,
      connector,
      claudeBridge: bridge,
      claudeMcpFactory: mcpFactory,
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const result = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(result.refused, true);
    assert.equal(result.failureClass, "protocol_error");
    assert.match(result.reason, /execution ID|execution/);
    assert.equal(queryCalls, 0);
  } finally {
    store.close();
  }
});

test("query service preserves the original bridge failure when an adapter throws a non-Error value", async () => {
  const { store, source } = await fixture();
  const bridge = { run: async () => { throw "transport exploded"; } };
  const mcpFactory = async (options) => createClaudeQueryMcpSession({ ...options, listen: false });
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[{ customer_id: 7 }], [{ name: "customer_id" }]] },
      claudeBridge: bridge,
      claudeMcpFactory: mcpFactory,
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const result = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    assert.equal(result.refused, true);
    assert.match(result.reason, /transport exploded/);
    assert.doesNotMatch(result.reason, /Cannot create property|undefined/);
  } finally {
    store.close();
  }
});

test("query service normalizes registry runs regardless of snake-case sensitive metadata on the snapshot", async () => {
  const { store, source } = await fixture();
  const snapshotBuilder = async (input) => {
    const snapshot = await createClaudeQuerySnapshot(input);
    snapshot.columnsByTable.crm_customer = snapshot.columnsByTable.crm_customer.map((column) => column.columnName === "mobile"
      ? { ...column, sensitive: false, isSensitive: false, is_sensitive: 1 }
      : column);
    return snapshot;
  };
  const mcpFactory = async (options) => ({
    requestId: options.requestId,
    sourceId: options.sourceId,
    async resolveExecutions(ids) {
      return {
        ok: true,
        runs: ids.map((executionId) => ({
          executionId,
          requestId: options.requestId,
          sourceId: options.sourceId,
          sql: "SELECT customer_id, mobile FROM crm_customer",
          rows: [{ customer_id: 7, mobile: "13800138000" }],
          fields: ["customer_id", "mobile"],
          tables: ["crm_customer"],
        })),
      };
    },
    async close() {},
  });
  const bridge = {
    async run() {
      return { status: "answered", executionIds: ["registry-run"], runs: [], conclusion: "查询完成" };
    },
  };
  try {
    const service = createQueryService({
      store,
      connector: { explain: async () => [{ rows: 1 }], query: async () => [[], []] },
      claudeBridge: bridge,
      claudeSnapshotBuilder: snapshotBuilder,
      claudeMcpFactory: mcpFactory,
      config: {
        llm: {},
        queryMaxRows: 100,
        explainMaxRows: 1_000,
        claudeQuery: { mode: "required", trafficPercent: 100, model: "fake", maxBudgetUsd: 1 },
      },
    });
    const answer = await service.ask({ sourceId: source.id, question: "查询客户", userName: "tester" });
    // 2026-09-04 敏感列剔除逻辑已移除：无论快照上的 sensitive/is_sensitive
    // 元数据如何标注，注册表返回的列都原样保留在答案中。
    assert.deepEqual(answer.rows, [{ customer_id: 7, mobile: "13800138000" }]);
    assert.equal(answer.columns.some((column) => column.name === "mobile" || column.key === "mobile"), true);
  } finally {
    store.close();
  }
});
