import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactTypedLiterals } from "./query-column-semantics.mjs";

export const CLAUDE_QUERY_MCP_SERVER_NAME = "ontoquery";
export const CLAUDE_QUERY_MCP_PROTOCOL_VERSION = "2025-06-18";
export const CLAUDE_QUERY_MCP_PATH = "/mcp";
export const CLAUDE_QUERY_MCP_MAX_BODY_BYTES = 256 * 1024;
export const CLAUDE_QUERY_MCP_MAX_PREVIEW_ROWS = 20;
export const CLAUDE_QUERY_MCP_MAX_PREVIEW_BYTES = 24 * 1024;
// Request-local MCP listeners are intentionally short lived.  Keep all
// shutdown and body-read waits bounded so a client that never finishes a
// request cannot pin the query worker indefinitely.
export const CLAUDE_QUERY_MCP_CLOSE_TIMEOUT_MS = 5_000;
export const CLAUDE_QUERY_MCP_BODY_TIMEOUT_MS = 30_000;

export const CLAUDE_QUERY_MCP_TOOLS = Object.freeze([
  {
    name: "ontology_read",
    description: "读取当前请求已授权的已发布业务本体元数据。只能读取工具返回的对象、属性、关系、知识和规则。",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["overview", "search", "get_objects", "get_relations", "get_knowledge"] },
        query: { type: "string", maxLength: 500 },
        ids: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 },
        cursor: { type: "string", maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "db_query",
    description: "执行一条受平台安全内核校验的只读 SELECT；完整结果不会返回给模型，只返回执行凭据和受限预览。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        sql: { type: "string", minLength: 1, maxLength: 100_000 },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
]);

export class ClaudeQueryMcpError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ClaudeQueryMcpError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Create one short-lived MCP session for one query request.
 *
 * Direct `callTool`/`handleRequest` calls remain available for unit tests and
 * in-process callers. The production listening path uses the official
 * Streamable HTTP transport from `@modelcontextprotocol/sdk`; both paths share
 * the same request-bound tool dispatch and execution registry.
 */
export async function createClaudeQueryMcpSession(options = {}) {
  const snapshot = options.snapshot;
  if (!snapshot && !options.transport) {
    throw new ClaudeQueryMcpError("SNAPSHOT_REQUIRED", "MCP session 需要请求级 ontology snapshot", 500);
  }
  const host = normalizeHost(options.host ?? "127.0.0.1", options.allowNonLoopback === true);
  const path = normalizePath(options.path ?? CLAUDE_QUERY_MCP_PATH);
  const token = normalizeToken(options.token);
  const requestId = String(options.requestId ?? randomUUID());
  const sourceId = options.sourceId ?? options.source?.id ?? snapshot?.sourceId ?? null;
  // A session is request- and source-bound.  Treat an explicitly supplied
  // source identity that disagrees with the published snapshot as a factory
  // error rather than allowing a caller to pair one source's connector with
  // another source's ontology scope.
  if (snapshot?.sourceId != null && sourceId != null && !sameSourceId(snapshot.sourceId, sourceId)) {
    throw new ClaudeQueryMcpError("SOURCE_SCOPE_MISMATCH", "MCP session 的 sourceId 与 ontology snapshot 不一致", 500);
  }
  if (options.source?.id != null && sourceId != null && !sameSourceId(options.source.id, sourceId)) {
    throw new ClaudeQueryMcpError("SOURCE_SCOPE_MISMATCH", "MCP session 的 source 与 sourceId 不一致", 500);
  }
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, CLAUDE_QUERY_MCP_MAX_BODY_BYTES, 1_024, 4 * 1024 * 1024);
  const closeTimeoutMs = boundedInteger(options.closeTimeoutMs, CLAUDE_QUERY_MCP_CLOSE_TIMEOUT_MS, 10, 60_000);
  const bodyTimeoutMs = boundedInteger(options.bodyTimeoutMs, CLAUDE_QUERY_MCP_BODY_TIMEOUT_MS, 10, 10 * 60_000);
  const previewRows = boundedInteger(options.previewRows, CLAUDE_QUERY_MCP_MAX_PREVIEW_ROWS, 0, 100);
  const previewBytes = boundedInteger(options.previewBytes, CLAUDE_QUERY_MCP_MAX_PREVIEW_BYTES, 1_024, 256 * 1024);
  const state = {
    active: true,
    initialized: false,
    sessionId: randomUUID(),
    requestId,
    sourceId,
    snapshot,
    token,
    host,
    path,
    maxBodyBytes,
    closeTimeoutMs,
    bodyTimeoutMs,
    previewRows,
    previewBytes,
    kernel: options.kernel || null,
    kernelFactory: options.kernelFactory,
    executeFn: options.executeFn,
    transport: options.transport || null,
    useSdkTransport: options.useSdkTransport !== false,
    sdkServer: null,
    sdkTransport: null,
    runs: new Map(),
    trace: [],
    server: null,
    serverClosePromise: null,
    sockets: new Set(),
    requests: new Set(),
    closeController: new AbortController(),
    closed: false,
    closePromise: null,
  };

  // Honour request-local disclosure supplied by the coordinator even when a
  // prebuilt snapshot object is passed in.  Without this, callers that have
  // already audited a table must redundantly perform ontology_read before a
  // first db_query (and, worse, the option appears to be accepted but is
  // silently ignored).
  if (snapshot?.disclose) snapshot.disclose(options.initialDisclosedTables ?? options.disclosedTables ?? []);

  if (!state.kernel && typeof state.kernelFactory === "function") {
    state.kernel = await state.kernelFactory({
      source: options.source,
      sourceId,
      requestId,
      snapshot,
      signal: options.signal,
    });
  }
  if (state.transport?.start) await state.transport.start({ requestId, sourceId, snapshot, token });

  const session = makeSession(state, options);
  if (options.listen === false || (state.transport && options.listen !== true)) {
    session.url = state.transport?.url || null;
    session.endpoint = session.url;
    return session;
  }

  // An injected transport is an explicit test/in-process seam; keep the
  // legacy adapter for it.  The SDK path is the default only for the real
  // request-local HTTP listener.
  if (state.useSdkTransport && !state.transport) return startSdkHttpSession(session, state, options);

  const server = createTrackedHttpServer(state, (request, response) => {
    void handleHttpRequest(session, request, response);
  });
  state.server = server;
  const port = boundedInteger(options.port, 0, 0, 65_535);
  await listen(server, port, host);
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  session.port = actualPort;
  session.url = `http://${formatUrlHost(host)}:${actualPort}${path}`;
  session.endpoint = session.url;
  return session;
}

