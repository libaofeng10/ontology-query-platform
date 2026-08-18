import { guardSql } from "./sql-guard.mjs";

const GENERIC_TOKENS = new Set(["id", "no", "code", "key", "name", "time", "date", "type", "status", "flag", "num", "count", "info", "desc", "text", "value", "data", "is", "gmt", "create", "modify", "update"]);
const STRING_TYPE = /char|text|varchar/i;

// 语义链路 0 行时的口径反思探针：
// 对字符串等值/包含过滤的字段，在同表内找“词干兄弟”字段（如 office_name / user_office_name），
// 用受护栏保护的 COUNT 验证同一个值是否出现在兄弟字段中。
export async function probeZeroResult({ plan, schema, catalog, connector, source, signal, maxSiblings = 4, explainMaxRows = 1_000_000 }) {
  const targets = probeTargets(plan, schema, catalog, maxSiblings);
  const findings = [];
  for (const target of targets) {
    const sql = `SELECT COUNT(*) AS match_count FROM ${quoteId(target.table)} WHERE LOCATE(${literal(target.value)}, ${quoteId(target.siblingColumn)}) > 0`;
    const policy = { allowedTables: [target.table], allowedColumns: { [target.table]: [target.siblingColumn] }, allowedRelations: [], maxRows: 1, enums: {} };
    const verdict = guardSql(sql, policy);
    if (!verdict.ok) continue;
    try {
      const explain = await connector.explain(source, verdict.sql, signal);
      const scanned = explain.reduce((sum, row) => sum + Math.max(0, Number(row.rows || 0)), 0);
      if (scanned > explainMaxRows) continue;
      const [rows] = await connector.query(source, verdict.sql, [], signal);
      const matchCount = Number(rows?.[0]?.match_count || 0);
      if (matchCount > 0) findings.push({ table: target.table, filterColumn: target.filterColumn, siblingColumn: target.siblingColumn, value: target.value, matchCount });
    } catch { /* 探针失败不影响主链路 */ }
  }
  return findings;
}

// 从语义计划的过滤条件推导 (表, 字段, 值) 及其兄弟字段候选。
export function probeTargets(plan, schema, catalog, maxSiblings = 4) {
  const properties = new Map();
  for (const object of schema?.objectTypes || []) for (const property of object.properties || []) properties.set(`${object.apiName}.${property.apiName}`, property);
  const targets = [];
  for (const filter of plan?.filters || []) {
    if (!["eq", "contains"].includes(filter.operator)) continue;
    if (typeof filter.value !== "string" || !filter.value.trim() || filter.value.length > 100) continue;
    const property = properties.get(filter.property);
    const table = property?.mapping?.table;
    const column = property?.mapping?.column;
    if (!table || !column) continue;
    const siblings = siblingColumns(table, column, catalog).slice(0, maxSiblings);
    for (const sibling of siblings) targets.push({ table, filterColumn: column, siblingColumn: sibling, value: filter.value.trim() });
  }
  return targets;
}

export function siblingColumns(table, column, catalog) {
  const columns = catalog?.columnsByTable?.[table] || [];
  const stems = meaningfulTokens(column);
  if (!stems.size) return [];
  return columns
    .filter((item) => item.columnName !== column && !item.isSensitive && STRING_TYPE.test(String(item.dataType || "")))
    .map((item) => ({ name: item.columnName, shared: overlap(stems, meaningfulTokens(item.columnName)) }))
    .filter((item) => item.shared > 0)
    .sort((left, right) => right.shared - left.shared || left.name.localeCompare(right.name))
    .map((item) => item.name);
}

function meaningfulTokens(name) {
  return new Set(String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token)));
}
function overlap(left, right) { let count = 0; for (const token of left) if (right.has(token)) count++; return count; }
function quoteId(value) { return `\`${String(value).replaceAll("`", "``")}\``; }
function literal(value) { return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`; }
