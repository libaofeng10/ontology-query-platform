import { randomUUID, createHash } from "node:crypto";
import { guardReadOnlySql } from "./sql-guard.mjs";
import { normalizeQueryRow } from "./query-result-normalization.mjs";
import { toolFailure } from "./query-errors.mjs";

// The shared query-errors helper historically exposed the human-readable
// failure text as `error`.  The execution-kernel contract also calls this
// field `reason` (the name used by the Claude bridge/finalizer).  Keep both
// aliases at this boundary so callers do not need path-specific adapters.
function kernelFailure(input = {}) {
  const failure = toolFailure(input);
  return { ...failure, reason: failure.error, retryable: Boolean(failure.retryable) };
}

/** Execute SQL from Claude or reviewed Gold cases: read-only AST, EXPLAIN,
 * resource budgets, cancellation and request-local execution receipts. */
export function createQueryExecutionKernel({
  connector,
  source,
  config = {},
  catalog = {},
  signal,
  maxSqlCalls,
  maxScannedRows,
  preview = {},
} = {}) {
  if (!connector || typeof connector.query !== "function") throw new TypeError("query execution kernel 需要 connector.query");
  if (!source || source.id == null) throw new TypeError("query execution kernel 需要 source");

  const effectiveConfig = config || {};
  const maxRows = boundedPositiveInt(effectiveConfig.queryMaxRows ?? catalog.policy?.maxRows, 500, 1, 100_000);
  const explainMaxRows = boundedPositiveInt(effectiveConfig.explainMaxRows, 1_000_000, 1, Number.MAX_SAFE_INTEGER);
  const sqlCallLimit = boundedPositiveInt(maxSqlCalls ?? effectiveConfig.queryMaxSqlCalls, 5, 1, 10_000);
  const scanLimit = boundedPositiveInt(
    maxScannedRows ?? effectiveConfig.queryMaxScannedRows,
    Math.max(explainMaxRows * sqlCallLimit, explainMaxRows),
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const outputPreview = {
    maxRows: boundedPositiveInt(preview.maxRows ?? effectiveConfig.queryExecutionPreviewRows, 40, 1, 1_000),
    maxBytes: boundedPositiveInt(preview.maxBytes ?? effectiveConfig.queryExecutionPreviewBytes, 64 * 1024, 1_024, 4 * 1024 * 1024),
    maxCellChars: boundedPositiveInt(preview.maxCellChars ?? effectiveConfig.queryExecutionPreviewCellChars, 200, 16, 10_000),
  };

  const runs = new Map();
  let sqlCalls = 0;
  let scannedRowsTotal = 0;
  // Database-confirmed schema mistakes may be corrected without consuming the
  // last data-query slot. This is a small request-local allowance, not a way
  // to retry scans, empty results, policy failures or timeouts indefinitely.
  const maxSchemaRepairs = 2;
  let schemaRepairs = 0;

  async function execute({
    name = "查询",
    sql,
    signal: executeSignal,
  } = {}) {
    let requestedSql;
    let runName;
    try {
      requestedSql = requiredText(sql, "sql", 50_000);
      runName = requiredText(name, "name", 100);
    } catch (error) {
      return kernelFailure({ stage: "guard", code: "INVALID_ARGUMENT", error: error?.message || error, retryable: false });
    }
    const activeSignal = executeSignal ?? resolveSignal(signal);
    throwIfAborted(activeSignal);
    if (sqlCalls >= sqlCallLimit) {
      return kernelFailure({
        stage: "budget",
        code: "SQL_CALL_BUDGET_EXCEEDED",
        error: `db_query 已达到 ${sqlCallLimit} 次上限`,
      });
    }
    sqlCalls++;

    let verdict;
    try {
      verdict = guardReadOnlySql(requestedSql, { maxRows });
    } catch (error) {
      return kernelFailure({ stage: "guard", code: "GUARD_ERROR", error: safeError(error), retryable: false });
    }
    if (!verdict.ok) {
      return failureWithVerdict({
        stage: "guard",
        code: verdict.code || "GUARD_REJECTED",
        error: verdict.reason || "SQL 未通过安全护栏",
        retryable: true,
        details: verdict.details,
      }, verdict);
    }

    const executionStarted = Date.now();
    const explanation = await explain(verdict.sql, { signal: activeSignal });
    if (!explanation.ok) return withSchemaRecovery(explanation, verdict);
    try {
      const [rawRows, rawFields] = await connector.query(source, verdict.sql, [], activeSignal);
      const rawNormalizedRows = (Array.isArray(rawRows) ? rawRows : []).map(normalizeQueryRow);
      // The SQL guard caps LIMIT, but a connector/mock can still over-return
      // rows (for example after a driver-side retry).  Enforce the effective
      // per-query cap at the execution boundary so full rows never bypass the
      // configured result budget; mark the receipt incomplete for the finalizer.
      const effectiveResultLimit = Number.isFinite(Number(verdict.limit?.effective))
        ? Math.max(1, Number(verdict.limit.effective))
        : maxRows;
      const connectorOverflow = rawNormalizedRows.length > effectiveResultLimit;
      const boundedNormalizedRows = connectorOverflow ? rawNormalizedRows.slice(0, effectiveResultLimit) : rawNormalizedRows;
      const rawFieldsNormalized = normalizeFields(rawFields, boundedNormalizedRows);
      const fields = rawFieldsNormalized;
      const projectedNames = new Set(fields.map((field) => String(field.name)));
      const rows = boundedNormalizedRows.map((row) => Object.fromEntries(
        Object.entries(row).filter(([name]) => projectedNames.has(String(name))),
      ));
      const resultDelivery = rows.length > 100 ? "direct" : "preview";
      const mayBeTruncated = connectorOverflow || (Number.isFinite(Number(verdict.limit?.effective)) && rows.length >= Number(verdict.limit.effective));
      const executionId = `qe_${randomUUID()}`;
      const run = {
        executionId,
        name: runName,
        requestedSql,
        sql: verdict.sql,
        sqlHashes: new Set([sqlHash(requestedSql), sqlHash(verdict.sql)]),
        rows,
        fields,
        verdict,
        scannedRows: explanation.scannedRows,
        durationMs: Date.now() - executionStarted,
        resultDelivery,
        mayBeTruncated,
      };
      runs.set(executionId, run);
      const contextRows = resultDelivery === "direct"
        ? { rows: [], truncated: true, modelRowsOmitted: true }
        : truncateRows(rows, outputPreview);
      return {
        ok: true,
        executionId,
        executedSql: verdict.sql,
        columns: fields,
        rowCount: rows.length,
        scannedRows: explanation.scannedRows,
        durationMs: run.durationMs,
        rows: contextRows.rows,
        truncated: contextRows.truncated,
        modelRowsOmitted: contextRows.modelRowsOmitted || undefined,
        resultDelivery,
        mayBeTruncated,
        limit: verdict.limit,
      };
    } catch (error) {
      if (activeSignal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
      return withSchemaRecovery(driverFailure("query", error), verdict);
    }
  }

  async function explain(sql, { signal: explainSignal } = {}) {
    const activeExplainSignal = explainSignal ?? resolveSignal(signal);
    throwIfAborted(activeExplainSignal);
    let explainRows;
    try {
      if (typeof connector.explain !== "function") throw new Error("connector.explain 不可用");
      explainRows = await connector.explain(source, sql, activeExplainSignal);
    } catch (error) {
      if (activeExplainSignal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
      return driverFailure("explain", error);
    }
    const scannedRows = (Array.isArray(explainRows) ? explainRows : []).reduce(
      (sum, row) => sum + Math.max(0, Number(row?.rows || 0)),
      0,
    );
    if (scannedRows > explainMaxRows) {
      return kernelFailure({
        stage: "explain",
        code: "SCAN_LIMIT_EXCEEDED",
        error: `EXPLAIN 预计扫描 ${scannedRows} 行，超过单次阈值 ${explainMaxRows}`,
        retryable: true,
      });
    }
    if (scannedRowsTotal + scannedRows > scanLimit) {
      return kernelFailure({
        stage: "budget",
        code: "SCAN_BUDGET_EXCEEDED",
        error: `累计 EXPLAIN 扫描预算将超过 ${scanLimit} 行`,
      });
    }
    scannedRowsTotal += scannedRows;
    return { ok: true, scannedRows };
  }

  function getSuccessfulRuns() { return [...runs.values()].map(cloneRun); }

  function getRun(executionId) {
    const key = String(executionId || "");
    return cloneRun(runs.get(key));
  }

  /** Resolve only IDs issued by this kernel instance; never trust model rows. */
  function resolveExecutionIds(executionIds, { max = 5 } = {}) {
    if (!Array.isArray(executionIds) || !executionIds.length) {
      return registryFailure("EXECUTION_ID_REQUIRED", "必须提供至少一个 executionId");
    }
    if (executionIds.length > max) {
      return registryFailure("EXECUTION_ID_LIMIT_EXCEEDED", `一次最多引用 ${max} 个 executionId`);
    }
    const unique = [...new Set(executionIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (unique.length !== executionIds.length) {
      return registryFailure("EXECUTION_ID_DUPLICATE", "executionId 不能重复");
    }
    const resolved = unique.map((id) => runs.get(id));
    const missing = unique.filter((id, index) => !resolved[index]);
    if (missing.length) {
      return registryFailure("EXECUTION_ID_UNKNOWN", `executionId 不属于当前查询：${missing.join(", ")}`);
    }
    return { ok: true, runs: resolved.map(cloneRun) };
  }

  function findRunBySql(sql) {
    const hash = sqlHash(sql);
    return cloneRun([...runs.values()].findLast((run) => run.sqlHashes.has(hash)));
  }

  function driverFailure(stage, error) {
    const schemaCode = mysqlSchemaErrorCode(error);
    return kernelFailure({ stage, code: schemaCode || (stage === "explain" ? "EXPLAIN_ERROR" : "EXECUTION_ERROR"), error: safeError(error), retryable: true });
  }

  function withSchemaRecovery(failure, verdict) {
    const correctable = ["UNKNOWN_COLUMN", "UNKNOWN_TABLE", "AMBIGUOUS_COLUMN"].includes(failure.code);
    if (!correctable) return failure;
    const allowanceUsed = schemaRepairs < maxSchemaRepairs;
    if (allowanceUsed) { schemaRepairs++; sqlCalls--; }
    return { ...failure, verdict, schemaRecovery: { allowanceUsed, remaining: maxSchemaRepairs - schemaRepairs } };
  }

  function stats() { return { sqlCalls, scannedRowsTotal, maxSqlCalls: sqlCallLimit, maxScannedRows: scanLimit, runCount: runs.size, schemaRepairs, maxSchemaRepairs }; }

  function clearRuns() { runs.clear(); }
  function clear() { runs.clear(); sqlCalls = 0; scannedRowsTotal = 0; schemaRepairs = 0; }

  return {
    execute,
    explain,
    getRun,
    getSuccessfulRuns,
    resolveExecutionIds,
    // Alias used by the bridge/finalizer contract and by the design doc.
    resolveExecutions: resolveExecutionIds,
    registry: {
      get: getRun,
      resolve: resolveExecutionIds,
      getSuccessfulRuns,
      values: getSuccessfulRuns,
      clear: clearRuns,
      get size() { return runs.size; },
    },
    findRunBySql,
    stats,
    clearRuns,
    clear,
    policy: {maxRows},
  };
}

function mysqlSchemaErrorCode(error) {
  if (error?.code === "ER_BAD_FIELD_ERROR" || Number(error?.errno) === 1054) return "UNKNOWN_COLUMN";
  if (error?.code === "ER_NO_SUCH_TABLE" || Number(error?.errno) === 1146) return "UNKNOWN_TABLE";
  if (error?.code === "ER_NON_UNIQ_ERROR" || Number(error?.errno) === 1052) return "AMBIGUOUS_COLUMN";
  return null;
}

function cloneRun(run) {
  return run ? structuredClone(run) : null;
}

function registryFailure(code, error) {
  const reason = String(error || "execution ID 无效");
  return { ok: false, stage: "registry", code, error: reason, reason, retryable: false, runs: [] };
}

function resolveSignal(value) {
  try { return typeof value === "function" ? value() : value; } catch { return undefined; }
}

function failureWithVerdict(failure, verdict) {
  return { ...kernelFailure(failure), verdict, ...(verdict?.details ? { details: verdict.details } : {}) };
}

function normalizeFields(fields, rows) {
  if (Array.isArray(fields) && fields.length) {
    return fields
      .map((field) => typeof field === "string"
        ? { name: field, type: null }
        : { name: field?.name ?? field?.columnName, type: field?.type ?? field?.columnType ?? null })
      .filter((field) => field.name)
      .map((field) => ({ ...field, name: String(field.name) }));
  }
  return Object.keys(rows[0] || {}).map((name) => ({ name, type: typeof rows[0]?.[name] }));
}

export function truncateRows(rows, { maxRows = 40, maxBytes = 64 * 1024, maxCellChars = 200 } = {}) {
  const output = [];
  let bytes = 2;
  for (const row of (rows || []).slice(0, maxRows)) {
    const clipped = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, truncateCell(value, maxCellChars)]));
    const serialized = JSON.stringify(clipped);
    const size = Buffer.byteLength(serialized) + 1;
    if (bytes + size > maxBytes) break;
    output.push(clipped);
    bytes += size;
  }
  return { rows: output, truncated: output.length < (rows || []).length };
}

function truncateCell(value, maxChars) {
  if (typeof value === "string" && value.length > maxChars) return `${value.slice(0, maxChars)}…`;
  return value;
}

function requiredText(value, name, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} 不能为空`);
  if (text.length > maxLength) throw new Error(`${name} 超过长度上限 ${maxLength}`);
  return text;
}

function boundedPositiveInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function sqlHash(sql) { return createHash("sha256").update(String(sql || "").trim().replace(/\s+/g, " ")).digest("hex"); }
function safeError(error) {
  return String(error?.message || error)
    .replace(/(password|token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}

function throwIfAborted(activeSignal) {
  if (!activeSignal?.aborted) return;
  const error = new Error("查询已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}
