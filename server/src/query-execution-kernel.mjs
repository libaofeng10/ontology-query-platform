import { randomUUID, createHash } from "node:crypto";
import { guardSql } from "./sql-guard.mjs";
import { buildQueryColumnSemantics, detectQuestionValueKinds } from "./query-column-semantics.mjs";
import { normalizeQueryRow } from "./query-result-normalization.mjs";
import { queryIntentFilterError, queryResultContractValidation } from "./query-scope-coverage.mjs";
import { toolFailure } from "./query-errors.mjs";

// The shared query-errors helper historically exposed the human-readable
// failure text as `error`.  The execution-kernel contract also calls this
// field `reason` (the name used by the Claude bridge/finalizer).  Keep both
// aliases at this boundary so callers do not need path-specific adapters.
function kernelFailure(input = {}) {
  const failure = toolFailure(input);
  return { ...failure, reason: failure.error, retryable: Boolean(failure.retryable) };
}

/**
 * The one execution authority shared by every query planner.
 *
 * A planner is allowed to propose SQL, but it must never own the sequence
 * guard -> intent contract -> result contract -> disclosure -> EXPLAIN -> query.
 * Keeping that sequence in this module gives the Claude adapter and the legacy
 * tool loop the same security and correctness boundary.
 *
 * The module deliberately has a small interface.  Callers provide immutable
 * request dependencies and (where a clarification can replace the intent or
 * retrieval evidence) getter functions.  Full rows stay in this process; the
 * execution response contains only a bounded preview while `executionId`
 * identifies the in-memory run for a trusted caller.
 */
