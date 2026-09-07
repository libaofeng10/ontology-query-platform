import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../../app/api.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function mockStream(t, frames) {
  const bytes = new TextEncoder().encode(frames.join("\n\n") + "\n\n");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  api.setApiToken("test-query-stream-token");
  t.after(() => api.clearApiToken());
}

const terminalResults = [
  ["final", { id: "answer", question: "订单数量", conclusion: "共 3 单", columns: [{ key: "count", label: "数量", type: "number" }], rows: [{ count: 3 }], chart: null, evidence: { pages: [], rules: [], tables: [], sql: "SELECT 3 AS count", durationMs: 1, scannedRows: 1 } }],
  ["refused", { refused: true, reason: "缺少已确认关系" }],
  ["clarification", { clarification: { pendingId: "pending", question: "选择业务范围", options: ["订单"], allowFreeText: true, expiresAt: "2026-09-08T00:00:00Z" }, sessionId: "session", planningMode: "agent", planningAttempts: 1, toolTrace: [] }],
];

for (const [type, result] of terminalResults) {
  test(`browser query stream handles ${type} after progress events`, async t => {
    const progress = [
      { type: "step", step: 1, status: "started" },
      { type: "thought", step: 1, text: "读取结构" },
      { type: "tool_call", step: 1, tool: "inspect_schema" },
      { type: "tool_result", step: 1, tool: "inspect_schema", ok: true, summary: "已读取", durationMs: 1 },
    ];
    mockStream(t, [...progress.map(event => `data: ${JSON.stringify(event)}`), `event: ${type}\ndata: ${JSON.stringify({ result })}`]);
    const events = [];
    assert.deepEqual(await api.askQuestion("订单数量", 1, undefined, { onEvent: event => events.push(event) }), result);
    assert.deepEqual(events, [...progress, { type, result }]);
  });
}

test("browser query stream ignores malformed objects and unsupported event types", async t => {
  const result = { refused: true, reason: "缺少数据源" };
  mockStream(t, [
    ": keep-alive",
    "data: not-json",
    "event: thought\ndata: null",
    "event: thought\ndata: 7",
    "event: thought\ndata: []",
    "event: heartbeat\ndata: {}",
    'data: {"type":"heartbeat"}',
    'data: {"type":"clarification","result":null}',
    `data: ${JSON.stringify({ type: "refused", result })}`,
  ]);
  const events = [];
  assert.deepEqual(await api.askQuestion("订单数量", 1, undefined, { onEvent: event => events.push(event) }), result);
  assert.deepEqual(events, [{ type: "refused", result }]);
});

test("browser query stream fails when no terminal result arrives", async t => {
  mockStream(t, ['data: {"type":"thought","step":1,"text":"读取结构"}']);
  await assert.rejects(api.askQuestion("订单数量", 1), /查询流在返回最终结果前中断/);
});