export const createClaudeQueryMcp = createClaudeQueryMcpSession;

/**
 * Start the standards-compliant Streamable HTTP endpoint used by Claude Code.
 * The SDK owns MCP lifecycle/session validation and response framing; this
 * wrapper keeps authentication, path isolation, and body limits at the edge.
 */
async function startSdkHttpSession(session, state, options) {
  const sdkServer = new McpProtocolServer(
    { name: CLAUDE_QUERY_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CLAUDE_QUERY_MCP_TOOLS }));
  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const payload = await dispatchTool(state, request.params?.name, request.params?.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: payload?.ok === false,
    };
  });

  const sdkTransport = new StreamableHTTPServerTransport({
    // One transport is created per query request.  A fixed random ID keeps the
    // request-local registry and the protocol session one-to-one.
    sessionIdGenerator: () => state.sessionId,
    // Claude Code supports the JSON response form; it avoids leaving one SSE
    // stream open for every short-lived tool call while retaining spec headers.
    enableJsonResponse: options.sdkEnableJsonResponse !== false,
  });
  sdkTransport.onclose = () => {
    // The HTTP server may still be draining a response when the transport
    // closes.  Mark the request inactive so no later tool call can use it.
    state.active = false;
    state.closed = true;
    abortOpenRequests(state);
    state.runs.clear();
    // A client DELETE closes the SDK transport before the bridge's finally
    // block necessarily runs.  Tear down the request-local listener as well;
    // otherwise an otherwise-dead token would keep an ephemeral port open.
    if (!state.closePromise && state.server && !state.serverClosePromise) {
      abortOpenRequests(state);
      void closeStateServer(state).catch(() => {});
    }
  };
  sdkTransport.onerror = (error) => {
    state.trace.push({ tool: "mcp_transport", requestId: state.requestId, ok: false, error: safeMessage(error), durationMs: 0 });
  };
  try {
    await sdkServer.connect(sdkTransport);
    state.sdkServer = sdkServer;
    state.sdkTransport = sdkTransport;

    const server = createTrackedHttpServer(state, (request, response) => {
      void handleSdkHttpRequest(session, request, response);
    });
    state.server = server;
    const port = boundedInteger(options.port, 0, 0, 65_535);
    await listen(server, port, state.host);
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    session.port = actualPort;
    session.url = `http://${formatUrlHost(state.host)}:${actualPort}${state.path}`;
    session.endpoint = session.url;
    return session;
  } catch (error) {
    // A failed bind/connect must not leave an MCP transport or socket alive;
    // this is especially important for request-local sessions under a
    // temporary port allocation failure.
    state.active = false;
    state.closed = true;
    abortOpenRequests(state);
    await boundedClose(() => sdkServer.close(), state.closeTimeoutMs);
    await closeStateServer(state);
    throw error;
  }
}

async function handleSdkHttpRequest(session, request, response) {
  const state = session.state;
  if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname !== state.path) return sendHttp(response, 404, { error: "not_found" });
  if (request.method === "OPTIONS") {
    sendHttp(response, 204, null, corsHeaders()); return;
  }
  if (!authorized(request, state.token)) return sendHttp(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });

  let parsedBody;
  if (request.method === "POST") {
    let body;
    try { body = await readBody(request, state.maxBodyBytes, { signal: state.closeController.signal, timeoutMs: state.bodyTimeoutMs }); }
    catch (error) {
      if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
      const status = error.code === "BODY_TOO_LARGE" ? 413 : ["BODY_TIMEOUT", "REQUEST_ABORTED"].includes(error.code) ? 408 : 400;
      return sendHttp(response, status, { error: error.code || "invalid_body" });
    }
    if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
    try { parsedBody = JSON.parse(body); }
    catch {
      return sendHttp(response, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
    }
  }
  try {
    await state.sdkTransport.handleRequest(request, response, parsedBody);
  } catch (error) {
    if (!response.headersSent) sendHttp(response, 500, { jsonrpc: "2.0", error: { code: -32603, message: safeMessage(error) }, id: null });
  }
}