export function createQueryExecutionKernel({
  connector,
  source,
  config = {},
  question = "",
  catalog = {},
  queryIntent,
  retrievalEvidence,
  disclosedTables,
  getQueryIntent,
  getRetrievalEvidence,
  getDisclosedTables,
  signal,
  maxSqlCalls,
  maxScannedRows,
  forbidSensitiveOutput = false,
  preview = {},
} = {}) {
  if (!connector || typeof connector.query !== "function") throw new TypeError("query execution kernel 需要 connector.query");
  if (!source || source.id == null) throw new TypeError("query execution kernel 需要 source");

  const effectiveConfig = config || {};
  const maxRows = boundedPositiveInt(effectiveConfig.queryMaxRows ?? catalog.policy?.maxRows, 500, 1, 100_000);
  const explainMaxRows = boundedPositiveInt(effectiveConfig.explainMaxRows, 1_000_000, 1, Number.MAX_SAFE_INTEGER);
  const sqlCallLimit = boundedPositiveInt(maxSqlCalls ?? effectiveConfig.queryAgentMaxSqlCalls, 5, 1, 10_000);
  const scanLimit = boundedPositiveInt(
    maxScannedRows ?? effectiveConfig.queryAgentMaxScannedRows,
    Math.max(explainMaxRows * sqlCallLimit, explainMaxRows),
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const outputPreview = {
    maxRows: boundedPositiveInt(preview.maxRows ?? effectiveConfig.queryExecutionPreviewRows, 40, 1, 1_000),
    maxBytes: boundedPositiveInt(preview.maxBytes ?? effectiveConfig.queryExecutionPreviewBytes, 64 * 1024, 1_024, 4 * 1024 * 1024),
    maxCellChars: boundedPositiveInt(preview.maxCellChars ?? effectiveConfig.queryExecutionPreviewCellChars, 200, 16, 10_000),
  };

  // A catalog produced by query-agent-loop already contains these fields.  A
  // standalone Claude bridge may only provide columnsByTable; derive the
  // minimal policy in that case rather than silently allowing arbitrary SQL.
  const catalogPolicy = buildCatalogPolicy(catalog, maxRows, question, forbidSensitiveOutput);
  const runs = new Map();
  let sqlCalls = 0;
  let scannedRowsTotal = 0;

  async function execute({
    name = "查询",
    sql,
    semanticPlan = null,
    policy = null,
    // Kept in the call shape for compatibility.  Disclosure is a security
    // invariant and cannot be disabled by a planner/adapter-provided option.
    requireDisclosure = true,
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
    sqlCalls++;
    if (sqlCalls > sqlCallLimit) {
      return kernelFailure({
        stage: "budget",
        code: "SQL_CALL_BUDGET_EXCEEDED",
        error: `run_sql 已达到 ${sqlCallLimit} 次上限`,
      });
    }

    const activePolicy = mergePolicy(catalogPolicy, policy || semanticPlan?.policy, {
      valueKinds: catalogPolicy.valueKinds,
      forbidSensitiveOutput,
    });
    let verdict;
    try {
      verdict = guardSql(requestedSql, activePolicy);
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

    const hasIntentContract = typeof getQueryIntent === "function" || queryIntent != null;
    const intent = resolveValue(getQueryIntent, queryIntent);
    const retrieval = resolveValue(getRetrievalEvidence, retrievalEvidence);
    const contractExecution = {
      usedTables: verdict.tables,
      retrieval,
      verdict,
      columnsByTable: catalog.columnsByTable || {},
      semanticContract: semanticPlan?.semanticContract || null,
    };
    let intentError = null;
    try {
      intentError = hasIntentContract
        ? queryIntentFilterError(question, verdict.sql, intent, contractExecution)
        : null;
    } catch (error) {
      return failureWithVerdict({ stage: "intent", code: "INTENT_VALIDATION_ERROR", error: safeError(error), retryable: false }, verdict);
    }
    if (intentError) {
      return failureWithVerdict({
        stage: "intent",
        code: intentError.code || "INTENT_FILTER_REJECTED",
        error: intentError.message,
        retryable: intentError.retryable,
        details: intentError.details,
      }, verdict);
    }
    let contractValidation;
    try {
      contractValidation = hasIntentContract
        ? queryResultContractValidation(intent, verdict.sql, contractExecution)
        : { ok: true, errors: [] };
    } catch (error) {
      return failureWithVerdict({ stage: "intent", code: "INTENT_CONTRACT_ERROR", error: safeError(error), retryable: false }, verdict);
    }
    if (!contractValidation.ok) {
      const error = contractValidation.errors?.[0] || {};
      return failureWithVerdict({
        stage: "intent",
        code: error.code || "INTENT_RESULT_CONTRACT_MISMATCH",
        error: error.message || "SQL 未满足查询结果契约",
        retryable: true,
        details: error.details,
      }, verdict);
    }

    // `requireDisclosure:false` used to be accepted as an escape hatch.  No
    // untrusted planner should be able to turn off request-local schema
    // disclosure, so enforce it unconditionally (the parameter remains only
    // to avoid breaking older callers).
    void requireDisclosure;
    const disclosed = resolveDisclosure(getDisclosedTables, disclosedTables);
    const undisclosed = verdict.tables.filter((table) => !disclosed.has(normalizeIdentifier(table)));
    if (undisclosed.length) {
      return failureWithVerdict({
        stage: "guard",
        code: "DISCLOSURE_REQUIRED",
        error: `执行前必须先用 get_schema 查看表：${undisclosed.join(", ")}`,
        retryable: true,
        details: { undisclosedTables: undisclosed },
      }, verdict);
    }

    const executionStarted = Date.now();
    const explanation = await explain(verdict.sql, { signal: activeSignal });
    if (!explanation.ok) return explanation;
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
      const forbiddenOutputNames = new Set((activePolicy.forbiddenOutputColumns || [])
        .map((value) => String(value).split(".").at(-1).toLowerCase()));
      const fields = rawFieldsNormalized.filter((field) => !forbiddenOutputNames.has(String(field.name).toLowerCase()));
      // A connector is expected to return only projected columns, but keep the
      // execution boundary defensive: an over-eager/mock driver must not leak
      // an extra sensitive column into the private run or final API response.
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
        contractValidation,
        scannedRows: explanation.scannedRows,
        durationMs: Date.now() - executionStarted,
        resultDelivery,
        semanticPlan,
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
      return kernelFailure({ stage: "query", code: "EXECUTION_ERROR", error: safeError(error), retryable: true });
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
      return kernelFailure({ stage: "explain", code: "EXPLAIN_ERROR", error: safeError(error), retryable: true });
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

  function stats() { return { sqlCalls, scannedRowsTotal, maxSqlCalls: sqlCallLimit, maxScannedRows: scanLimit, runCount: runs.size }; }

  function clearRuns() { runs.clear(); }
  function clear() { runs.clear(); sqlCalls = 0; scannedRowsTotal = 0; }

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
    policy: catalogPolicy,
  };
}

function buildCatalogPolicy(catalog, maxRows, question, forbidSensitiveOutput) {
  const sourcePolicy = catalog.policy || {};
  const columnsByTable = catalog.columnsByTable || {};
  const semantics = sourcePolicy.allowedColumns != null
    ? {
      allowedColumns: sourcePolicy.allowedColumns,
      columnKinds: sourcePolicy.columnKinds || {},
    }
    : buildQueryColumnSemantics(columnsByTable);
  const relations = sourcePolicy.allowedRelations ?? catalog.relations ?? [];
  const enums = sourcePolicy.enums ?? catalog.enums ?? {};
  const policy = {
    ...sourcePolicy,
    allowedTables: sourcePolicy.allowedTables ?? Object.keys(columnsByTable),
    allowedColumns: sourcePolicy.allowedColumns ?? semantics.allowedColumns,
    columnKinds: sourcePolicy.columnKinds ?? semantics.columnKinds,
    allowedRelations: relations,
    maxRows,
    enums: normalizeEnums(enums),
    valueKinds: sourcePolicy.valueKinds ?? detectQuestionValueKinds(question),
  };
  if (forbidSensitiveOutput) {
    // 2026-09-04 应用户要求移除敏感列输出禁令：不再从 catalog 派生
    // forbiddenOutputColumns。调用方显式传入的 forbiddenOutputColumns 仍然生效
    // （那是调用方的明确策略，不是敏感列自动推断）。
    void columnsByTable;
  }
  return policy;
}

function mergePolicy(base, override, { valueKinds, forbidSensitiveOutput } = {}) {
  const parent = isRecord(base) ? base : {};
  const child = isRecord(override) ? override : {};
  const merged = { ...parent, ...child };

  // A semantic plan is untrusted input at this boundary.  It may narrow the
  // catalog policy, but replacing an allow-list would turn a planner bug (or
  // a forged plan supplied by an adapter) into an authority escalation.  Each
  // allow-list is therefore intersected explicitly instead of being spread.
  if (hasPolicyValue(parent, "allowedTables") || hasPolicyValue(child, "allowedTables")) {
    merged.allowedTables = intersectAllowedTables(parent.allowedTables, child.allowedTables);
  }
  if (hasPolicyValue(parent, "allowedColumns") || hasPolicyValue(child, "allowedColumns")) {
    merged.allowedColumns = intersectAllowedColumns(parent.allowedColumns, child.allowedColumns, merged.allowedTables);
  }
  // When the base policy deliberately omits a table allow-list, an explicit
  // child column map still denotes a closed scope.  Derive the corresponding
  // table list instead of letting sql-guard's missing-table-key path become
  // unrestricted.
  if (!hasPolicyValue(parent, "allowedTables") && !hasPolicyValue(child, "allowedTables") && hasPolicyValue(child, "allowedColumns")) {
    const childTables = Object.keys(policyMap(child.allowedColumns) || {});
    merged.allowedTables = childTables.length ? childTables : [NO_ALLOWED_TABLE];
  }
  if (hasPolicyValue(parent, "allowedRelations") || hasPolicyValue(child, "allowedRelations")) {
    // `allowedRelations: []` is a meaningful deny-all relation policy in the
    // SQL guard, so an empty intersection must stay empty (never fall back to
    // an override list).
    merged.allowedRelations = intersectAllowedRelations(parent.allowedRelations, child.allowedRelations);
  }

  // Deny-lists and mandatory predicates compose monotonically: an override
  // can add a restriction, but it can never erase one from the catalog.
  merged.forbiddenColumns = unionPolicyValues(parent.forbiddenColumns, child.forbiddenColumns);
  merged.forbiddenOutputColumns = unionPolicyValues(parent.forbiddenOutputColumns, child.forbiddenOutputColumns);
  merged.mandatoryFilters = unionPolicyObjects(parent.mandatoryFilters, child.mandatoryFilters);

  // Preserve the strongest dictionary/type constraints.  Adding a closed
  // enum or a value/column kind is safe; replacing a parent constraint is not.
  merged.enums = mergeEnumPolicies(parent.enums, child.enums);
  merged.columnKinds = mergeColumnKinds(parent.columnKinds, child.columnKinds);
  merged.valueKinds = unionValueKinds(parent.valueKinds, child.valueKinds);
  if (Array.isArray(valueKinds) && valueKinds.length) merged.valueKinds = unionValueKinds(merged.valueKinds, valueKinds);

  const parentMaxRows = finitePositive(parent.maxRows);
  const childMaxRows = finitePositive(child.maxRows);
  if (parentMaxRows != null || childMaxRows != null) {
    const candidates = [parentMaxRows, childMaxRows].filter((item) => item != null);
    merged.maxRows = Math.min(...candidates);
  }

  // `forbidSensitiveOutput` is retained for API compatibility/documentation;
  // the deny-list union above is intentionally unconditional so an override
  // cannot clear sensitive-output protection supplied by the base policy.
  void forbidSensitiveOutput;
  return merged;
}

const NO_ALLOWED_TABLE = "__query_execution_kernel_denied__";

function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function hasPolicyValue(policy, key) { return Object.prototype.hasOwnProperty.call(policy || {}, key) && policy[key] != null; }

function policyList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (value instanceof Set) return [...value].map((item) => String(item ?? "").trim()).filter(Boolean);
  return null;
}

function intersectAllowedTables(parentValue, childValue) {
  const parentList = policyList(parentValue);
  const childList = policyList(childValue);
  if (parentList == null) {
    if (childList == null) return parentValue == null ? parentValue : [NO_ALLOWED_TABLE];
    return childList.length ? [...new Set(childList)] : [NO_ALLOWED_TABLE];
  }
  if (childList == null) return parentList.length ? parentList : [NO_ALLOWED_TABLE];
  const parentSet = new Set(parentList.map(normalizeIdentifier));
  const result = childList.filter((item) => parentSet.has(normalizeIdentifier(item)));
  return result.length ? [...new Set(result)] : [NO_ALLOWED_TABLE];
}

function intersectAllowedColumns(parentValue, childValue, allowedTables) {
  const parentMap = policyMap(parentValue);
  const childMap = policyMap(childValue);
  if (parentMap == null) {
    if (childMap == null) return parentValue == null ? parentValue : { [NO_ALLOWED_TABLE]: [] };
    return completeColumnPolicyForTables(cloneColumnPolicy(childMap), allowedTables);
  }
  if (childMap == null) return cloneColumnPolicy(parentMap);
  const parentByTable = mapPolicyEntries(parentMap);
  const childByTable = mapPolicyEntries(childMap);
  const tableSet = policyList(allowedTables);
  const result = {};
  for (const [parentTable, parentColumns] of parentByTable.entries()) {
    const normalizedTable = normalizeIdentifier(parentTable);
    if (tableSet && tableSet.length && !tableSet.some((item) => normalizeIdentifier(item) === normalizedTable)) continue;
    const childEntry = childByTable.get(normalizedTable);
    if (!childEntry) {
      // An explicitly supplied child map is a complete scope declaration:
      // omitted tables receive an empty list.  Keeping an empty entry is
      // important because sql-guard treats a missing map key as unrestricted.
      result[parentTable] = [];
      continue;
    }
    const childColumns = new Set(normalizeColumnList(childEntry).map(normalizeIdentifier));
    result[parentTable] = normalizeColumnList(parentColumns).filter((column) => childColumns.has(normalizeIdentifier(column)));
  }
  // If the parent had no table entries, a child map cannot widen it.  Emit
  // empty entries for the intersected tables so an explicit empty child map
  // remains a deny-all column policy rather than becoming guardSql's
  // unrestricted `{}` form.
  if (!Object.keys(result).length && tableSet?.length) {
    for (const table of tableSet) if (normalizeIdentifier(table) !== normalizeIdentifier(NO_ALLOWED_TABLE)) result[table] = [];
  }
  return result;
}

function policyMap(value) { return isRecord(value) ? value : null; }

function mapPolicyEntries(value) {
  return new Map(Object.entries(value || {}).map(([key, columns]) => [normalizeIdentifier(key), columns]));
}

function normalizeColumnList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (value instanceof Set) return [...value].map((item) => String(item ?? "").trim()).filter(Boolean);
  return [];
}

function cloneColumnPolicy(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([table, columns]) => [table, normalizeColumnList(columns)]));
}

