import { encryptCredential, decryptCredential } from "./crypto.mjs";
import { QUERY_PROMPT_DEFAULTS, QUERY_PROMPT_SPECS, validateQueryPrompt } from "./query-prompts.mjs";

function promptSpec(promptKey) {
  return { validate: (value, settingKey) => validateQueryPrompt(promptKey, value, settingKey) };
}

const GROUPS = {
  llm: {
    baseUrl: { envVar: "LLM_BASE_URL", validate: url },
    apiKey: { envVar: "LLM_API_KEY", secret: true },
    model: { envVar: "LLM_MODEL", validate: text },
  },
  embedding: {
    baseUrl: { envVar: "EMBEDDING_BASE_URL", validate: url },
    apiKey: { envVar: "EMBEDDING_API_KEY", secret: true },
    model: { envVar: "EMBEDDING_MODEL", validate: text },
    dimensions: { envVar: "EMBEDDING_DIMENSIONS", validate: nullablePositiveInt },
  },
  retrieval: {
    vectorEnabled: { envVar: "RETRIEVAL_VECTOR_ENABLED", validate: bool },
    topK: { envVar: "RETRIEVAL_TOP_K", validate: intRange(1, 50) },
    vectorWeight: { envVar: "RETRIEVAL_VECTOR_WEIGHT", validate: ratio },
    minSimilarity: { envVar: "RETRIEVAL_MIN_SIMILARITY", validate: ratio },
    semanticThreshold: { envVar: "RETRIEVAL_SEMANTIC_THRESHOLD", validate: ratio },
  },
  profiling: {
    enabled: { envVar: "COLUMN_PROFILING_ENABLED", validate: bool },
    sampleLimit: { envVar: "COLUMN_PROFILING_SAMPLE_LIMIT", validate: intRange(1, 1000) },
    maxTablesPerRefresh: { envVar: "COLUMN_PROFILING_MAX_TABLES", validate: intRange(1, 1000) },
    timeoutMs: { envVar: "COLUMN_PROFILING_TIMEOUT_MS", validate: intRange(100, 120_000) },
  },
  query: {
    semanticQueryPlanMode: { envVar: "SEMANTIC_QUERY_PLAN_MODE", validate: oneOf(["off", "prefer", "required"]) },
    queryAgentMode: { envVar: "QUERY_AGENT_MODE", validate: oneOf(["off", "prefer", "required"]) },
    queryAgentTrafficPercent: { envVar: "QUERY_AGENT_TRAFFIC_PERCENT", validate: intRange(0, 100) },
    queryAgentMaxIterations: { envVar: "QUERY_AGENT_MAX_ITERATIONS", validate: intRange(2, 20) },
    queryAgentMaxSqlCalls: { envVar: "QUERY_AGENT_MAX_SQL_CALLS", validate: intRange(1, 10) },
    queryAgentMaxScannedRows: { envVar: "QUERY_AGENT_MAX_SCANNED_ROWS", validate: intRange(1, 1_000_000_000) },
    queryAgentPendingTtlMs: { envVar: "QUERY_AGENT_PENDING_TTL_MS", validate: intRange(1_000, 3_600_000) },
    queryMaxRows: { envVar: "QUERY_MAX_ROWS", validate: intRange(1, 100_000) },
    explainMaxRows: { envVar: "EXPLAIN_MAX_ROWS", validate: intRange(1, 1_000_000_000) },
    queryTimeoutMs: { envVar: "QUERY_TIMEOUT_MS", validate: intRange(1_000, 600_000) },
    queryLlmTimeoutMs: { envVar: "QUERY_LLM_TIMEOUT_MS", validate: intRange(1_000, 600_000) },
  },
  ontologyAi: {
    mode: { envVar: "ONTOLOGY_AI_MODELING_MODE", validate: oneOf(["off", "review", "auto_draft"]) },
    autoConfirmScore: { envVar: "ONTOLOGY_AI_AUTO_CONFIRM_SCORE", validate: intRange(0, 100) },
    maxTables: { envVar: "ONTOLOGY_AI_MAX_TABLES", validate: intRange(1, 20) },
    maxFields: { envVar: "ONTOLOGY_AI_MAX_FIELDS", validate: intRange(1, 600) },
    timeoutMs: { envVar: "ONTOLOGY_AI_LLM_TIMEOUT_MS", validate: intRange(1_000, 600_000) },
    criticEnabled: { envVar: "ONTOLOGY_AI_CRITIC_ENABLED", validate: bool },
    calibrationMinSamples: { envVar: "ONTOLOGY_AI_CALIBRATION_MIN_SAMPLES", validate: intRange(1, 10_000) },
    calibrationMinPrecision: { envVar: "ONTOLOGY_AI_CALIBRATION_MIN_PRECISION", validate: ratio },
    maxManualObjectRate: { envVar: "ONTOLOGY_AI_MAX_MANUAL_OBJECT_RATE", validate: ratio },
    maxFailureRate: { envVar: "ONTOLOGY_AI_MAX_FAILURE_RATE", validate: ratio },
    maxP95LatencyMs: { envVar: "ONTOLOGY_AI_MAX_P95_LATENCY_MS", validate: intRange(1_000, 600_000) },
    maxAverageTokens: { envVar: "ONTOLOGY_AI_MAX_AVERAGE_TOKENS", validate: intRange(1, 10_000_000) },
  },
  prompts: Object.fromEntries(Object.keys(QUERY_PROMPT_SPECS).map((key) => [key, promptSpec(key)])),
};

