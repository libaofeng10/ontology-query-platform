import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicClaudeBridge,
  runClaudeCandidatePairwise,
  validateFixture,
} from "../src/claude-query-local-eval.mjs";

test("local Claude pairwise harness compares outcomes and keeps typed literals verbatim", async () => {
  const fixture = {
    version: "test-v1",
    setName: "local",
    cases: [
      {
        id: "phone-case",
        category: "敏感边界",
        question: "手机号 13800138000 对应客户",
        expectedRows: [{ customer_id: 7 }],
        baseline: { status: "answered", rows: [{ customer_id: 9 }], durationMs: 20, localOnly: true },
      },
      {
        id: "plain-case",
        category: "正确性",
        question: "统计客户数",
        expectedRows: [{ total: 2 }],
        baseline: { status: "answered", rows: [{ total: 2 }], durationMs: 30, localOnly: true },
      },
    ],
  };
  const report = await runClaudeCandidatePairwise({
    setName: fixture.setName,
    cases: fixture.cases,
    baselineRunner: async (item) => item.baseline,
    candidateRunner: async (item) => ({
      status: "answered",
      rows: item.expectedRows,
      durationMs: 10,
      planningMode: "claude",
      localOnly: true,
      paidApiCalls: 0,
      tokenUsage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, available: true },
    }),
  });
  assert.equal(report.mode, "local_fake");
  assert.equal(report.candidateMode, "required");
  assert.equal(report.productionGate, false);
  assert.equal(report.baseline.passRate, 0.5);
  assert.equal(report.candidate.passRate, 1);
  assert.deepEqual(report.delta.regressions, []);
  assert.deepEqual(report.delta.improvements, ["phone-case"]);
  assert.equal(report.safety.localOnly, true);
  assert.equal(report.safety.paidApiCalls, 0);
  assert.match(JSON.stringify(report), /13800138000/);
  assert.doesNotMatch(JSON.stringify(report), /\[REDACTED\]/);
});

test("deterministic fake bridge uses only request MCP and advertises no paid call", async () => {
  const calls = [];
  const mcp = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "ontology_read") return { ok: true, operation: args.operation };
      if (name === "db_query") return { ok: true, executionId: "local-exec-1" };
      return { ok: false, errorCode: "UNKNOWN_TOOL", error: "not allowed" };
    },
    getTrace() { return calls.map((item) => ({ tool: item.name, ok: true })); },
  };
  const bridge = createDeterministicClaudeBridge({
    plans: { "查询客户": { sql: "SELECT customer_id FROM customer", conclusion: "完成" } },
  });
  const outcome = await bridge.run({ question: "查询客户", mcp, requireModel: true });
  assert.equal(outcome.status, "answered");
  assert.deepEqual(outcome.executionIds, ["local-exec-1"]);
  assert.deepEqual(calls.map((item) => item.name), ["ontology_read", "db_query"]);
  assert.equal(bridge.localOnly, true);
  assert.equal(bridge.paidApiCalls, 0);
  assert.equal(outcome.localOnly, true);
  assert.equal(outcome.paidApiCalls, 0);
});

test("fixture validation rejects a candidate fixture without expected rows or baseline", () => {
  assert.throws(() => validateFixture({ cases: [{ question: "x", candidate: {} }] }), /expectedRows/);
  assert.throws(() => validateFixture({ cases: [{ question: "x", expectedRows: [] }] }), /baseline/);
});