function completeColumnPolicyForTables(value, allowedTables) {
  const result = value || {};
  for (const table of policyList(allowedTables) || []) {
    if (normalizeIdentifier(table) === normalizeIdentifier(NO_ALLOWED_TABLE)) continue;
    if (!Object.keys(result).some((key) => normalizeIdentifier(key) === normalizeIdentifier(table))) result[table] = [];
  }
  return result;
}

function intersectAllowedRelations(parentValue, childValue) {
  const parentList = policyListObjects(parentValue);
  const childList = policyListObjects(childValue);
  if (parentList == null) return [];
  if (childList == null) return parentList;
  const childKeys = new Set(childList.flatMap(relationPolicyKeys));
  return parentList.filter((relation) => relationPolicyKeys(relation).some((key) => childKeys.has(key)));
}

function policyListObjects(value) {
  if (Array.isArray(value)) return value.filter((item) => isRecord(item));
  if (value instanceof Set) return [...value].filter((item) => isRecord(item));
  return null;
}

function relationPolicyKeys(relation) {
  if (!isRecord(relation)) return [];
  const keys = [];
  const id = relation.id ?? relation.relationId;
  if (id != null && String(id).trim()) keys.push(`id:${String(id).trim()}`);
  const fromTable = relation.fromTable ?? relation.from_table;
  const fromCol = relation.fromCol ?? relation.fromColumn ?? relation.from_col;
  const toTable = relation.toTable ?? relation.to_table;
  const toCol = relation.toCol ?? relation.toColumn ?? relation.to_col;
  if ([fromTable, fromCol, toTable, toCol].every((item) => String(item ?? "").trim())) {
    const left = `${normalizeIdentifier(fromTable)}.${normalizeIdentifier(fromCol)}`;
    const right = `${normalizeIdentifier(toTable)}.${normalizeIdentifier(toCol)}`;
    keys.push(`edge:${left}>${right}`, `edge:${right}>${left}`);
  }
  return keys;
}