export function createSettingsService({ store, baseConfig, appSecret, lockedKeys = [] }) {
  const locked = new Set(lockedKeys);
  const state = { llm: {}, embedding: {}, retrieval: {}, profiling: {}, query: {}, ontologyAi: {}, prompts: {} };
  const sources = {};

  function defaultsFor(group, key) {
    if (group === "query") return baseConfig[key];
    if (group === "prompts") return QUERY_PROMPT_DEFAULTS[key];
    return baseConfig[group]?.[key] ?? (key === "dimensions" ? null : "");
  }

  function fallbackSource(spec) {
    return spec.envVar && process.env[spec.envVar] != null ? "env" : "default";
  }

  function rebuild() {
    for (const [group, keys] of Object.entries(GROUPS)) {
      for (const key of Object.keys(keys)) {
        const spec = keys[key];
        const settingKey = `${group}.${key}`;
        const fallback = defaultsFor(group, key);
        if (locked.has(settingKey)) { state[group][key] = fallback; sources[settingKey] = "override"; continue; }
        const row = store.getSetting(settingKey);
        if (!row) { state[group][key] = fallback; sources[settingKey] = fallbackSource(spec); continue; }
        try {
          const raw = JSON.parse(row.valueJson);
          state[group][key] = row.encrypted ? decryptCredential(raw, appSecret) : raw;
          sources[settingKey] = "db";
        } catch { state[group][key] = fallback; sources[settingKey] = fallbackSource(spec); }
      }
    }
  }
  rebuild();

  function update(input, updatedBy = null) {
    if (!input || typeof input !== "object") throw httpError(400, "设置必须是 JSON 对象");
    const writes = [];
    for (const [group, keys] of Object.entries(GROUPS)) {
      const section = input[group];
      if (section == null) continue;
      if (typeof section !== "object") throw httpError(400, `${group} 必须是对象`);
      for (const [key, value] of Object.entries(section)) {
        const spec = keys[key];
        if (!spec) throw httpError(400, `未知设置项 ${group}.${key}`);
        const settingKey = `${group}.${key}`;
        if (locked.has(settingKey)) throw httpError(400, `${settingKey} 由启动参数固定，不可在线修改`);
        if (value === null) { writes.push(() => store.deleteSetting(settingKey)); continue; }
        if (spec.secret) {
          if (value === "" || value === undefined) continue;
          if (typeof value !== "string") throw httpError(400, `${settingKey} 必须是字符串`);
          writes.push(() => store.upsertSetting({ key: settingKey, valueJson: JSON.stringify(encryptCredential(value, appSecret)), encrypted: 1, updatedBy }));
          continue;
        }
        if (value === undefined) continue;
        const normalized = spec.validate(value, settingKey);
        writes.push(() => store.upsertSetting({ key: settingKey, valueJson: JSON.stringify(normalized), encrypted: 0, updatedBy }));
      }
    }
    for (const write of writes) write();
    rebuild();
    return publicView();
  }

  function publicView() {
    const view = {};
    for (const [group, keys] of Object.entries(GROUPS)) {
      view[group] = {};
      for (const key of Object.keys(keys)) {
        const value = state[group][key];
        view[group][key] = keys[key].secret ? maskSecret(value) : value;
      }
    }
    const promptMeta = Object.fromEntries(Object.entries(QUERY_PROMPT_SPECS).map(([key, spec]) => [key, {
      label: spec.label,
      description: spec.description,
      variables: [...spec.variables],
    }]));
    return {
      ...view,
      promptMeta,
      promptDefaults: { ...QUERY_PROMPT_DEFAULTS },
      sources: { ...sources },
      locked: [...locked],
    };
  }

  const llmView = viewOf(state.llm, ["baseUrl", "apiKey", "model"]);
  const embeddingView = viewOf(state.embedding, ["baseUrl", "apiKey", "model", "dimensions"]);
  const retrievalView = viewOf(state.retrieval, ["vectorEnabled", "topK", "vectorWeight", "minSimilarity", "semanticThreshold"]);
  const profilingView = viewOf(state.profiling, ["enabled", "sampleLimit", "maxTablesPerRefresh", "timeoutMs"]);
  const ontologyAiView = viewOf(state.ontologyAi, ["mode", "autoConfirmScore", "maxTables", "maxFields", "timeoutMs", "criticEnabled", "calibrationMinSamples", "calibrationMinPrecision", "maxManualObjectRate", "maxFailureRate", "maxP95LatencyMs", "maxAverageTokens"]);
  const promptsView = viewOf(state.prompts, Object.keys(QUERY_PROMPT_SPECS));
  const config = {
    ...baseConfig,
    llm: llmView,
    embedding: embeddingView,
    retrieval: retrievalView,
    profiling: profilingView,
    ontologyAi: ontologyAiView,
    prompts: promptsView,
    get semanticQueryPlanMode() { return state.query.semanticQueryPlanMode; },
    get queryAgentMode() { return state.query.queryAgentMode; },
    get queryAgentTrafficPercent() { return state.query.queryAgentTrafficPercent; },
    get queryAgentMaxIterations() { return state.query.queryAgentMaxIterations; },
    get queryAgentMaxSqlCalls() { return state.query.queryAgentMaxSqlCalls; },
    get queryAgentMaxScannedRows() { return state.query.queryAgentMaxScannedRows; },
    get queryAgentPendingTtlMs() { return state.query.queryAgentPendingTtlMs; },
    get queryMaxRows() { return state.query.queryMaxRows; },
    get explainMaxRows() { return state.query.explainMaxRows; },
    get queryTimeoutMs() { return state.query.queryTimeoutMs; },
    get queryLlmTimeoutMs() { return state.query.queryLlmTimeoutMs; },
  };

  return { config, update, publicView, snapshot: () => structuredClone(state), reload: rebuild };
}

