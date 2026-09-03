import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { equivalentResults } from "./evaluation-service.mjs";
import { redactTypedLiterals } from "./query-column-semantics.mjs";

/**
 * Local-only candidate evaluation helpers.
 *
 * This module deliberately has no HTTP client, Anthropic SDK call, or access
 * to the production bridge factory.  A caller supplies deterministic runners
 * (normally a fixture-backed baseline and a fake Claude bridge) and receives a
 * pairwise report that is safe to print in CI.  It is preparation for P5, not
 * a production rollout gate.
 */
export const CLAUDE_LOCAL_EVAL_VERSION = "claude-local-eval-v1";

const DEFAULT_TOKEN_USAGE = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  available: false,
});

/**
 * Run a deterministic baseline/candidate comparison.
 *
 * `cases` must carry `expectedRows`; the harness never executes Gold SQL and
 * never receives a Gold SQL string.  Runners receive one case at a time and
 * may return either a query answer or `{ outcome, localOnly, paidApiCalls }`.
 * The latter form lets an integration adapter attach local-safety metadata
 * without changing the production QueryAnswer shape.
 */
export async function runClaudeCandidatePairwise({
  cases,
  baselineRunner,
  candidateRunner,
  setName = "local-claude-candidate",
  tolerance = 1e-6,
  onProgress,
} = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("本地 Claude 评测 cases 必须是非空数组");
  if (typeof baselineRunner !== "function") throw new Error("本地 Claude 评测需要 baselineRunner");
  if (typeof candidateRunner !== "function") throw new Error("本地 Claude 评测需要 candidateRunner");
  const normalizedTolerance = finiteNonNegative(tolerance, 1e-6);
  const results = [];
  for (const [index, item] of cases.entries()) {
    const current = normalizeCase(item, index);
    onProgress?.({ index, total: cases.length, progress: Math.round(index / cases.length * 100), id: current.id });
    const expectedRows = current.expectedRows;
    const baselineRaw = await invokeRunner(baselineRunner, current);
    const candidateRaw = await invokeRunner(candidateRunner, current);
    const baseline = summarizeOutcome(baselineRaw, expectedRows, normalizedTolerance);
    const candidate = summarizeOutcome(candidateRaw, expectedRows, normalizedTolerance);
    results.push({
      id: redactTypedLiterals(current.id),
      category: redactTypedLiterals(current.category),
      question: redactTypedLiterals(current.question),
      baseline,
      candidate,
      delta: {
        pass: Number(candidate.passed) - Number(baseline.passed),
        durationMs: nullableDelta(candidate.durationMs, baseline.durationMs),
        totalTokens: nullableDelta(candidate.tokenUsage.totalTokens, baseline.tokenUsage.totalTokens),
      },
    });
  }
  onProgress?.({ index: cases.length, total: cases.length, progress: 100, id: null });
  const baseline = aggregateOutcomes(results.map((item) => item.baseline), "baseline");
  const candidate = aggregateOutcomes(results.map((item) => item.candidate), "claude_required");
  const regressions = results.filter((item) => item.baseline.passed && !item.candidate.passed).map((item) => item.id);
  const improvements = results.filter((item) => !item.baseline.passed && item.candidate.passed).map((item) => item.id);
  const safety = summarizeSafety(results.map((item) => item.candidate));
  return {
    version: CLAUDE_LOCAL_EVAL_VERSION,
    mode: "local_fake",
    candidateMode: "required",
    productionGate: false,
    setName: redactTypedLiterals(String(setName || "local-claude-candidate").trim()),
    total: results.length,
    baseline,
    candidate,
    delta: {
      passRate: candidate.passRate - baseline.passRate,
      averageDurationMs: nullableDelta(candidate.averageDurationMs, baseline.averageDurationMs),
      averageTokens: nullableDelta(candidate.averageTokens, baseline.averageTokens),
      regressions,
      improvements,
    },
    safety,
    cases: results,
  };
}

/**
 * A tiny deterministic Claude adapter for tests and local fixtures.
 *
 * It intentionally calls only the request MCP tools supplied by the caller;
 * it never starts a process and never contacts Anthropic.  `plans` is keyed by
 * exact question (or `planFor` can choose a plan programmatically).  A plan
 * can be `{sql, conclusion}` for an answered case, or an explicit
 * `{status:"clarification"|"refused"|"failed", ...}` terminal.
 */
