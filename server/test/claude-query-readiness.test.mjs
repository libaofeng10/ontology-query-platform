import assert from "node:assert/strict";
import test from "node:test";
import { inspectClaudeQueryReadiness } from "../src/claude-query-readiness.mjs";

const base = {
  claudeQuery: {
    mode: "prefer", binary: "/bin/sh", model: "claude-test", maxBudgetUsd: 1,
  },
};

test("Claude readiness is green without probing a paid API when disabled", () => {
  const result = inspectClaudeQueryReadiness({ config: { claudeQuery: { mode: "off" } }, env: {} });
  assert.deepEqual(result, { ok: true, enabled: false, mode: "off", binary: null, temp: null, modelConfigured: false, authConfigured: false, errors: [] });
});

test("Claude readiness validates local executable, version, temp, model and key", () => {
  const result = inspectClaudeQueryReadiness({
    config: base,
    env: { ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_TMPDIR: "/tmp" },
    versionProbe: () => "Claude Code 2.1.258",
  });
  assert.equal(result.ok, true);
  assert.equal(result.binary.version, "Claude Code 2.1.258");
  assert.equal(result.temp.writable, true);
  assert.equal(result.authConfigured, true);
  assert.deepEqual(result.errors, []);
});

test("Claude readiness fails closed for missing prerequisites and old CLI", () => {
  const result = inspectClaudeQueryReadiness({
    config: { claudeQuery: { ...base.claudeQuery, binary: "/definitely/missing", model: "", maxBudgetUsd: 0 } },
    env: { CLAUDE_CODE_TMPDIR: "/definitely/missing" },
    versionProbe: () => "2.1.100",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("不存在")));
  assert.ok(result.errors.some((item) => item.includes("临时目录")));
  assert.ok(result.errors.some((item) => item.includes("模型")));
  assert.ok(result.errors.some((item) => item.includes("API_KEY")));
  assert.ok(result.errors.some((item) => item.includes("预算")));
});