function makeSession(state) {
  const session = {
    get active() { return state.active && !state.closed; },
    get requestId() { return state.requestId; },
    get sourceId() { return state.sourceId; },
    get token() { return state.token; },
    get server() { return state.server; },
    get sdkServer() { return state.sdkServer; },
    get sdkTransport() { return state.sdkTransport; },
    get registry() { return makeRegistry(state); },
    get snapshot() { return state.snapshot; },
    get trace() { return state.trace.map((item) => ({ ...item })); },
    get mcpConfig() {
      if (!session.url) return null;
      return {
        mcpServers: {
          [CLAUDE_QUERY_MCP_SERVER_NAME]: {
            type: "http",
            url: session.url,
            headers: { Authorization: `Bearer ${state.token}` },
            // Keep the two small tools discoverable at startup.  Permission
            // pre-approval is supplied separately by the bridge's
            // `--allowedTools` flag; `alwaysAllow` is not a Claude MCP config
            // field and is intentionally not emitted here.
            alwaysLoad: true,
          },
        },
      };
    },
    tools: CLAUDE_QUERY_MCP_TOOLS,
    async callTool(name, args = {}) {
      return dispatchTool(state, name, args);
    },
    async invokeTool(name, args = {}) {
      return dispatchTool(state, name, args);
    },
    async readTool(args = {}) {
      return dispatchTool(state, "ontology_read", args);
    },
    async handleRequest(message, headers = {}) {
      return handleRpcMessage(session, message, headers);
    },
    async close() {
      if (state.closePromise) return state.closePromise;
      state.closePromise = (async () => {
        state.active = false;
        state.closed = true;
        state.token = null;
        abortOpenRequests(state);
        state.runs.clear();
        if (state.sdkServer) {
          await boundedClose(() => state.sdkServer.close(), state.closeTimeoutMs);
        } else if (state.sdkTransport?.close) {
          await boundedClose(() => state.sdkTransport.close(), state.closeTimeoutMs);
        }
        if (state.transport?.close) {
          await boundedClose(() => state.transport.close(), state.closeTimeoutMs);
        }
        await closeStateServer(state);
      })();
      return state.closePromise;
    },
  };
  // Useful for tests and the bridge when a caller wants the unredacted result
  // set after validating execution IDs.  It is deliberately not enumerable in
  // JSON output and is cleared by close().
  Object.defineProperty(session, "resolveExecutions", {
    enumerable: false,
    value(ids) { return resolveExecutions(state, ids); },
  });
  Object.defineProperty(session, "getTrace", {
    enumerable: false,
    value() { return state.trace.map((item) => ({ ...item })); },
  });
  Object.defineProperty(session, "getRun", {
    enumerable: false,
    value(id) { return state.runs.get(String(id)) || null; },
  });
  Object.defineProperty(session, "resolveExecutionIds", {
    enumerable: false,
    value(ids) { return resolveExecutions(state, ids); },
  });
  Object.defineProperty(session, "getSuccessfulRuns", {
    enumerable: false,
    value() { return [...state.runs.values()].map((item) => structuredClone(item)); },
  });
  Object.defineProperty(session, "state", { enumerable: false, value: state });
  return session;
}

function makeRegistry(state) {
  return {
    get(id) { return state.runs.get(String(id)) || null; },
    has(id) { return state.runs.has(String(id)); },
    values() { return [...state.runs.values()].map((item) => structuredClone(item)); },
    resolve(ids) { return resolveExecutions(state, ids); },
    clear() { state.runs.clear(); },
    get size() { return state.runs.size; },
  };
}

async function dispatchTool(state, name, args) {
  if (!state.active || state.closed) return failureResult("SESSION_CLOSED", "MCP session 已关闭");
  const started = Date.now();
  const normalizedName = String(name || "").trim();
  let result;
  try {
    if (normalizedName === "ontology_read") result = await ontologyRead(state, args);
    else if (normalizedName === "db_query") result = await dbQuery(state, args);
    else result = failureResult("UNKNOWN_TOOL", `不支持的 MCP 工具：${normalizedName}`);
  } catch (error) {
    result = failureResult(error?.code || "TOOL_ERROR", safeMessage(error), { retryable: false });
  }
  const trace = {
    tool: normalizedName,
    requestId: state.requestId,
    durationMs: Date.now() - started,
    ok: result?.ok !== false,
    ...(normalizedName === "db_query" ? { sqlHash: hashSql(args?.sql), executionId: result?.executionId || null } : {}),
    ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
  };
  state.trace.push(trace);
  if (state.trace.length > 100) state.trace.splice(0, state.trace.length - 100);
  return result;
}

