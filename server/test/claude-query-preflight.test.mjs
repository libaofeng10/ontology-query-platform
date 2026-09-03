import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildPreflightEnv,
  runProbe,
  runClaudeQueryPreflight,
} from "../../scripts/claude-query-preflight.mjs";

const enabledConfig = {
  claudeQuery: {
    mode: "prefer",
    binary: "/fake/claude",
    model: "claude-test",
    timeoutMs: 1_000,
    maxBudgetUsd: 1,
  },
};

function readiness() {
  return {
    ok: true,
    enabled: true,
    mode: "prefer",
    binary: { path: "/fake/claude", exists: true, executable: true, version: "2.1.258", minVersion: "2.1.248" },
    temp: { path: "/tmp", writable: true },
    modelConfigured: true,
    authConfigured: true,
    errors: [],
  };
}

test("preflight child env reuses the bridge allowlist, including proxy and base URL", () => {
  const childEnv = buildPreflightEnv({
    sourceEnv: {
      PATH: "/bin",
      HTTP_PROXY: "http://proxy.example",
      HTTPS_PROXY: "https://proxy.example",
      ALL_PROXY: "socks5://proxy.example",
      NO_PROXY: "localhost,127.0.0.1",
      ANTHROPIC_API_KEY: "secret-key",
      ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
      DATABASE_URL: "mysql://should-not-pass",
      API_WRITE_TOKEN: "platform-token-should-not-pass",
      HOME: "/unsafe/home",
    },
    configDir: "/private/preflight/config",
    tmpDir: "/private/preflight/tmp",
    homeDir: "/private/preflight/home",
  });

  assert.equal(childEnv.HTTP_PROXY, "http://proxy.example");
  assert.equal(childEnv.HTTPS_PROXY, "https://proxy.example");
  assert.equal(childEnv.ALL_PROXY, "socks5://proxy.example");
  assert.equal(childEnv.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://anthropic.example/v1");
  assert.equal(childEnv.ANTHROPIC_API_KEY, "secret-key");
  assert.equal(childEnv.DATABASE_URL, undefined);
  assert.equal(childEnv.API_WRITE_TOKEN, undefined);
  assert.equal(childEnv.HOME, "/private/preflight/home");
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, "/private/preflight/config");
  assert.equal(childEnv.CLAUDE_CODE_TMPDIR, "/private/preflight/tmp");
  assert.equal(childEnv.NO_COLOR, "1");
});

test("preflight timeout escalates SIGINT to SIGTERM/SIGKILL and waits for close", async () => {
  const signals = [];
  let closed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setImmediate(() => {
          closed = true;
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, signal);
        });
      }
      return true;
    };
    return child;
  };

  const startedAt = Date.now();
  const result = await runProbe({
    binary: "/fake/claude",
    model: "claude-test",
    timeoutMs: 5,
    terminateGraceMs: 10,
    env: {},
    spawnImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "timeout");
  assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(closed, true);
  // The result must not resolve at the initial SIGINT; it waits through the
  // bounded escalation/close path (three 10 ms grace windows here).
  assert.ok(Date.now() - startedAt >= 20);
});

test("--local-only validates readiness without spawning a potentially billable CLI", async () => {
  let spawned = 0;
  const result = await runClaudeQueryPreflight({
    config: enabledConfig,
    env: { ANTHROPIC_API_KEY: "secret-key", CLAUDE_QUERY_MODEL: "claude-test" },
    localOnly: true,
    readinessChecker: () => readiness(),
    spawnImpl: () => {
      spawned += 1;
      throw new Error("spawn must not be reached in local-only mode");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "prefer");
  assert.equal(spawned, 0);
  assert.equal(result.readiness.authConfigured, true);
});

test("--check-enabled validates deployment prerequisites while runtime mode stays off", async () => {
  let observedMode;
  let spawned = 0;
  const result = await runClaudeQueryPreflight({
    config: { claudeQuery: { mode: "off" } },
    env: { ANTHROPIC_API_KEY: "secret-key" },
    checkEnabled: true,
    localOnly: true,
    readinessChecker: ({ config }) => {
      observedMode = config.claudeQuery.mode;
      return readiness();
    },
    spawnImpl: () => {
      spawned += 1;
      throw new Error("--check-enabled must not spawn without explicit API probe");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "off");
  assert.equal(result.checkedAsEnabled, true);
  assert.equal(observedMode, "prefer");
  assert.equal(spawned, 0);
});

test("preflight creates private config/tmp directories and removes the run directory in finally", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ontoquery-preflight-test-"));
  let observed;
  const spawnImpl = (_binary, args, options) => {
    observed = { args, env: options.env };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ ok: true }));
      child.emit("close", 0, null);
    });
    return child;
  };

  try {
    const result = await runClaudeQueryPreflight({
      config: enabledConfig,
      env: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "secret-key",
        ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
        HTTP_PROXY: "http://proxy.example",
        DATABASE_URL: "mysql://must-not-pass",
      },
      readinessChecker: () => readiness(),
      spawnImpl,
      tempRoot,
    });

    assert.equal(result.ok, true);
    assert.ok(observed.args.includes("--bare"));
    assert.equal(observed.env.ANTHROPIC_BASE_URL, "https://anthropic.example/v1");
    assert.equal(observed.env.HTTP_PROXY, "http://proxy.example");
    assert.equal(observed.env.DATABASE_URL, undefined);
    assert.match(observed.env.CLAUDE_CONFIG_DIR, new RegExp(`^${escapeRegExp(tempRoot)}/run-[^/]+/config$`));
    assert.match(observed.env.CLAUDE_CODE_TMPDIR, new RegExp(`^${escapeRegExp(tempRoot)}/run-[^/]+/tmp$`));
    assert.notEqual(observed.env.CLAUDE_CONFIG_DIR, "/tmp");
    assert.notEqual(observed.env.CLAUDE_CODE_TMPDIR, "/tmp");
    assert.equal((await readdir(tempRoot)).length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight errors redact the API key and still clean up after CLI failure", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ontoquery-preflight-secret-test-"));
  const secret = "sk-test-secret-value";
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.end(`request failed api_key=${secret} raw=${secret}`);
      child.emit("close", 1, null);
    });
    return child;
  };

  try {
    const result = await runClaudeQueryPreflight({
      config: enabledConfig,
      env: { ANTHROPIC_API_KEY: secret },
      readinessChecker: () => readiness(),
      spawnImpl,
      tempRoot,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "cli_error");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(secret)));
    assert.equal((await readdir(tempRoot)).length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
