import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createClaudeQueryMcpSession } from "../src/claude-query-mcp.mjs";
import { createClaudeQuerySnapshot } from "../src/claude-query-snapshot.mjs";

function snapshot() {
  return createClaudeQuerySnapshot({
    sourceId: 1,
    published: { sourceId: 1, version: 1, status: "published", schema: { name: "crm", objectTypes: [{ apiName: "customer", properties: [{ apiName: "id", mapping: { table: "customer", column: "id" } }, { apiName: "phone", mapping: { table: "customer", column: "phone" } }], }], linkTypes: [] } },
    catalog: { tables: [{ tableName: "customer" }], columnsByTable: { customer: [{ columnName: "id", dataType: "int", isPrimary: 1 }, { columnName: "phone", dataType: "varchar", isSensitive: 1 }] }, relations: [] },
  });
}

test("MCP tools use the snapshot/kernel boundary and keep full rows private", async () => {
  const calls = [];
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    executeFn: async ({ name, sql, disclosedTables }) => {
      calls.push({ name, sql, disclosedTables });
      return { rows: [{ id: 1, phone: "13800138000" }], fields: ["id", "phone"], rowCount: 1, scannedRows: 2, durationMs: 4 };
    },
  });
  try {
    const before = await session.callTool("db_query", { sql: "SELECT id FROM customer" });
    assert.equal(before.errorCode, "TABLE_NOT_DISCLOSED");
    const read = await session.callTool("ontology_read", { operation: "get_objects", ids: ["customer"] });
    assert.equal(read.ok, true);
    const result = await session.callTool("db_query", { name: "customers", sql: "SELECT id, phone FROM customer" });
    assert.equal(result.ok, true);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.previewRows, [{ id: 1 }]);
    assert.equal(result.columns.includes("phone"), false);
    assert.equal(calls.length, 1);
    const full = session.registry.get(result.executionId);
    assert.deepEqual(full.rows, [{ id: 1, phone: "13800138000" }]);
    assert.equal(session.registry.resolve([result.executionId]).runs[0].sql, "SELECT id, phone FROM customer");
  } finally {
    await session.close();
  }
  assert.equal(session.active, false);
  assert.equal(session.registry.size, 0);
});

test("MCP JSON-RPC exposes only the two tools and authenticates HTTP-shaped calls", async () => {
  const session = await createClaudeQueryMcpSession({ snapshot: snapshot(), listen: false });
  try {
    const init = await session.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(init.result.serverInfo.name, "ontoquery");
    const listed = await session.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["ontology_read", "db_query"]);
    const denied = await session.handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shell", arguments: {} } });
    assert.equal(denied.result.isError, true);
    const badSession = await session.handleRequest({ jsonrpc: "2.0", id: 4, method: "ping" }, { sessionId: "other" });
    assert.equal(badSession.error.code, -32002);
  } finally { await session.close(); }
});

test("MCP blocks unknown tables and writes before invoking the kernel", async () => {
  let calls = 0;
  const session = await createClaudeQueryMcpSession({ snapshot: snapshot(), listen: false, initialDisclosedTables: ["customer"], executeFn: async () => { calls++; return { rows: [], fields: [] }; } });
  try {
    const unknown = await session.callTool("db_query", { sql: "SELECT id FROM other_table" });
    assert.equal(unknown.errorCode, "UNKNOWN_TABLE");
    const write = await session.callTool("db_query", { sql: "DELETE FROM customer" });
    assert.equal(write.errorCode, "READ_ONLY_REQUIRED");
    assert.equal(calls, 0);
  } finally { await session.close(); }
});

test("MCP rejects database-qualified tables before an injected executor can bypass the guard", async () => {
  let calls = 0;
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    initialDisclosedTables: ["customer"],
    executeFn: async () => { calls += 1; return { rows: [], fields: [] }; },
  });
  try {
    const result = await session.callTool("db_query", { sql: "SELECT id FROM other_db.customer" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "CROSS_DATABASE_FORBIDDEN");
    assert.equal(calls, 0);
  } finally { await session.close(); }
});

test("MCP rejects database-qualified column references before an injected executor", async () => {
  let calls = 0;
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    initialDisclosedTables: ["customer"],
    executeFn: async () => { calls += 1; return { rows: [], fields: [] }; },
  });
  try {
    const result = await session.callTool("db_query", {
      sql: "SELECT other_db.customer.id FROM customer",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "CROSS_DATABASE_FORBIDDEN");
    assert.equal(calls, 0);
  } finally { await session.close(); }
});