async function ontologyRead(state, args = {}) {
  if (!state.snapshot?.read) return failureResult("SNAPSHOT_UNAVAILABLE", "当前请求没有可读取的本体快照");
  if (!args || typeof args !== "object" || Array.isArray(args)) return failureResult("INVALID_ARGUMENTS", "ontology_read 参数必须是对象");
  const operation = String(args.operation || "").trim().toLowerCase();
  if (!operation) return failureResult("INVALID_OPERATION", "ontology_read 必须指定 operation");
  let result;
  try {
    result = await state.snapshot.read({ ...args, operation });
  } catch (error) {
    return failureResult(error?.code || "INVALID_OPERATION", safeMessage(error));
  }
  const tableNames = collectTablesFromRead(result);
  if (tableNames.length && state.snapshot.disclose) state.snapshot.disclose(tableNames);
  return {
    ok: true,
    operation,
    data: boundJson(result, state.maxBodyBytes),
    disclosedTables: state.snapshot.disclosedTables ? [...state.snapshot.disclosedTables].sort() : tableNames,
  };
}

async function dbQuery(state, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return failureResult("INVALID_ARGUMENTS", "db_query 参数必须是对象");
  const sql = String(args.sql ?? "").trim();
  if (!sql) return failureResult("SQL_REQUIRED", "db_query 必须提供 SQL");
  if (sql.length > 100_000) return failureResult("SQL_TOO_LARGE", "SQL 超过长度上限");
  const semicolonCount = (sql.match(/;/g) || []).length;
  if (/;\s*\S/.test(sql) || semicolonCount > 1) return failureResult("MULTI_STATEMENT", "只允许一条 SELECT 语句");
  if (!/^\s*(?:select|with)\b/i.test(sql)) return failureResult("READ_ONLY_REQUIRED", "只允许 SELECT 查询");
  // The request snapshot authorizes physical table names, not arbitrary
  // database-qualified aliases.  Reject qualification at the MCP edge as
  // well as in QueryExecutionKernel so injected/test executors cannot turn
  // `other_db.allowed_table` into a cross-source read by bypassing the SQL
  // guard adapter.
  if (/\b(?:from|join)\s+[`A-Za-z_][`A-Za-z0-9_$]*\s*\.\s*[`A-Za-z_][`A-Za-z0-9_$]*/i.test(sql)) {
    return failureResult("CROSS_DATABASE_FORBIDDEN", "禁止跨数据库限定查询");
  }
  // A database can also be smuggled through a three-part column reference
  // (`db.table.column`) while FROM names only the local table.  The shared
  // SQL guard checks the parsed AST; keep this cheap edge check as a defense
  // in depth for injected executors that intentionally bypass that kernel.
  if (/[`A-Za-z_][`A-Za-z0-9_$]*\s*\.\s*[`A-Za-z_][`A-Za-z0-9_$]*\s*\.\s*[`A-Za-z_][`A-Za-z0-9_$]*/i.test(sql)) {
    return failureResult("CROSS_DATABASE_FORBIDDEN", "禁止跨数据库限定查询");
  }
  const tableNames = extractTableNames(sql);
  const allowed = new Set((state.snapshot?.allowedTableNames || []).map((name) => normalizeIdentifier(name)).filter(Boolean));
  const disclosed = state.snapshot?.disclosedTables instanceof Set ? state.snapshot.disclosedTables : new Set();
  const unknown = tableNames.filter((name) => !allowed.has(name));
  if (unknown.length) return failureResult("UNKNOWN_TABLE", `查询引用了未发布或不允许的表：${unknown.join("、")}`, { tables: unknown });
  const undisclosed = tableNames.filter((name) => !disclosed.has(name));
  if (undisclosed.length) return failureResult("TABLE_NOT_DISCLOSED", `请先通过 ontology_read 查看表：${undisclosed.join("、")}`, { tables: undisclosed, retryable: true });

  const name = safeText(args.name || "query", 200);
  let receipt;
  try {
    receipt = await executeThroughKernel(state, { name, sql, disclosedTables: [...disclosed] });
  } catch (error) {
    return failureResult(error?.code || "EXECUTION_ERROR", safeMessage(error), { retryable: Boolean(error?.retryable) });
  }
  if (!receipt || receipt.ok === false) {
    return failureResult(receipt?.errorCode || receipt?.code || "EXECUTION_ERROR", safeMessage(receipt?.reason || receipt?.error || "查询执行失败"), {
      retryable: Boolean(receipt?.retryable),
      failureClass: receipt?.failureClass,
    });
  }
  const tupleRows = Array.isArray(receipt) && Array.isArray(receipt[0]) ? receipt[0] : [];
  const tupleFields = Array.isArray(receipt) && Array.isArray(receipt[1]) ? receipt[1] : [];
  const executionId = normalizeExecutionId(receipt.executionId || receipt.id) || `exec-${randomUUID()}`;
  if (state.runs.has(executionId)) return failureResult("EXECUTION_ID_COLLISION", "执行凭据冲突，请重试");
  // QueryExecutionKernel intentionally returns a bounded model preview.  Pull
  // the private full run back through its registry before storing this session
  // receipt; never treat `receipt.rows` as the authoritative full result.
  const kernelRun = await resolveKernelRun(state, executionId);
  const sourceRun = kernelRun || receipt.result || receipt;
  const fullRows = Array.isArray(sourceRun.rows) ? structuredClone(sourceRun.rows) : Array.isArray(sourceRun.result?.rows) ? structuredClone(sourceRun.result.rows) : structuredClone(tupleRows);
  const fields = normalizeFields(sourceRun.fields || sourceRun.columns || sourceRun.result?.fields || sourceRun.result?.columns || receipt.fields || receipt.columns || tupleFields, fullRows);
  const sensitiveNames = new Set(tableNames.flatMap((tableName) => (state.snapshot?.columnsByTable?.[tableName] || [])
    .filter((column) => isSensitiveFlag(column?.sensitive) || isSensitiveFlag(column?.isSensitive) || isSensitiveFlag(column?.is_sensitive))
    .map((column) => String(column.columnName ?? column.name ?? column.fieldName ?? "").toLowerCase())
    .filter(Boolean)));
  const sensitiveColumns = fields.filter((field) => sensitiveNames.has(normalizePreviewFieldName(field)));
  const run = {
    executionId,
    requestId: state.requestId,
    sourceId: state.sourceId,
    name,
    requestedSql: sourceRun.requestedSql ?? receipt.requestedSql ?? sql,
    sql: sourceRun.sql ?? receipt.executedSql ?? sql,
    rows: fullRows,
    fields,
    columns: fields,
    sensitiveColumns,
    rowCount: Number.isFinite(Number(sourceRun.rowCount ?? receipt.rowCount)) ? Number(sourceRun.rowCount ?? receipt.rowCount) : fullRows.length,
    scannedRows: finiteNumber(sourceRun.scannedRows ?? receipt.scannedRows ?? receipt.explainRows ?? receipt.result?.scannedRows),
    durationMs: finiteNumber(sourceRun.durationMs ?? receipt.durationMs ?? receipt.result?.durationMs),
    completeness: sourceRun.completeness ?? receipt.completeness ?? receipt.result?.completeness ?? null,
    contractValidation: sourceRun.contractValidation ?? receipt.contractValidation ?? receipt.result?.contractValidation ?? null,
    // Keep the kernel's execution verdict and delivery metadata in the
    // request-local registry.  The model still receives only the bounded
    // preview below, while the trusted query service can later combine runs
    // and enforce result-completeness from the resolved receipt.
    verdict: sourceRun.verdict ?? receipt.verdict ?? receipt.result?.verdict ?? null,
    semanticPlan: sourceRun.semanticPlan ?? receipt.semanticPlan ?? receipt.result?.semanticPlan ?? null,
    mayBeTruncated: Boolean(sourceRun.mayBeTruncated ?? receipt.mayBeTruncated ?? receipt.result?.mayBeTruncated ?? receipt.resultMayBeIncomplete),
    resultDelivery: sourceRun.resultDelivery ?? receipt.resultDelivery ?? receipt.result?.resultDelivery ?? "preview",
    tables: tableNames,
    joins: sourceRun.joins || receipt.joins || receipt.result?.joins || [],
    createdAt: new Date().toISOString(),
  };
  state.runs.set(executionId, run);
  const preview = makePreview(run, state.previewRows, state.previewBytes, state.snapshot);
  return {
    ok: true,
    executionId,
    rowCount: run.rowCount,
    columns: preview.columns,
    previewRows: preview.rows,
    previewTruncated: preview.truncated,
    resultMayBeIncomplete: Boolean(receipt.resultMayBeIncomplete ?? receipt.mayBeIncomplete ?? receipt.mayBeTruncated ?? run.mayBeTruncated ?? run.completeness?.complete === false),
    scannedRows: run.scannedRows,
    durationMs: run.durationMs,
    // Deliberately no `rows`/`sql` field here: the model receives only the
    // receipt.  The bridge resolves the private run from this session.
  };
}

