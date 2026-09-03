import assert from "node:assert/strict";
import test from "node:test";
import { createQueryExecutionKernel } from "../src/query-execution-kernel.mjs";
import { guardSql } from "../src/sql-guard.mjs";

function fixture({ rows = [{ id: 1, label: "ok" }], explainRows = [{ rows: 2 }], policy = {}, disclosedTables = ["demo_table"], config = {} } = {}) {
  const calls = [];
  const connector = {
    async explain(source, sql) { calls.push({ kind: "explain", sql }); return explainRows; },
    async query(source, sql, params, signal) {
      calls.push({ kind: "query", sql, params, signal });
      return [rows, Object.keys(rows[0] || {}).map((name) => ({ name }))];
    },
  };
  const catalog = {
    columnsByTable: { demo_table: [{ columnName: "id", dataType: "bigint", isSensitive: 0 }, { columnName: "label", dataType: "varchar", isSensitive: 0 }] },
    policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["id", "label"] }, maxRows: 10, ...policy },
    relations: [],
    enums: {},
  };
  const kernel = createQueryExecutionKernel({ source: { id: 1 }, connector, catalog, config: { queryMaxRows: 10, explainMaxRows: 100, queryAgentMaxSqlCalls: 3, queryAgentMaxScannedRows: 100, ...config }, question: "", disclosedTables });
  return { kernel, calls };
}

test("execution kernel performs the guarded explain/query sequence and registers a private full run", async () => {
  const { kernel, calls } = fixture({ rows: [{ id: 1, label: "ok" }] });
  const result = await kernel.execute({ name: "demo", sql: "SELECT id, label FROM demo_table" });
  assert.equal(result.ok, true, result.error);
  assert.match(result.executedSql, /LIMIT 10/i);
  assert.equal(result.executionId.startsWith("qe_"), true);
  assert.deepEqual(calls.map((item) => item.kind), ["explain", "query"]);
  assert.equal("run" in result, false, "full rows must not be sent in the tool response");
  const run = kernel.getRun(result.executionId);
  assert.equal(run.name, "demo");
  assert.deepEqual(run.rows, [{ id: 1, label: "ok" }]);
  assert.deepEqual(kernel.resolveExecutionIds([result.executionId]), { ok: true, runs: [run] });
});

test("guard and disclosure failures stop before EXPLAIN or database query", async () => {
  const first = fixture();
  const denied = await first.kernel.execute({ sql: "DELETE FROM demo_table" });
  assert.equal(denied.ok, false);
  assert.equal(first.calls.length, 0);

  const undisclosed = fixture({ disclosedTables: [] });
  const result = await undisclosed.kernel.execute({ sql: "SELECT id FROM demo_table", requireDisclosure: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DISCLOSURE_REQUIRED");
  assert.equal(result.stage, "guard");
  assert.equal(result.retryable, true);
  assert.equal(undisclosed.calls.length, 0);
});

test("execution IDs are scoped to the kernel and duplicate or unknown IDs fail closed", async () => {
  const { kernel } = fixture();
  const result = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  const duplicate = kernel.resolveExecutionIds([result.executionId, result.executionId]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "EXECUTION_ID_DUPLICATE");
  const unknown = kernel.resolveExecutionIds(["qe_not-issued"]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "EXECUTION_ID_UNKNOWN");
});

test("EXPLAIN scan limits apply per query and cumulatively", async () => {
  const { kernel, calls } = fixture({ explainRows: [{ rows: 60 }], config: { explainMaxRows: 100, queryAgentMaxScannedRows: 100 } });
  const first = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  assert.equal(first.ok, true);
  const second = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "SCAN_BUDGET_EXCEEDED");
  assert.equal(calls.filter((item) => item.kind === "query").length, 1);
});

test("kernel forwards its request signal to EXPLAIN and query connectors", async () => {
  const signal = new AbortController().signal;
  let explainSignal;
  let querySignal;
  const connector = {
    async explain(_source, _sql, receivedSignal) { explainSignal = receivedSignal; return [{ rows: 1 }]; },
    async query(_source, _sql, _params, receivedSignal) { querySignal = receivedSignal; return [[{ id: 1 }], [{ name: "id" }]]; },
  };
  const kernel = createQueryExecutionKernel({
    source: { id: 1 }, connector, signal, disclosedTables: ["demo_table"],
    catalog: { columnsByTable: { demo_table: [{ columnName: "id" }] }, policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["id"] }, maxRows: 10 }, relations: [], enums: {} },
  });
  const result = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(explainSignal, signal);
  assert.equal(querySignal, signal);
});

test("kernel caps connector over-return and marks the receipt incomplete", async () => {
  const connector = {
    async explain() { return [{ rows: 1 }]; },
    async query() { return [[{ id: 1 }, { id: 2 }, { id: 3 }], [{ name: "id" }]]; },
  };
  const kernel = createQueryExecutionKernel({
    source: { id: 1 }, connector, disclosedTables: ["demo_table"],
    catalog: { columnsByTable: { demo_table: [{ columnName: "id" }] }, policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["id"] }, maxRows: 2 }, relations: [], enums: {} },
    config: { queryMaxRows: 2 },
  });
  const result = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.rowCount, 2);
  assert.equal(result.mayBeTruncated, true);
  assert.deepEqual(kernel.getRun(result.executionId).rows, [{ id: 1 }, { id: 2 }]);
});