export function createDeterministicClaudeBridge({
  plans = {},
  planFor,
  defaultConclusion = "本地 fake Claude 查询完成。",
  model = "local-fake-claude",
  promptVersion = "claude-local-fake-v1",
  tokenUsage = { promptTokens: 120, completionTokens: 40, totalTokens: 160, available: true },
} = {}) {
  const calls = [];
  const bridge = {
    localOnly: true,
    paidApiCalls: 0,
    calls,
    async run(input = {}) {
      const question = String(input.question || "").trim();
      calls.push({ question: redactTypedLiterals(question), requiredMode: input.requireModel === true });
      let plan;
      try {
        plan = typeof planFor === "function" ? await planFor({ ...input, question }) : plans[question];
      } catch (error) {
        return failedLocalOutcome("FAKE_PLAN_ERROR", safeReason(error), "execution_error");
      }
      if (typeof plan === "string") plan = { sql: plan };
      if (!plan || typeof plan !== "object") return failedLocalOutcome("FAKE_PLAN_MISSING", "本地 fake Claude 没有为该问题配置计划", "schema_gap");
      const status = String(plan.status || "answered").trim().toLowerCase();
      const common = {
        planningMode: "claude",
        localOnly: true,
        paidApiCalls: 0,
        model,
        promptVersion,
        tokenUsage: normalizeTokenUsage(plan.tokenUsage || tokenUsage),
        iterations: positiveInteger(plan.iterations, 1),
      };
      if (status === "clarification") {
        return {
          status: "clarification",
          clarification: {
            question: redactTypedLiterals(String(plan.question || "请补充业务口径。")),
            options: Array.isArray(plan.options) ? plan.options.map((item) => redactTypedLiterals(String(item))).slice(0, 5) : [],
            allowFreeText: plan.allowFreeText !== false,
          },
          question: redactTypedLiterals(String(plan.question || "请补充业务口径。")),
          options: Array.isArray(plan.options) ? plan.options.map((item) => redactTypedLiterals(String(item))).slice(0, 5) : [],
          allowFreeText: plan.allowFreeText !== false,
          ...common,
        };
      }
      if (status === "refused") {
        const reason = redactTypedLiterals(String(plan.reason || "本地 fake Claude 拒绝回答。"));
        return { status: "refused", refused: true, reason, failureClass: String(plan.failureClass || "schema_gap"), ...common };
      }
      if (status === "failed") return failedLocalOutcome(plan.errorCode || "FAKE_FAILURE", plan.reason || "本地 fake Claude 失败", plan.failureClass || "execution_error", common);
      if (status !== "answered") return failedLocalOutcome("FAKE_STATUS_INVALID", `不支持的本地终态：${status}`, "protocol_error", common);
      const mcp = input.mcp || input.mcpSession;
      if (!mcp || typeof mcp.callTool !== "function") return failedLocalOutcome("MCP_UNAVAILABLE", "本地 fake Claude 缺少请求 MCP", "mcp_unavailable", common);
      if (plan.skipOntologyRead !== true) {
        const readResult = await mcp.callTool("ontology_read", {
          operation: String(plan.ontologyOperation || "overview"),
          ...(plan.ontologyQuery ? { query: String(plan.ontologyQuery) } : {}),
        });
        if (!readResult?.ok) return failedLocalOutcome(readResult.errorCode || "ONTOLOGY_READ_FAILED", readResult.error || "ontology_read 失败", "protocol_error", common);
      }
      const sql = String(plan.sql || "").trim();
      if (!sql) return failedLocalOutcome("FAKE_SQL_MISSING", "本地 fake Claude 计划缺少 SQL", "schema_gap", common);
      const receipt = await mcp.callTool("db_query", { name: String(plan.name || "local-eval"), sql });
      if (!receipt?.ok || !receipt.executionId) return failedLocalOutcome(receipt?.errorCode || "DB_QUERY_FAILED", receipt?.error || "db_query 失败", receipt?.failureClass || "execution_error", common);
      const conclusion = redactTypedLiterals(String(plan.conclusion || defaultConclusion));
      return {
        status: "answered",
        executionIds: [String(receipt.executionId)],
        conclusion,
        ...(plan.delta ? { delta: redactTypedLiterals(String(plan.delta)) } : {}),
        toolTrace: typeof mcp.getTrace === "function" ? mcp.getTrace() : [],
        ...common,
      };
    },
  };
  return bridge;
}