async function executeThroughKernel(state, input) {
  if (typeof state.executeFn === "function") {
    if (state.executeFn.length >= 2) return state.executeFn(input.name, input.sql, input);
    return state.executeFn(input);
  }
  if (state.kernel?.execute) return state.kernel.execute(input);
  return { ok: false, errorCode: "KERNEL_UNAVAILABLE", error: "查询执行内核不可用" };
}

async function resolveKernelRun(state, executionId) {
  try {
    if (state.kernel?.getRun) return await state.kernel.getRun(executionId);
    if (state.kernel?.resolveExecutions) {
      const result = await state.kernel.resolveExecutions([executionId]);
      return result?.ok === false ? null : result?.runs?.[0] || null;
    }
    if (state.kernel?.resolveExecutionIds) {
      const result = await state.kernel.resolveExecutionIds([executionId]);
      return result?.ok === false ? null : result?.runs?.[0] || null;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveExecutions(state, ids) {
  if (!Array.isArray(ids)) return { ok: false, errorCode: "EXECUTION_IDS_REQUIRED", error: "必须提供 execution IDs 数组", runs: [] };
  if (ids.length > 5) return { ok: false, errorCode: "EXECUTION_ID_LIMIT_EXCEEDED", error: "一次最多引用 5 个 execution ID", runs: [] };
  const requested = ids.map((id) => normalizeExecutionId(id));
  if (requested.some((id) => !id)) return { ok: false, errorCode: "EXECUTION_ID_INVALID", error: "execution ID 格式无效", runs: [] };
  if (!requested.length) return { ok: false, errorCode: "EXECUTION_IDS_REQUIRED", error: "必须提供 execution IDs", runs: [] };
  if (new Set(requested).size !== requested.length) return { ok: false, errorCode: "DUPLICATE_EXECUTION_ID", error: "execution IDs 不能重复", runs: [] };
  const missing = requested.filter((id) => !state.runs.has(id));
  if (missing.length) return { ok: false, errorCode: "UNKNOWN_EXECUTION_ID", error: `execution ID 不属于当前请求：${missing.join("、")}`, runs: [] };
  const runs = requested.map((id) => structuredClone(state.runs.get(id)));
  return { ok: true, runs };
}

async function handleHttpRequest(session, request, response) {
  const state = session.state;
  if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname !== state.path) return sendHttp(response, 404, { error: "not_found" });
  if (request.method === "OPTIONS") {
    sendHttp(response, 204, null, corsHeaders()); return;
  }
  if (request.method !== "POST") return sendHttp(response, 405, { error: "method_not_allowed" });
  if (!authorized(request, state.token)) return sendHttp(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  let body;
  try { body = await readBody(request, state.maxBodyBytes, { signal: state.closeController.signal, timeoutMs: state.bodyTimeoutMs }); }
  catch (error) {
    if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
    const status = error.code === "BODY_TOO_LARGE" ? 413 : ["BODY_TIMEOUT", "REQUEST_ABORTED"].includes(error.code) ? 408 : 400;
    return sendHttp(response, status, { error: error.code || "invalid_body" });
  }
  if (!state.active || state.closed) return sendHttp(response, 410, { error: "session_closed" });
  let message;
  try { message = JSON.parse(body); } catch { return sendHttp(response, 400, { error: "invalid_json" }); }
  const result = await handleRpcMessage(session, message, {
    authorization: request.headers.authorization,
    sessionId: request.headers["mcp-session-id"],
  });
  const sessionHeader = { "Mcp-Session-Id": state.sessionId };
  if (result === null) { sendHttp(response, 202, null, sessionHeader); return; }
  sendHttp(response, 200, result, sessionHeader);
}

async function handleRpcMessage(session, message, headers = {}) {
  const state = session.state;
  if (!state.active || state.closed) return rpcError(message?.id ?? null, -32001, "session_closed");
  if (headers.sessionId && headers.sessionId !== state.sessionId) return rpcError(message?.id ?? null, -32002, "invalid_session");
  if (headers.authorization && !authorizedHeader(headers.authorization, state.token)) return rpcError(message?.id ?? null, -32003, "unauthorized");
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return rpcError(message?.id ?? null, -32600, "Invalid Request");
  const method = String(message.method || "");
  const id = message.id;
  try {
    if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
    if (method === "ping") return rpcResult(id, {});
    if (method === "initialize") {
      state.initialized = true;
      return rpcResult(id, {
        protocolVersion: CLAUDE_QUERY_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CLAUDE_QUERY_MCP_SERVER_NAME, version: "1.0.0" },
      });
    }
    if (method === "tools/list") return rpcResult(id, { tools: CLAUDE_QUERY_MCP_TOOLS });
    if (method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const payload = await dispatchTool(state, name, args);
      const isError = payload?.ok === false;
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError,
      });
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return rpcError(id, -32603, safeMessage(error));
  }
}

function collectTablesFromRead(result) {
  const names = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, item] of Object.entries(value)) {
      if (["tableName", "table", "fromTable", "toTable"].includes(key) && typeof item === "string") names.add(normalizeIdentifier(item));
      visit(item);
    }
  };
  visit(result);
  return [...names].filter(Boolean);
}

