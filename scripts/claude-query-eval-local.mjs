#!/usr/bin/env node

/**
 * Deterministic Claude candidate comparison for CI/local development.
 *
 * This command never starts Claude Code, never reads ANTHROPIC_API_KEY, never
 * opens a network connection, and never persists an evaluation gate.  It is a
 * fixture-backed harness for validating pairwise metrics/reporting before the
 * real P5 evaluation is authorized.
 *
 * Usage:
 *   npm run eval:claude:local
 *   node scripts/claude-query-eval-local.mjs --fixture path/to/local-fixture.json --json --strict
 */
import { fileURLToPath } from "node:url";
import {
  readClaudeLocalEvalFixture,
  runClaudeCandidatePairwise,
} from "../server/src/claude-query-local-eval.mjs";

const DEFAULT_FIXTURE = fileURLToPath(new URL("../examples/evaluation/claude-local.fake.json", import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.help) usage();

try {
  const fixture = await readClaudeLocalEvalFixture(args.fixture || DEFAULT_FIXTURE);
  const byId = new Map(fixture.cases.map((item, index) => [String(item.id || `case-${index + 1}`), item]));
  const report = await runClaudeCandidatePairwise({
    setName: fixture.setName || fixture.version || "claude-local-smoke",
    tolerance: args.tolerance,
    cases: fixture.cases,
    baselineRunner: async (item) => fixtureOutcome(byId.get(item.id)?.baseline, "baseline"),
    candidateRunner: async (item) => fixtureOutcome(byId.get(item.id)?.candidate, "candidate"),
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, args.fixture || DEFAULT_FIXTURE);
  if (args.strict && (report.candidate.failed > 0 || report.delta.regressions.length > 0 || !report.safety.localOnly)) process.exitCode = 2;
} catch (error) {
  console.error(`本地 Claude candidate 评测失败：${error?.message || String(error)}`);
  process.exitCode = 1;
}

function fixtureOutcome(value, role) {
  if (!value || typeof value !== "object") return {
    status: "failed",
    reason: `fixture 缺少 ${role} outcome`,
    failureClass: "harness_error",
    localOnly: true,
    paidApiCalls: 0,
  };
  // This runner only returns in-memory fixture data.  Preserve an explicit
  // false/non-zero marker so --strict catches unsafe fixtures, otherwise mark
  // the deterministic path as local-only with zero paid calls.
  return {
    ...value,
    localOnly: value.localOnly !== false,
    paidApiCalls: Number.isFinite(Number(value.paidApiCalls)) ? Number(value.paidApiCalls) : 0,
  };
}

function printReport(report, fixturePath) {
  console.log(`Claude candidate 本地对比：${report.setName}`);
  console.log(`fixture：${fixturePath}`);
  console.log(`运行边界：${report.mode} / candidate=${report.candidateMode} / productionGate=${report.productionGate}`);
  console.log(`付费/网络：paidApiCalls=${report.safety.paidApiCalls} / networkCalls=${report.safety.networkCalls} / realAnthropicProbe=${report.safety.realAnthropicProbe}`);
  console.log(`基线：${report.baseline.passed}/${report.total}，通过率 ${percent(report.baseline.passRate)}，P95 ${Math.round(report.baseline.p95DurationMs)}ms`);
  console.log(`候选：${report.candidate.passed}/${report.total}，通过率 ${percent(report.candidate.passRate)}，P95 ${Math.round(report.candidate.p95DurationMs)}ms`);
  console.log(`变化：通过率 ${signedPercent(report.delta.passRate)}；改善 ${report.delta.improvements.length}；回退 ${report.delta.regressions.length}`);
  for (const item of report.cases) {
    const marker = item.candidate.passed ? "PASS" : "FAIL";
    const change = item.delta.pass > 0 ? " [改善]" : item.delta.pass < 0 ? " [回退]" : "";
    console.log(`- ${marker}${change} ${item.id}：baseline=${item.baseline.status}/${item.baseline.passed ? "pass" : "fail"} candidate=${item.candidate.status}/${item.candidate.passed ? "pass" : "fail"}${item.candidate.reason ? `；${item.candidate.reason}` : ""}`);
  }
  console.log("说明：该结果只验证 deterministic fake candidate 的评测管道，不代表真实 Claude 正确率、时延或成本。P5 仍需真实只读数据源与受控 Anthropic 调用。");
}

function parseArgs(values) {
  const output = { fixture: null, json: false, strict: false, tolerance: 1e-6, help: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--fixture") output.fixture = requiredValue(values[++index], "--fixture");
    else if (value === "--json") output.json = true;
    else if (value === "--strict") output.strict = true;
    else if (value === "--tolerance") output.tolerance = nonNegativeNumber(requiredValue(values[++index], "--tolerance"), "--tolerance");
    else if (value === "--help" || value === "-h") output.help = true;
    else usage(`未知参数：${value}`);
  }
  return output;
}

function requiredValue(value, flag) { if (value == null || String(value).trim() === "") usage(`${flag} 缺少值`); return String(value); }
function nonNegativeNumber(value, flag) { const number = Number(value); if (!Number.isFinite(number) || number < 0) usage(`${flag} 必须是非负数`); return number; }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function signedPercent(value) { const number = Number(value || 0) * 100; return `${number > 0 ? "+" : ""}${number.toFixed(1)}%`; }

function usage(message) {
  if (message) console.error(message);
  console.error("用法：node scripts/claude-query-eval-local.mjs [--fixture <local.json>] [--json] [--strict] [--tolerance 1e-6]");
  process.exit(message ? 1 : 0);
}