function viewOf(target, keys) {
  const view = {};
  for (const key of keys) Object.defineProperty(view, key, { enumerable: true, get: () => target[key] });
  return view;
}

function maskSecret(value) {
  if (!value) return { set: false };
  const tail = String(value).slice(-4);
  return { set: true, masked: `****${tail}` };
}

function text(value, key) { if (typeof value !== "string") throw httpError(400, `${key} 必须是字符串`); return value.trim(); }
function url(value, key) { const trimmed = text(value, key); if (trimmed && !/^https?:\/\//i.test(trimmed)) throw httpError(400, `${key} 必须是 http(s) 地址`); return trimmed; }
function bool(value, key) { if (typeof value !== "boolean") throw httpError(400, `${key} 必须是布尔值`); return value; }
function ratio(value, key) { const num = Number(value); if (!Number.isFinite(num) || num < 0 || num > 1) throw httpError(400, `${key} 必须在 0 和 1 之间`); return num; }
function intRange(min, max) { return (value, key) => { const num = Number(value); if (!Number.isInteger(num) || num < min || num > max) throw httpError(400, `${key} 必须是 ${min} 到 ${max} 的整数`); return num; }; }
function nullablePositiveInt(value, key) { if (value === null || value === "") return null; const num = Number(value); if (!Number.isInteger(num) || num <= 0) throw httpError(400, `${key} 必须是正整数或留空`); return num; }
function oneOf(allowed) { return (value, key) => { const normalized = String(value).trim().toLowerCase(); if (!allowed.includes(normalized)) throw httpError(400, `${key} 必须是 ${allowed.join("、")} 之一`); return normalized; }; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
