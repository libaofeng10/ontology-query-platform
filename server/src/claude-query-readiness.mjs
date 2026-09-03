import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// --bare/--restricted behavior used by the bridge was introduced before this
// version.  Keep the floor explicit so a downgraded container fails closed.
export const CLAUDE_QUERY_MIN_VERSION = "2.1.248";

/**
 * Perform a local, non-billing readiness check for the Claude query bridge.
 *
 * This intentionally does not call Anthropic.  It checks only deployment-owned
 * prerequisites (mode, executable, CLI version, model/key presence and a
 * writable temporary directory).  The API key is represented by a boolean and
 * is never returned.
 */
export function inspectClaudeQueryReadiness({ config = {}, env = process.env, versionProbe = probeVersion } = {}) {
  const settings = config.claudeQuery || {};
  const mode = normalizeMode(settings.mode);
  if (mode === "off") return {
    ok: true,
    enabled: false,
    mode,
    binary: null,
    temp: null,
    modelConfigured: false,
    authConfigured: false,
    errors: [],
  };

  const binaryPath = String(settings.binary || env.CLAUDE_QUERY_BINARY || "").trim();
  const tempPath = String(env.CLAUDE_CODE_TMPDIR || "/tmp").trim() || "/tmp";
  const errors = [];
  const binary = { path: binaryPath, exists: Boolean(binaryPath && existsSync(binaryPath)), executable: false, version: null, minVersion: CLAUDE_QUERY_MIN_VERSION };
  if (!binary.exists) errors.push("claude CLI 不存在");
  else {
    try { accessSync(binaryPath, constants.X_OK); binary.executable = true; }
    catch { errors.push("claude CLI 不可执行"); }
    if (binary.executable) {
      try {
        binary.version = String(versionProbe(binaryPath) || "").trim() || null;
        if (!isVersionAtLeast(binary.version, CLAUDE_QUERY_MIN_VERSION)) errors.push(`claude CLI 版本过低（需要 >= ${CLAUDE_QUERY_MIN_VERSION}）`);
      } catch { errors.push("无法读取 claude CLI 版本"); }
    }
  }

  const temp = { path: tempPath, writable: false };
  try { accessSync(tempPath, constants.W_OK); temp.writable = true; }
  catch { errors.push("Claude 临时目录不可写"); }

  const modelConfigured = Boolean(String(settings.model || env.CLAUDE_QUERY_MODEL || "").trim());
  if (!modelConfigured) errors.push("未配置 Claude 精确模型 ID");
  const authConfigured = Boolean(String(env.ANTHROPIC_API_KEY || "").trim());
  if (!authConfigured) errors.push("未配置 ANTHROPIC_API_KEY");
  if (!(Number(settings.maxBudgetUsd) > 0)) errors.push("Claude 单请求预算必须大于 0");

  return { ok: errors.length === 0, enabled: true, mode, binary, temp, modelConfigured, authConfigured, errors };
}

function probeVersion(binaryPath) {
  return execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
}

function normalizeMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return ["off", "prefer", "required"].includes(mode) ? mode : "off";
}

function isVersionAtLeast(actual, minimum) {
  const parsedActual = parseVersion(actual);
  const parsedMinimum = parseVersion(minimum);
  if (!parsedActual || !parsedMinimum) return false;
  for (let index = 0; index < 3; index++) {
    if (parsedActual[index] !== parsedMinimum[index]) return parsedActual[index] > parsedMinimum[index];
  }
  return true;
}

function parseVersion(value) {
  const match = String(value || "").match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/i);
  return match ? match.slice(1, 4).map(Number) : null;
}
