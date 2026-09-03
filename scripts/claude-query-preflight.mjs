#!/usr/bin/env node

/**
 * Deployment-time Claude Code probe. It is intentionally opt-in: importing
 * this file or starting the API never makes a paid Anthropic request.
 *
 * Usage:
 *   CLAUDE_QUERY_MODEL=... ANTHROPIC_API_KEY=... node scripts/claude-query-preflight.mjs
 *   ... --local-only       # validate enabled prerequisites without an API call
 *   ... --check-enabled    # validate those prerequisites even when mode=off
 */
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "../server/src/config.mjs";
import { CLAUDE_QUERY_ALLOWED_ENV_KEYS } from "../server/src/claude-query-bridge.mjs";
import { inspectClaudeQueryReadiness } from "../server/src/claude-query-readiness.mjs";

export const DEFAULT_PREFLIGHT_TEMP_ROOT = join(tmpdir(), "ontoquery-claude-preflight");
const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
// Keep each escalation step bounded.  The timeout path sends SIGINT first so
// Claude can flush/clean up, then SIGTERM, and finally SIGKILL.  `runProbe`
// only resolves after that bounded sequence (or an earlier `close` event).
export const DEFAULT_PREFLIGHT_TERMINATE_GRACE_MS = 500;

/**
 * Run the local readiness checks and, unless explicitly disabled, one tiny
 * Claude CLI request. The caller owns the deployment environment; request
 * data is never accepted here. `spawnImpl` and `readinessChecker` are test
 * seams and do not change the production network path.
 */