function unionPolicyValues(parentValue, childValue) {
  const values = [...(policyList(parentValue) || []), ...(policyList(childValue) || [])];
  if (!values.length && parentValue == null && childValue == null) return parentValue ?? childValue;
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeIdentifier(value);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function unionPolicyObjects(parentValue, childValue) {
  const values = [...(Array.isArray(parentValue) ? parentValue : []), ...(Array.isArray(childValue) ? childValue : [])];
  if (!values.length && parentValue == null && childValue == null) return parentValue ?? childValue;
  const seen = new Set();
  return values.filter((value) => {
    let key;
    try { key = JSON.stringify(value); } catch { key = String(value); }
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function mergeEnumPolicies(parentValue, childValue) {
  const parentMap = isRecord(parentValue) ? parentValue : {};
  const childMap = isRecord(childValue) ? childValue : {};
  const result = {};
  const childByKey = new Map(Object.entries(childMap).map(([key, value]) => [normalizeIdentifier(key), [key, value]]));
  for (const [parentKey, parentSpec] of Object.entries(parentMap)) {
    const childEntry = childByKey.get(normalizeIdentifier(parentKey));
    if (!childEntry) { result[parentKey] = cloneEnumSpec(parentSpec); continue; }
    result[parentKey] = intersectEnumSpec(parentSpec, childEntry[1]);
    childByKey.delete(normalizeIdentifier(parentKey));
  }
  // A dictionary absent from the parent starts from an unrestricted field;
  // adding the child's dictionary is a safe narrowing operation.
  for (const [key, value] of childByKey.values()) result[key] = cloneEnumSpec(value);
  return Object.keys(result).length ? result : (parentValue ?? childValue);
}

function cloneEnumSpec(value) {
  if (Array.isArray(value)) return [...value];
  return isRecord(value) ? { ...value, ...(Array.isArray(value.values) ? { values: [...value.values] } : {}) } : value;
}

function intersectEnumSpec(parentValue, childValue) {
  const parentSpec = normalizeEnumSpec(parentValue);
  const childSpec = normalizeEnumSpec(childValue);
  const parentClosed = parentSpec.mode === "closed" && Array.isArray(parentSpec.values);
  const childClosed = childSpec.mode === "closed" && Array.isArray(childSpec.values);
  if (!parentClosed && !childClosed) return cloneEnumSpec(parentValue);
  if (parentClosed && !childClosed) return { ...parentSpec, values: [...parentSpec.values] };
  if (!parentClosed && childClosed) return { ...childSpec, values: [...childSpec.values] };
  const childValues = new Set(childSpec.values.map((item) => String(item)));
  return { ...parentSpec, mode: "closed", values: parentSpec.values.filter((item) => childValues.has(String(item))) };
}

function normalizeEnumSpec(value) {
  if (Array.isArray(value)) return { mode: "closed", values: [...value] };
  if (isRecord(value)) return { mode: String(value.mode || "closed").toLowerCase(), values: Array.isArray(value.values) ? [...value.values] : [] };
  return { mode: "unknown", values: [] };
}

function mergeColumnKinds(parentValue, childValue) {
  const result = isRecord(parentValue) ? { ...parentValue } : {};
  if (isRecord(childValue)) {
    for (const [key, value] of Object.entries(childValue)) {
      const existingKey = Object.keys(result).find((item) => normalizeIdentifier(item) === normalizeIdentifier(key));
      // Never replace a catalog type hint.  A child may add a hint for a
      // previously untyped column, which only makes value validation stricter.
      if (!existingKey || result[existingKey] == null || result[existingKey] === "") result[key] = value;
    }
  }
  return Object.keys(result).length ? result : (parentValue ?? childValue);
}

function unionValueKinds(parentValue, childValue) {
  const values = [...(Array.isArray(parentValue) ? parentValue : []), ...(Array.isArray(childValue) ? childValue : [])];
  if (!values.length && parentValue == null && childValue == null) return parentValue ?? childValue;
  const seen = new Set();
  return values.filter((item) => {
    const value = String(item?.value ?? "");
    const kind = String(item?.kind ?? "");
    const key = `${value.toLowerCase()}\u0000${kind.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function cloneRun(run) {
  return run ? structuredClone(run) : null;
}

function registryFailure(code, error) {
  const reason = String(error || "execution ID 无效");
  return { ok: false, stage: "registry", code, error: reason, reason, retryable: false, runs: [] };
}

function resolveValue(getter, fallback) {
  try { return typeof getter === "function" ? getter() : fallback; } catch { return fallback; }
}

function resolveSignal(value) {
  try { return typeof value === "function" ? value() : value; } catch { return undefined; }
}

function resolveDisclosure(getter, fallback) {
  const value = resolveValue(getter, fallback);
  if (value instanceof Set) return new Set([...value].map(normalizeIdentifier));
  if (Array.isArray(value)) return new Set(value.map(normalizeIdentifier));
  return new Set();
}

function failureWithVerdict(failure, verdict) {
  return { ...kernelFailure(failure), verdict, ...(verdict?.details ? { details: verdict.details } : {}) };
}

function normalizeEnums(enums) {
  if (!enums || typeof enums !== "object") return {};
  return Object.fromEntries(Object.entries(enums).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value];
    if (value && typeof value === "object") return [key, value];
    return [key, { mode: "unknown", values: [] }];
  }));
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

function normalizeIdentifier(value) { return String(value || "").replaceAll("`", "").toLowerCase(); }
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