test("sensitive columns can be used as typed filters but cannot be selected when output policy is enabled", async () => {
  const calls = [];
  const connector = { explain: async () => [{ rows: 1 }], query: async (_source, sql) => { calls.push(sql); return [[{ id: 1 }], [{ name: "id" }]]; } };
  const catalog = {
    columnsByTable: { demo_table: [{ columnName: "id", isSensitive: 0 }, { columnName: "mobile", isSensitive: 1 }] },
    policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["id", "mobile"] }, columnKinds: { "demo_table.mobile": "phone" }, maxRows: 10 },
    relations: [], enums: {},
  };
  const guardPolicy = { ...catalog.policy, forbiddenOutputColumns: ["demo_table.mobile"] };
  assert.equal(guardSql("SELECT id FROM demo_table WHERE mobile = '13800138000'", guardPolicy).ok, true);
  const kernel = createQueryExecutionKernel({ source: { id: 1 }, connector, catalog, question: "查询手机号 13800138000 对应的客户编号", disclosedTables: ["demo_table"], forbidSensitiveOutput: true, config: { queryMaxRows: 10 } });
  const allowed = await kernel.execute({ sql: "SELECT id FROM demo_table" });
  assert.equal(allowed.ok, true, allowed.error);
  const forbidden = await kernel.execute({ sql: "SELECT mobile FROM demo_table" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "SENSITIVE_OUTPUT_FORBIDDEN");
  assert.equal(calls.length, 1);
});

test("snapshot-style sensitive flag is enforced by the shared kernel", async () => {
  const connector = { explain: async () => [{ rows: 1 }], query: async () => [[{ phone: "hidden" }], [{ name: "phone" }]] };
  const kernel = createQueryExecutionKernel({
    source: { id: 1 }, connector, disclosedTables: ["demo_table"], forbidSensitiveOutput: true,
    catalog: {
      columnsByTable: { demo_table: [{ columnName: "phone", sensitive: true }] },
      policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["phone"] }, maxRows: 10 },
    },
    config: { queryMaxRows: 10 },
  });
  const result = await kernel.execute({ sql: "SELECT phone FROM demo_table" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SENSITIVE_OUTPUT_FORBIDDEN");
});

test("policy overrides can only narrow catalog tables, columns, relations, and output denies", async () => {
  const relation = { id: 7, fromTable: "demo_table", fromCol: "id", toTable: "other_table", toCol: "demo_id" };
  const calls = [];
  const connector = {
    async explain(_source, sql) { calls.push({ kind: "explain", sql }); return [{ rows: 1 }]; },
    async query() { calls.push({ kind: "query" }); return [[{ id: 1 }], [{ name: "id" }]]; },
  };
  const kernel = createQueryExecutionKernel({
    source: { id: 1 }, connector, disclosedTables: ["demo_table", "other_table"], forbidSensitiveOutput: true,
    catalog: {
      columnsByTable: {
        demo_table: [{ columnName: "id" }, { columnName: "secret", isSensitive: 1 }],
        other_table: [{ columnName: "demo_id" }],
      },
      policy: {
        allowedTables: ["demo_table", "other_table"],
        allowedColumns: { demo_table: ["id", "secret"], other_table: ["demo_id"] },
        allowedRelations: [relation],
        forbiddenOutputColumns: ["demo_table.secret"],
        maxRows: 10,
      },
      relations: [relation],
    },
    config: { queryMaxRows: 10 },
  });

  const widenedTable = await kernel.execute({
    sql: "SELECT id FROM unknown_table",
    policy: { allowedTables: ["unknown_table"], allowedColumns: { unknown_table: ["id"] } },
  });
  assert.equal(widenedTable.ok, false);
  assert.equal(widenedTable.code, "UNKNOWN_TABLE");

  const clearedSensitiveDeny = await kernel.execute({
    sql: "SELECT secret FROM demo_table",
    policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["secret"] }, forbiddenOutputColumns: [] },
  });
  assert.equal(clearedSensitiveDeny.ok, false);
  assert.equal(clearedSensitiveDeny.code, "SENSITIVE_OUTPUT_FORBIDDEN");

  const omittedColumnTable = await kernel.execute({
    sql: "SELECT demo_id FROM other_table",
    policy: { allowedColumns: { demo_table: ["id"] } },
  });
  assert.equal(omittedColumnTable.ok, false);
  assert.equal(omittedColumnTable.code, "UNKNOWN_COLUMN");

  const widenedRelation = await kernel.execute({
    sql: "SELECT d.id FROM demo_table d JOIN other_table o ON d.id = o.demo_id",
    policy: { allowedTables: ["demo_table", "other_table"], allowedColumns: { demo_table: ["id"], other_table: ["demo_id"] }, allowedRelations: [{ id: 999, fromTable: "demo_table", fromCol: "secret", toTable: "other_table", toCol: "demo_id" }] },
  });
  assert.equal(widenedRelation.ok, false);
  assert.equal(widenedRelation.code, "UNCONFIRMED_RELATION");
  assert.equal(calls.filter((item) => item.kind === "query").length, 0);

  const narrowed = await kernel.execute({
    sql: "SELECT id FROM demo_table",
    policy: { allowedTables: ["demo_table"], allowedColumns: { demo_table: ["id"] }, allowedRelations: [] },
  });
  assert.equal(narrowed.ok, true, narrowed.reason);
  assert.equal(kernel.registry.resolve([narrowed.executionId]).ok, true);
});