test("MCP treats WITH aliases as query-local names while validating physical tables", async () => {
  let calls = 0;
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    initialDisclosedTables: ["customer"],
    executeFn: async ({ sql }) => { calls++; return { rows: [{ id: 1 }], fields: ["id"], sql }; },
  });
  try {
    const result = await session.callTool("db_query", { sql: "WITH picked AS (SELECT id FROM customer) SELECT id FROM picked" });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls, 1);
  } finally { await session.close(); }
});

test("MCP handles multiple and recursive CTE aliases without widening physical table scope", async () => {
  let calls = 0;
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(), listen: false, initialDisclosedTables: ["customer"],
    executeFn: async ({ sql }) => { calls += 1; return { rows: [{ id: 1 }], fields: ["id"], sql }; },
  });
  try {
    const result = await session.callTool("db_query", {
      sql: "WITH RECURSIVE first_rows AS (SELECT id FROM customer), second_rows(id) AS (SELECT id FROM first_rows) SELECT id FROM second_rows",
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls, 1);
  } finally { await session.close(); }
});

test("MCP preview redacts catalog columns marked with isSensitive", async () => {
  const columns = [
    { columnName: "id", isSensitive: 0 },
    { columnName: "phone", isSensitive: 1 },
  ];
  const disclosedTables = new Set(["customer"]);
  const snapshot = {
    allowedTableNames: ["customer"],
    allowedColumnsByTable: { customer: columns },
    columnsByTable: { customer: columns },
    disclosedTables,
    disclose() {},
    read: async () => ({ tables: [{ tableName: "customer" }] }),
  };
  const session = await createClaudeQueryMcpSession({
    snapshot,
    listen: false,
    executeFn: async () => ({ rows: [{ id: 1, phone: "13800138000" }], fields: ["id", "phone"] }),
  });
  try {
    const result = await session.callTool("db_query", { sql: "SELECT id, phone FROM customer" });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.previewRows, [{ id: 1 }]);
    assert.deepEqual(result.columns, ["id"]);
  } finally { await session.close(); }
});

test("MCP preview redacts sensitive columns without depending on driver casing", async () => {
  const columns = [
    { columnName: "id", isSensitive: 0 },
    { columnName: "phone", isSensitive: 1 },
  ];
  const snapshot = {
    allowedTableNames: ["customer"],
    columnsByTable: { customer: columns },
    disclosedTables: new Set(["customer"]),
    disclose() {},
    read: async () => ({ tables: [{ tableName: "customer" }] }),
  };
  const session = await createClaudeQueryMcpSession({
    snapshot,
    listen: false,
    executeFn: async () => ({ rows: [{ id: 1, PHONE: "13800138000" }], fields: ["id", "PHONE"] }),
  });
  try {
    const result = await session.callTool("db_query", { sql: "SELECT id, phone FROM customer" });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.previewRows, [{ id: 1 }]);
    assert.deepEqual(result.columns, ["id"]);
  } finally { await session.close(); }
});

test("MCP preview redacts qualified and quoted sensitive field labels", async () => {
  const columns = [
    { columnName: "id", isSensitive: 0 },
    { columnName: "phone", isSensitive: 1 },
  ];
  const snapshot = {
    allowedTableNames: ["customer"],
    columnsByTable: { customer: columns },
    disclosedTables: new Set(["customer"]),
    disclose() {},
    read: async () => ({ tables: [{ tableName: "customer" }] }),
  };
  const session = await createClaudeQueryMcpSession({
    snapshot,
    listen: false,
    executeFn: async () => ({ rows: [{ id: 1, "`customer`.`phone`": "13800138000" }], fields: ["id", "`customer`.`phone`"] }),
  });
  try {
    const result = await session.callTool("db_query", { sql: "SELECT id, phone FROM customer" });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.previewRows, [{ id: 1 }]);
    assert.deepEqual(result.columns, ["id"]);
  } finally { await session.close(); }
});