/** Read a local fixture file. This helper performs no network or SQL work. */
export async function readClaudeLocalEvalFixture(path) {
  const raw = await readFile(path, "utf8");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("本地 Claude 评测 fixture 必须是合法 JSON"); }
  validateFixture(value);
  return value;
}

export function validateFixture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地 Claude 评测 fixture 必须是 JSON 对象");
  if (!Array.isArray(value.cases) || !value.cases.length) throw new Error("本地 Claude 评测 fixture cases 必须是非空数组");
  for (const [index, item] of value.cases.entries()) {
    if (!item || typeof item !== "object") throw new Error(`fixture 第 ${index + 1} 条用例格式错误`);
    if (!String(item.question || "").trim()) throw new Error(`fixture 第 ${index + 1} 条缺少 question`);
    if (!Array.isArray(item.expectedRows)) throw new Error(`fixture 第 ${index + 1} 条 expectedRows 必须是数组`);
    if (item.baseline == null || item.candidate == null) throw new Error(`fixture 第 ${index + 1} 条必须同时提供 baseline 和 candidate`);
  }
  return value;
}

function normalizeCase(item, index) {
  if (!item || typeof item !== "object") throw new Error(`本地 Claude 评测第 ${index + 1} 条用例格式错误`);
  const question = String(item.question || "").trim();
  if (!question) throw new Error(`本地 Claude 评测第 ${index + 1} 条 question 为空`);
  if (!Array.isArray(item.expectedRows)) throw new Error(`本地 Claude 评测第 ${index + 1} 条 expectedRows 必须是数组`);
  return {
    ...item,
    id: String(item.id || `case-${index + 1}`),
    category: String(item.category || "未分类"),
    question,
    expectedRows: item.expectedRows,
  };
}

async function invokeRunner(runner, item) {
  try {
    const value = await runner(item);
    if (value && value.outcome && typeof value.outcome === "object") {
      return { ...value.outcome, localOnly: value.localOnly ?? value.outcome.localOnly, paidApiCalls: value.paidApiCalls ?? value.outcome.paidApiCalls };
    }
    return value && typeof value === "object" ? value : { status: "failed", reason: "runner 没有返回对象", failureClass: "harness_error" };
  } catch (error) {
    return { status: "failed", reason: safeReason(error), failureClass: "harness_error", localOnly: true, paidApiCalls: 0 };
  }
}

function summarizeOutcome(outcome = {}, expectedRows, tolerance) {
  const status = normalizeStatus(outcome);
  const rows = rowsFromOutcome(outcome);
  let passed = false;
  let reason = null;
  let failureClass = null;
  if (status === "answered") {
    const verdict = equivalentResults(expectedRows, rows, { tolerance });
    passed = verdict.equal;
    reason = verdict.equal ? null : verdict.reason;
    failureClass = verdict.equal ? null : "result_mismatch";
  } else {
    reason = outcome.reason || outcome.error || (status === "clarification" ? "需要人工澄清" : `${status} 终态`);
    failureClass = status === "clarification" ? "clarification" : String(outcome.failureClass || status || "execution_error");
  }
  const trace = Array.isArray(outcome.toolTrace) ? outcome.toolTrace : Array.isArray(outcome.evidence?.toolTrace) ? outcome.evidence.toolTrace : [];
  const tokenUsage = normalizeTokenUsage(outcome.tokenUsage || outcome.evidence?.tokenUsage);
  const sql = outcome.generatedSql || outcome.evidence?.sql || outcome.run?.sql || "";
  return {
    status,
    passed,
    failureClass: passed ? null : redactTypedLiterals(failureClass || "execution_error"),
    reason: passed ? null : redactTypedLiterals(clip(String(reason || "未通过"), 500)),
    planningMode: outcome.planningMode || outcome.evidence?.planningMode || null,
    planningAttempts: finiteNumber(outcome.planningAttempts ?? outcome.evidence?.planningAttempts),
    durationMs: finiteNumber(outcome.durationMs ?? outcome.evidence?.durationMs),
    rowCount: Array.isArray(rows) ? rows.length : null,
    sqlHash: sql ? hashText(sql).slice(0, 16) : null,
    toolCalls: trace.length,
    toolSuccesses: trace.filter((item) => item?.ok).length,
    tokenUsage,
    localOnly: outcome.localOnly === true || outcome.metadata?.localOnly === true,
    paidApiCalls: nonNegativeNumber(outcome.paidApiCalls ?? outcome.metadata?.paidApiCalls, 0),
  };
}