function makePreview(run, maxRows, maxBytes, snapshot) {
  // 2026-09-04 应用户要求移除敏感列预览剔除：预览返回全部投影列。
  void snapshot;
  const columns = [...run.fields];
  const rows = [];
  let truncated = run.rows.length > maxRows;
  for (const sourceRow of run.rows.slice(0, maxRows)) {
    const row = {};
    for (const column of columns) if (sourceRow && Object.prototype.hasOwnProperty.call(sourceRow, column)) row[column] = safePreviewValue(sourceRow[column]);
    const candidate = [...rows, row];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) { truncated = true; break; }
    rows.push(row);
  }
  return { columns, rows, truncated };
}

function isSensitiveFlag(value) {
  if (value === true || (typeof value === "number" && value > 0)) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  // Unknown non-empty textual flags fail closed; only explicit false-like
  // values are considered safe to display.
  return normalized !== "" && !["0", "false", "no", "off", "null", "undefined"].includes(normalized);
}

// Drivers differ on whether a projected field is reported as `phone`,
// `customer.phone`, or `` `customer`.`phone` ``.  Normalize only for the
// sensitivity comparison; preserve the original field label in the preview
// so result formatting remains driver-compatible.
function normalizePreviewFieldName(value) {
  return String(value ?? "")
    .replaceAll("`", "")
    .replaceAll('"', "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(".")
    .at(-1)
    .trim()
    .toLowerCase();
}

function normalizeFields(value, rows) {
  const fields = Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : item?.name ?? item?.columnName).filter(Boolean)
    : [];
  if (fields.length) return [...new Set(fields.map((item) => String(item)))];
  return rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : [];
}