export async function runClaudeQueryPreflight({
  config = defaultConfig,
  env = process.env,
  localOnly = false,
  checkEnabled = false,
  spawnImpl = nodeSpawn,
  readinessChecker = inspectClaudeQueryReadiness,
  tempRoot = DEFAULT_PREFLIGHT_TEMP_ROOT,
} = {}) {
  const sourceEnv = env && typeof env === "object" ? env : process.env;
  const configuredMode = normalizeMode(config?.claudeQuery?.mode);
  const readinessConfig = checkEnabled && configuredMode === "off"
    ? { ...config, claudeQuery: { ...(config?.claudeQuery || {}), mode: "prefer" } }
    : config;
  let readiness;
  try {
    readiness = await readinessChecker({ config: readinessConfig, env: sourceEnv });
  } catch (error) {
    return {
      ok: false,
      failureClass: "readiness_error",
      mode: configuredMode,
      error: safeError(error, sourceEnv.ANTHROPIC_API_KEY),
    };
  }

  if (!readiness?.ok) {
    return {
      ok: false,
      mode: configuredMode,
      ...(checkEnabled && configuredMode === "off" ? { checkedAsEnabled: true } : {}),
      readiness: redactReadiness(readiness, sourceEnv.ANTHROPIC_API_KEY),
    };
  }

  // A disabled bridge is a successful no-op. In particular, never spawn the
  // CLI in this state, even when --local-only was omitted.
  if (localOnly || configuredMode === "off" || readiness.enabled === false || readiness.mode === "off") {
    return {
      ok: true,
      mode: configuredMode,
      ...(checkEnabled && configuredMode === "off" ? { checkedAsEnabled: true } : {}),
      ...(!localOnly && configuredMode === "off" ? { skipped: true } : {}),
      readiness: redactReadiness(readiness, sourceEnv.ANTHROPIC_API_KEY),
    };
  }

  const model = String(config?.claudeQuery?.model || sourceEnv.CLAUDE_QUERY_MODEL || "").trim();
  const timeoutMs = Math.min(Number(config?.claudeQuery?.timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  let prepared;
  try {
    prepared = await preparePreflightDirectory(tempRoot);
  } catch {
    // Do not print the path returned by an fs error: it can contain deployment
    // details and is not useful to the operator running this probe.
    return { ok: false, failureClass: "startup_error", error: "Claude preflight 临时目录准备失败" };
  }

  try {
    const childEnv = buildPreflightEnv({
      sourceEnv,
      configDir: prepared.configDir,
      tmpDir: prepared.tmpDir,
      homeDir: prepared.homeDir,
    });
    return await runProbe({
      binary: readiness.binary.path,
      model,
      timeoutMs,
      env: childEnv,
      apiKey: sourceEnv.ANTHROPIC_API_KEY,
      spawnImpl,
    });
  } finally {
    // Every path after directory creation, including spawn/parse failures,
    // goes through this cleanup. Only the per-run directory is owned here;
    // the configurable parent is intentionally left in place.
    await cleanupPreflightDirectory(prepared.path);
  }
}

/**
 * Construct the child environment using the exact bridge allowlist. In
 * particular, proxy variables and ANTHROPIC_BASE_URL are retained while DB
 * credentials, platform tokens, and unrelated process variables are dropped.
 */
export function buildPreflightEnv({ sourceEnv, env, configDir, tmpDir, homeDir } = {}) {
  const candidate = sourceEnv ?? env ?? process.env;
  const source = candidate && typeof candidate === "object" ? candidate : process.env;
  const childEnv = {};
  for (const key of CLAUDE_QUERY_ALLOWED_ENV_KEYS) {
    if (source[key] != null) childEnv[key] = String(source[key]);
  }
  childEnv.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  childEnv.LANG ||= "C.UTF-8";
  childEnv.LC_ALL ||= "C.UTF-8";
  childEnv.NO_COLOR = "1";
  if (homeDir) childEnv.HOME = String(homeDir);
  if (configDir) childEnv.CLAUDE_CONFIG_DIR = String(configDir);
  if (tmpDir) childEnv.CLAUDE_CODE_TMPDIR = String(tmpDir);
  return childEnv;
}

/**
 * Execute the minimal no-tool Claude probe. The supplied env should already
 * be allowlisted by buildPreflightEnv; the function still never serializes it
 * into an outcome or log line.
 */
export function runProbe({ binary, model, timeoutMs = DEFAULT_TIMEOUT_MS, terminateGraceMs = DEFAULT_PREFLIGHT_TERMINATE_GRACE_MS, env, apiKey, spawnImpl = nodeSpawn } = {}) {
  const childEnv = env && typeof env === "object"
    ? { ...env }
    : buildPreflightEnv({ sourceEnv: process.env });
  const secret = String(apiKey ?? childEnv.ANTHROPIC_API_KEY ?? "");
  const args = [
    "--bare", "--restricted", "--tools", "", "--strict-mcp-config",
    "--permission-mode", "dontAsk", "--no-session-persistence",
    "--output-format", "json", "--model", String(model || ""), "-p",
    'Return exactly this JSON and no other text: {"ok":true}',
  ];

  return new Promise((resolveResult) => {
    let child;
    try {
      const detached = spawnImpl === nodeSpawn && process.platform !== "win32";
      child = spawnImpl(String(binary || ""), args, {
        shell: false,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (error) {
      resolveResult({ ok: false, failureClass: "startup_error", error: safeError(error, secret) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let escalationTimer = null;
    let terminationKind = null;
    let terminationFailure = null;
    let exitCode = null;
    let signalName = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      resolveResult(value);
    };
    const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const grace = Math.max(10, Math.min(Number(terminateGraceMs) || DEFAULT_PREFLIGHT_TERMINATE_GRACE_MS, 10_000));
    const killChild = (signal) => {
      if (spawnImpl === nodeSpawn && process.platform !== "win32" && Number.isInteger(child?.pid) && child.pid > 1) {
        try { process.kill(-child.pid, signal); return; } catch { /* fall back to the child handle */ }
      }
      try { child.kill?.(signal); } catch { /* process may already have exited */ }
    };
    const terminationResult = () => terminationFailure || {
      ok: false,
      failureClass: "timeout",
      error: "Claude preflight 超时",
      ...(exitCode != null ? { exitCode } : {}),
      ...(signalName ? { signal: signalName } : {}),
    };
    const terminate = (kind, failure = null) => {
      if (settled || terminationKind) return;
      terminationKind = kind;
      terminationFailure = failure;
      // Do not resolve at SIGINT.  A real child may still be running and can
      // retain the temporary config directory; wait for close or complete the
      // bounded SIGINT -> SIGTERM -> SIGKILL sequence first.
      killChild("SIGINT");
      if (settled) return;
      escalationTimer = setTimeout(() => {
        if (settled) return;
        killChild("SIGTERM");
        if (settled) return;
        escalationTimer = setTimeout(() => {
          if (settled) return;
          killChild("SIGKILL");
          if (settled) return;
          escalationTimer = setTimeout(() => {
            if (!settled) finish(terminationResult());
          }, grace);
        }, grace);
      }, grace);
    };

    timer = setTimeout(() => terminate("timeout"), timeout);

    child.stdout?.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
    child.once?.("error", (error) => {
      if (terminationKind) return;
      terminate("error", { ok: false, failureClass: "startup_error", error: safeError(error, secret) });
    });
    child.once?.("close", (code, signal) => {
      exitCode = code == null ? null : Number(code);
      signalName = signal || null;
      if (terminationKind) return finish(terminationResult());
      if (code !== 0) {
        return finish({
          ok: false,
          failureClass: "cli_error",
          exitCode: code,
          signal: signal || null,
          error: safeError(stderr || stdout, secret),
        });
      }
      const parsed = parseJson(stdout);
      finish(parsed && (parsed.ok === true || parsed.structured_output?.ok === true)
        ? { ok: true, model: String(model || ""), exitCode: code }
        : { ok: false, failureClass: "protocol_error", exitCode: code, error: "Claude preflight 未返回预期 JSON" });
    });
  });
}

async function preparePreflightDirectory(tempRoot) {
  const root = String(tempRoot || DEFAULT_PREFLIGHT_TEMP_ROOT).trim() || DEFAULT_PREFLIGHT_TEMP_ROOT;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(root, "run-"));
  try {
    await chmod(path, 0o700).catch(() => {});
    const configDir = join(path, "config");
    const tmpDir = join(path, "tmp");
    const homeDir = join(path, "home");
    await Promise.all([configDir, tmpDir, homeDir].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700).catch(() => {});
    }));
    return { path, configDir, tmpDir, homeDir };
  } catch (error) {
    await cleanupPreflightDirectory(path);
    throw error;
  }
}

async function cleanupPreflightDirectory(path) {
  if (!path) return;
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  } catch {
    // Never turn cleanup diagnostics into a secret-bearing error. The parent
    // process may still have a child exiting; rm is best effort here.
  }
}

function redactReadiness(value, secret = "") {
  if (!value || typeof value !== "object") return null;
  return {
    ok: Boolean(value.ok),
    enabled: Boolean(value.enabled),
    mode: String(value.mode || "off"),
    binary: value.binary ? {
      path: String(value.binary.path || ""),
      exists: Boolean(value.binary.exists),
      executable: Boolean(value.binary.executable),
      version: value.binary.version == null ? null : String(value.binary.version),
      minVersion: value.binary.minVersion == null ? null : String(value.binary.minVersion),
    } : null,
    temp: value.temp ? {
      path: String(value.temp.path || ""),
      writable: Boolean(value.temp.writable),
    } : null,
    modelConfigured: Boolean(value.modelConfigured),
    authConfigured: Boolean(value.authConfigured),
    errors: Array.isArray(value.errors) ? value.errors.map((item) => safeError(item, secret)).slice(0, 20) : [],
  };
}

function boundedAppend(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(0, MAX_CAPTURE_BYTES) : next;
}

function parseJson(value) {
  try { return JSON.parse(String(value).trim()); } catch { return null; }
}

function safeError(error, secret = "") {
  let message = String(error?.message || error || "未知错误");
  const normalizedSecret = String(secret || "");
  if (normalizedSecret) message = message.split(normalizedSecret).join("[REDACTED]");
  return message
    .replace(/((?:password|token|api[_-]?key|authorization))\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runClaudeQueryPreflight({ localOnly: process.argv.includes("--local-only"), checkEnabled: process.argv.includes("--check-enabled") });
  const serialized = JSON.stringify(result, null, 2);
  if (!result.ok && result.readiness) console.error(serialized);
  else console.log(serialized);
  if (!result.ok) process.exitCode = 1;
}

function normalizeMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return ["off", "prefer", "required"].includes(mode) ? mode : "off";
}