function aggregateOutcomes(items, requestedMode) {
  const total = items.length;
  const passed = items.filter((item) => item.passed).length;
  const durations = items.map((item) => item.durationMs).filter(Number.isFinite);
  const tokenItems = items.filter((item) => item.tokenUsage.available && item.tokenUsage.totalTokens > 0);
  const toolCalls = items.reduce((sum, item) => sum + Number(item.toolCalls || 0), 0);
  const toolSuccesses = items.reduce((sum, item) => sum + Number(item.toolSuccesses || 0), 0);
  return {
    requestedMode,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    refusalRate: total ? items.filter((item) => item.status === "refused").length / total : 0,
    clarificationRate: total ? items.filter((item) => item.status === "clarification").length / total : 0,
    averageDurationMs: average(durations),
    p95DurationMs: percentile(durations, 0.95),
    toolCalls,
    toolSuccesses,
    toolSuccessRate: toolCalls ? toolSuccesses / toolCalls : 0,
    tokenCoverage: total ? tokenItems.length / total : 0,
    averageTokens: average(tokenItems.map((item) => item.tokenUsage.totalTokens)),
    p95Tokens: percentile(tokenItems.map((item) => item.tokenUsage.totalTokens), 0.95),
  };
}

function summarizeSafety(items) {
  const paidApiCalls = items.reduce((sum, item) => sum + Number(item.paidApiCalls || 0), 0);
  const violations = items.filter((item) => !item.localOnly || Number(item.paidApiCalls || 0) > 0).map((item, index) => ({ index, reason: !item.localOnly ? "runner 未声明 localOnly" : "检测到 paidApiCalls" }));
  return {
    localOnly: violations.length === 0,
    paidApiCalls,
    networkCalls: 0,
    realAnthropicProbe: false,
    violations,
  };
}

function normalizeStatus(outcome) {
  if (outcome?.status) return String(outcome.status).trim().toLowerCase();
  if (outcome?.refused) return "refused";
  if (outcome?.clarification) return "clarification";
  if (Array.isArray(outcome?.rows)) return "answered";
  return "failed";
}

function rowsFromOutcome(outcome) {
  if (Array.isArray(outcome?.rows)) return outcome.rows;
  if (Array.isArray(outcome?.runs) && outcome.runs.length === 1 && Array.isArray(outcome.runs[0]?.rows)) return outcome.runs[0].rows;
  return [];
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_TOKEN_USAGE };
  const promptTokens = nonNegativeNumber(value.promptTokens ?? value.prompt_tokens, 0);
  const completionTokens = nonNegativeNumber(value.completionTokens ?? value.completion_tokens, 0);
  const suppliedTotal = nonNegativeNumber(value.totalTokens ?? value.total_tokens, null);
  const available = value.available === true || suppliedTotal != null || promptTokens > 0 || completionTokens > 0;
  return { promptTokens, completionTokens, totalTokens: suppliedTotal ?? promptTokens + completionTokens, available };
}

function failedLocalOutcome(errorCode, reason, failureClass, common = {}) {
  return { status: "failed", failed: true, errorCode, reason: redactTypedLiterals(String(reason || "本地 fake Claude 失败")), failureClass, ...common, localOnly: true, paidApiCalls: 0 };
}

function safeReason(error) { return redactTypedLiterals(String(error?.message || error?.reason || error || "未知错误")); }
function clip(value, max) { return value.length > max ? `${value.slice(0, max)}…` : value; }
function hashText(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function finiteNonNegative(value, fallback) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function nonNegativeNumber(value, fallback) { if (value == null || value === "") return fallback; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function nullableDelta(left, right) { return Number.isFinite(left) && Number.isFinite(right) ? left - right : null; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(values, quantile) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]; }