function extractTableNames(sql) {
  const names = new Set();
  // CTE aliases are query-local names, not physical tables.  Keep them out
  // of the closed-world table allowlist check so a valid `WITH ... SELECT`
  // remains executable while every physical FROM/JOIN target is still
  // validated below.
  const cteNames = new Set();
  const withMatch = String(sql || "").match(/^\s*with\s+(?:recursive\s+)?([`A-Za-z_][`A-Za-z0-9_$]*)/i);
  if (withMatch) {
    // Capture each alias preceding AS( in the WITH clause.  Scan the full
    // statement rather than slicing at the first `) SELECT`: multiple CTEs
    // (and nested CTE bodies) otherwise leave the first alias's parenthesis
    // unbalanced and make it disappear from the match.
    for (const match of String(sql || "").matchAll(/(?:\bwith\s+(?:recursive\s+)?|,)\s*([`A-Za-z_][`A-Za-z0-9_$]*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) {
      cteNames.add(normalizeIdentifier(match[1]));
    }
    if (!cteNames.size) cteNames.add(normalizeIdentifier(withMatch[1]));
  }
  const pattern = /\b(?:from|join)\s+([`A-Za-z_][`A-Za-z0-9_$]*(?:\s*\.\s*[`A-Za-z_][`A-Za-z0-9_$]*)?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const raw = match[1].replaceAll("`", "").replace(/\s+/g, "");
    const parts = raw.split(".");
    const name = normalizeIdentifier(parts.at(-1));
    if (name && !cteNames.has(name)) names.add(name);
  }
  return [...names].filter(Boolean);
}

function normalizeIdentifier(value) {
  const text = String(value ?? "").trim().replace(/^`|`$/g, "");
  return /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(text) ? text.toLowerCase() : "";
}

function normalizeExecutionId(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : "";
}

function sameSourceId(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  return String(left).trim() === String(right).trim();
}

function normalizeToken(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._~-]{32,512}$/.test(text) ? text : randomBytes(32).toString("base64url");
}

function normalizeHost(value, allowNonLoopback) {
  const host = String(value || "127.0.0.1").trim();
  if (allowNonLoopback) return host;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new ClaudeQueryMcpError("NON_LOOPBACK_HOST", "MCP 默认只允许绑定 loopback 地址", 500);
  if (host === "localhost") return "127.0.0.1";
  return host === "[::1]" ? "::1" : host;
}

function formatUrlHost(host) {
  const text = String(host || "127.0.0.1");
  return text.includes(":") && !text.startsWith("[") ? `[${text}]` : text;
}

function normalizePath(value) {
  const path = String(value || CLAUDE_QUERY_MCP_PATH).trim();
  if (!/^\/[A-Za-z0-9._~-]{1,80}$/.test(path)) throw new ClaudeQueryMcpError("INVALID_PATH", "MCP path 无效", 500);
  return path;
}

function authorized(request, token) {
  return authorizedHeader(request.headers.authorization, token) || String(request.headers["x-mcp-token"] || "") === token;
}

function authorizedHeader(value, token) {
  return typeof value === "string" && /^Bearer\s+/i.test(value) && value.slice(value.indexOf(" ") + 1).trim() === token;
}

function failureResult(errorCode, error, extras = {}) {
  // Tool errors are visible to Claude and may contain a driver/parser message
  // that echoes a literal from the rejected SQL.  Keep the diagnostic useful
  // while ensuring typed phone/email/ID/card values do not cross the MCP
  // boundary (the full SQL remains request-local only).
  return { ok: false, errorCode, error: redactTypedLiterals(safeText(error, 1_000)), ...extras };
}

function safeMessage(error) {
  return redactTypedLiterals(safeText(error?.message || error?.error || error || "工具执行失败", 1_000));
}

function safeText(value, maxLength) {
  const text = stripControl(String(value ?? "")).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function stripControl(value) { return [...String(value)].map((char) => { const code = char.codePointAt(0); return code < 0x20 || code === 0x7f ? " " : char; }).join(""); }

function safePreviewValue(value) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactTypedLiterals(value);
  if (typeof value === "number") return redactTypedLiterals(String(value)) === String(value) ? value : "[REDACTED]";
  if (typeof value === "bigint") {
    const text = String(value);
    return redactTypedLiterals(text) === text ? Number(value) : "[REDACTED]";
  }
  if (Buffer.isBuffer(value)) return "[BINARY]";
  return redactTypedLiterals(safeText(JSON.stringify(value), 2_000));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function hashSql(sql) {
  return createHash("sha256").update(String(sql || "")).digest("hex").slice(0, 16);
}

function boundJson(value, maxBytes) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value;
  return { truncated: true, summary: safeText(text, Math.max(256, Math.floor(maxBytes / 2))) };
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message: redactTypedLiterals(safeText(message, 500)) } }; }
function corsHeaders() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "null" }; }
function sendHttp(response, status, body, extra = {}) {
  if (!response || response.destroyed || response.writableEnded) return false;
  try {
    const payload = body == null ? "" : JSON.stringify(body);
    response.writeHead(status, { ...corsHeaders(), ...extra });
    response.end(payload);
    return true;
  } catch {
    try { if (!response.writableEnded) response.end(); } catch { /* best effort */ }
    return false;
  }
}