test("MCP redacts typed literals echoed by executor and JSON-RPC errors", async () => {
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    initialDisclosedTables: ["customer"],
    executeFn: async () => {
      throw new Error("driver rejected value phone=13800138000 email=person@example.com");
    },
  });
  try {
    const toolResult = await session.callTool("db_query", {
      sql: "SELECT id FROM customer WHERE phone = '13800138000'",
    });
    assert.equal(toolResult.ok, false);
    assert.doesNotMatch(toolResult.error, /13800138000|person@example\.com/);
    assert.match(toolResult.error, /\[REDACTED\]/);

    const rpcResult = await session.handleRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "db_query", arguments: { sql: "SELECT id FROM customer WHERE phone = '13800138000'" } },
    });
    const payload = rpcResult.result?.structuredContent || {};
    assert.equal(payload.ok, false);
    assert.doesNotMatch(JSON.stringify(rpcResult), /13800138000|person@example\.com/);
  } finally { await session.close(); }
});

test("MCP preview applies value-level redaction as a defense in depth", async () => {
  const columns = [
    { columnName: "id", isSensitive: 0 },
    { columnName: "note", isSensitive: 0 },
    { columnName: "payload", isSensitive: 0 },
  ];
  const session = await createClaudeQueryMcpSession({
    snapshot: {
      allowedTableNames: ["customer"],
      columnsByTable: { customer: columns },
      disclosedTables: new Set(["customer"]),
      disclose() {},
      read: async () => ({ tables: [{ tableName: "customer" }] }),
    },
    listen: false,
    executeFn: async () => ({
      rows: [{ id: 1, note: "联系 13800138000", payload: { email: "person@example.com" } }],
      fields: ["id", "note", "payload"],
    }),
  });
  try {
    const result = await session.callTool("db_query", { sql: "SELECT id, note, payload FROM customer" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.previewRows[0].note, "联系 [REDACTED]");
    assert.doesNotMatch(result.previewRows[0].payload, /person@example\.com/);
  } finally { await session.close(); }
});

test("MCP session close is bounded when an injected transport never settles", async () => {
  const session = await createClaudeQueryMcpSession({
    snapshot: snapshot(),
    listen: false,
    closeTimeoutMs: 25,
    transport: {
      async start() {},
      close() { return new Promise(() => {}); },
    },
  });
  const started = Date.now();
  await session.close();
  const elapsed = Date.now() - started;
  assert.equal(session.active, false);
  assert.ok(elapsed < 1_000, `close took ${elapsed}ms`);
});

test("MCP session close aborts a half-open HTTP body", async (t) => {
  let session;
  let request;
  try {
    session = await createClaudeQueryMcpSession({
      snapshot: snapshot(),
      listen: true,
      bodyTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip(`loopback bind unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const endpoint = new URL(session.url);
  const requestEnded = new Promise((resolve) => {
    request = httpRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        "content-length": "100",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve("response"));
    });
    request.once("error", () => resolve("error"));
    request.once("close", () => resolve("close"));
    request.write('{"jsonrpc":"2.0"');
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await session.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `close took ${elapsed}ms`);
    assert.equal(session.active, false);
    await Promise.race([
      requestEnded,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } finally {
    request?.destroy();
    await session.close();
  }
});

test("official Streamable HTTP transport completes initialize, tools/list and tools/call", async (t) => {
  let session;
  try {
    session = await createClaudeQueryMcpSession({
      snapshot: snapshot(),
      listen: true,
      initialDisclosedTables: ["customer"],
      executeFn: async () => ({ rows: [{ id: 7 }], fields: ["id"] }),
    });
  } catch (error) {
    // Some restricted local runners prohibit even loopback binds. Keep the
    // protocol test active in CI/production-like runners while making the
    // repository's normal unit suite deterministic in those sandboxes.
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip(`loopback bind unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const token = session.token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    connection: "close",
  };
  const rpc = async (message, extra = {}) => {
    const response = await fetch(session.url, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };

  try {
    const initialized = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.result.serverInfo.name, "ontoquery");
    const sessionHeader = initialized.response.headers.get("mcp-session-id");
    assert.equal(sessionHeader, session.state.sessionId);

    const notification = await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { "mcp-session-id": sessionHeader });
    assert.equal(notification.response.status, 202);

    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sessionHeader });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ["ontology_read", "db_query"]);

    const called = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "db_query", arguments: { sql: "SELECT id FROM customer" } },
    }, { "mcp-session-id": sessionHeader });
    assert.equal(called.response.status, 200);
    assert.equal(called.body.result.structuredContent.ok, true);
    assert.equal(called.body.result.structuredContent.rowCount, 1);

    const denied = await fetch(session.url, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer invalid-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    });
    assert.equal(denied.status, 401);
  } finally {
    await session.close();
  }
});