function readBody(request, maxBytes, options = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let ended = false;
    let settled = false;
    const chunks = [];
    const signal = options.signal;
    const timeoutMs = boundedInteger(options.timeoutMs, CLAUDE_QUERY_MCP_BODY_TIMEOUT_MS, 10, 10 * 60_000);
    let timer = setTimeout(() => {
      const error = new ClaudeQueryMcpError("BODY_TIMEOUT", "MCP 请求体读取超时", 408);
      destroyRequest(request);
      finish(error);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      timer = null;
      request.off?.("data", onData);
      request.off?.("end", onEnd);
      request.off?.("error", onError);
      request.off?.("aborted", onAborted);
      request.off?.("close", onClose);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, value = undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > maxBytes) {
        const error = new ClaudeQueryMcpError("BODY_TOO_LARGE", "MCP 请求体超过大小限制", 413);
        destroyRequest(request);
        finish(error);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      ended = true;
      finish(null, Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error) => finish(error);
    const onAborted = () => finish(new ClaudeQueryMcpError("REQUEST_ABORTED", "MCP 客户端中止了请求", 408));
    const onClose = () => {
      if (!ended) finish(new ClaudeQueryMcpError("REQUEST_ABORTED", "MCP 客户端关闭了请求", 408));
    };
    const onAbort = () => {
      const error = new ClaudeQueryMcpError("REQUEST_ABORTED", "MCP 会话已关闭", 408);
      destroyRequest(request);
      finish(error);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    request.on("close", onClose);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError); server.once("listening", onListening); server.listen(port, host);
  });
}

function createTrackedHttpServer(state, handler) {
  const server = createServer(handler);
  // Node's defaults leave header/body reads open for several minutes.  These
  // listeners are request-local, so a bounded deadline is safer and avoids a
  // slowloris keeping a query worker alive.  Keep a small floor for tests and
  // very short explicit deadlines; the body reader still enforces its own
  // exact timeout and abort signal.
  server.requestTimeout = state.bodyTimeoutMs;
  server.headersTimeout = Math.min(Math.max(state.bodyTimeoutMs, 1_000), 60_000);
  server.keepAliveTimeout = Math.min(Math.max(state.closeTimeoutMs, 1_000), 10_000);
  server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.once("close", () => state.sockets.delete(socket));
  });
  server.on("request", (request) => {
    state.requests.add(request);
    request.once?.("close", () => state.requests.delete(request));
  });
  return server;
}

function abortOpenRequests(state) {
  if (!state.closeController.signal.aborted) state.closeController.abort();
  for (const request of state.requests) destroyRequest(request);
  state.requests.clear();
}

function destroyRequest(request) {
  try { request?.destroy?.(); } catch { /* best effort */ }
}

function closeStateServer(state) {
  if (state.serverClosePromise) return state.serverClosePromise;
  if (!state.server) return Promise.resolve();
  const server = state.server;
  state.server = null;
  state.serverClosePromise = closeServer(server, state.closeTimeoutMs, state);
  return state.serverClosePromise;
}

async function boundedClose(closeFn, timeoutMs) {
  if (typeof closeFn !== "function") return;
  const boundedTimeout = boundedInteger(timeoutMs, CLAUDE_QUERY_MCP_CLOSE_TIMEOUT_MS, 10, 60_000);
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(closeFn),
      new Promise((resolve) => { timer = setTimeout(resolve, boundedTimeout); }),
    ]);
  } catch {
    // Cleanup is best effort; a broken SDK/custom transport must not block the
    // request worker from closing its listener and releasing its port.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeServer(server, timeoutMs = CLAUDE_QUERY_MCP_CLOSE_TIMEOUT_MS, state = undefined) {
  return new Promise((resolve) => {
    if (!server || !server.listening) { resolve(); return; }
    const boundedTimeout = boundedInteger(timeoutMs, CLAUDE_QUERY_MCP_CLOSE_TIMEOUT_MS, 10, 60_000);
    let settled = false;
    let timer;
    const sockets = state?.sockets || server.__claudeQuerySockets;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const forceClose = () => {
      try { server.closeAllConnections?.(); } catch { /* best effort */ }
      if (sockets) for (const socket of sockets) {
        try { socket.destroy(); } catch { /* best effort */ }
      }
      // `closeAllConnections()` normally causes the close callback to run,
      // but resolve here as a final bound in case a custom server/socket never
      // emits its close event.
      finish();
    };
    timer = setTimeout(forceClose, boundedTimeout);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  });
}
