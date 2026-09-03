import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    try { process.loadEnvFile(file); } catch { /* Environment variables may already be injected. */ }
  }
}

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: numberFromEnv("API_PORT", 8787),
  host: process.env.API_HOST || "127.0.0.1",
  writeToken: process.env.API_WRITE_TOKEN || "ontoquery-local-write-token",
  apiIdentities: jsonFromEnv("API_IDENTITIES_JSON",[]),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(",").map((item)=>item.trim()).filter(Boolean),
  dbPath: resolve(process.env.PLATFORM_DB_PATH || ".data/platform.sqlite"),
  wikiDir: resolve(process.env.ONTOLOGY_WIKI_DIR || ".ontology-wiki/wiki"),
  appSecret: process.env.APP_SECRET || "ontology-query-local-development-secret",
  queryTimeoutMs: numberFromEnv("QUERY_TIMEOUT_MS", 30_000),
  queryLlmTimeoutMs: numberFromEnv("QUERY_LLM_TIMEOUT_MS", 90_000),
  queryMaxRows: numberFromEnv("QUERY_MAX_ROWS", 500),
  explainMaxRows: numberFromEnv("EXPLAIN_MAX_ROWS", 1_000_000),
  semanticQueryPlanMode: enumFromEnv("SEMANTIC_QUERY_PLAN_MODE", ["off","prefer","required"], "off"),
  queryAgentMode: enumFromEnv("QUERY_AGENT_MODE", ["off","prefer","required"], "off"),
  queryAgentTrafficPercent: integerRangeFromEnv("QUERY_AGENT_TRAFFIC_PERCENT",0,100,100),
  queryAgentMaxIterations: numberFromEnv("QUERY_AGENT_MAX_ITERATIONS", 8),
  queryAgentMaxSqlCalls: numberFromEnv("QUERY_AGENT_MAX_SQL_CALLS", 5),
  queryAgentMaxScannedRows: numberFromEnv("QUERY_AGENT_MAX_SCANNED_ROWS", 5_000_000),
  queryAgentPendingTtlMs: numberFromEnv("QUERY_AGENT_PENDING_TTL_MS", 600_000),
  // Claude Code query bridge is disabled by default.  The API key is deliberately
  // not copied into this runtime config object: the bridge reads ANTHROPIC_API_KEY
  // from its explicitly constructed child-process environment.
  claudeQuery: {
    mode: enumFromEnv("CLAUDE_QUERY_MODE", ["off", "prefer", "required"], "off"),
    trafficPercent: integerRangeFromEnv("CLAUDE_QUERY_TRAFFIC_PERCENT", 0, 100, 0),
    binary: textFromEnv("CLAUDE_QUERY_BINARY", "/app/node_modules/.bin/claude"),
    model: textFromEnv("CLAUDE_QUERY_MODEL", ""),
    promptVersion: textFromEnv("CLAUDE_QUERY_PROMPT_VERSION", "claude-query-v1"),
    timeoutMs: integerRangeFromEnv("CLAUDE_QUERY_TIMEOUT_MS", 1_000, 600_000, 120_000),
    maxTurns: integerRangeFromEnv("CLAUDE_QUERY_MAX_TURNS", 1, 100, 12),
    maxBudgetUsd: decimalRangeFromEnv("CLAUDE_QUERY_MAX_BUDGET_USD", 0, 100, 1),
    maxConcurrency: integerRangeFromEnv("CLAUDE_QUERY_MAX_CONCURRENCY", 1, 32, 2),
    queueTimeoutMs: integerRangeFromEnv("CLAUDE_QUERY_QUEUE_TIMEOUT_MS", 0, 120_000, 5_000),
    maxStdioBytes: integerRangeFromEnv("CLAUDE_QUERY_MAX_STDIO_BYTES", 64 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024),
  },
  metricProposalEnabled: String(process.env.METRIC_PROPOSAL_ENABLED??"false").toLowerCase()==="true",
  rateLimits: {
    queryPerMinute:numberFromEnv("RATE_LIMIT_QUERY_PER_MINUTE",30),
    writePerMinute:numberFromEnv("RATE_LIMIT_WRITE_PER_MINUTE",120),
    readPerMinute:numberFromEnv("RATE_LIMIT_READ_PER_MINUTE",300),
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL || "",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
  },
  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL || "",
    apiKey: process.env.EMBEDDING_API_KEY || "",
    model: process.env.EMBEDDING_MODEL || "",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS) > 0 ? Number(process.env.EMBEDDING_DIMENSIONS) : null,
  },
  retrieval: {
    vectorEnabled: String(process.env.RETRIEVAL_VECTOR_ENABLED ?? "true").toLowerCase() !== "false",
    topK: numberFromEnv("RETRIEVAL_TOP_K", 8),
    vectorWeight: numberRatioFromEnv("RETRIEVAL_VECTOR_WEIGHT", 0.4),
    minSimilarity: numberRatioFromEnv("RETRIEVAL_MIN_SIMILARITY", 0.35),
    semanticThreshold: numberRatioFromEnv("RETRIEVAL_SEMANTIC_THRESHOLD", 0.55),
    // Business-domain concept aliases, e.g. [{"match":"线索|商机线索","terms":["clue"]}].
    conceptAliases: jsonFromEnv("RETRIEVAL_CONCEPT_ALIASES_JSON", []),
  },
  relationModel: {
    maxCandidates:numberFromEnv("RELATION_MODEL_MAX_CANDIDATES",600),
    batchSize:numberFromEnv("RELATION_MODEL_BATCH_SIZE",8),
    timeoutMs:numberFromEnv("RELATION_MODEL_TIMEOUT_MS",180_000),
    minConfidence:numberRatioFromEnv("RELATION_MODEL_MIN_CONFIDENCE",0.55),
    sampleLimit:numberFromEnv("RELATION_VALUE_SAMPLE_LIMIT",500),
    overlapConcurrency:integerRangeFromEnv("RELATION_OVERLAP_CONCURRENCY",1,16,4),
    overlapTimeoutMs:integerRangeFromEnv("RELATION_OVERLAP_TIMEOUT_MS",100,120_000,10_000),
  },
  discovery: {
    enumMaxDistinctRatio:numberRatioFromEnv("ENUM_MAX_DISTINCT_RATIO",0.05),
    // A label column (…name) is a business dictionary only when its table is small enough.
    // 20 is the conservative default; a source whose dimension tables run longer (channel
    // name lists, product catalogs) raises this so their label columns register. The probe
    // and the enum catalog migration both read the same default, so they cannot drift.
    labelDictionaryMaxRows:integerRangeFromEnv("ENUM_LABEL_DICTIONARY_MAX_ROWS",1,500,20),
  },
  profiling: {
    enabled:String(process.env.COLUMN_PROFILING_ENABLED??"false").toLowerCase()==="true",
    sampleLimit:integerRangeFromEnv("COLUMN_PROFILING_SAMPLE_LIMIT",1,1000,1000),
    maxTablesPerRefresh:integerRangeFromEnv("COLUMN_PROFILING_MAX_TABLES",1,1000,20),
    timeoutMs:integerRangeFromEnv("COLUMN_PROFILING_TIMEOUT_MS",100,120_000,10_000),
  },
  ontologyAi: {
    mode:enumFromEnv("ONTOLOGY_AI_MODELING_MODE",["off","review","auto_draft"],"off"),
    autoConfirmScore:integerRangeFromEnv("ONTOLOGY_AI_AUTO_CONFIRM_SCORE",0,100,80),
    maxTables:integerRangeFromEnv("ONTOLOGY_AI_MAX_TABLES",1,20,20),
    maxFields:integerRangeFromEnv("ONTOLOGY_AI_MAX_FIELDS",1,600,600),
    timeoutMs:integerRangeFromEnv("ONTOLOGY_AI_LLM_TIMEOUT_MS",1_000,600_000,300_000),
    criticEnabled:String(process.env.ONTOLOGY_AI_CRITIC_ENABLED??"false").toLowerCase()==="true",
    calibrationMinSamples:integerRangeFromEnv("ONTOLOGY_AI_CALIBRATION_MIN_SAMPLES",1,10_000,40),
    calibrationMinPrecision:numberRatioFromEnv("ONTOLOGY_AI_CALIBRATION_MIN_PRECISION",0.95),
    maxManualObjectRate:numberRatioFromEnv("ONTOLOGY_AI_MAX_MANUAL_OBJECT_RATE",0.2),
    maxFailureRate:numberRatioFromEnv("ONTOLOGY_AI_MAX_FAILURE_RATE",0.05),
    maxP95LatencyMs:integerRangeFromEnv("ONTOLOGY_AI_MAX_P95_LATENCY_MS",1_000,600_000,90_000),
    maxAverageTokens:integerRangeFromEnv("ONTOLOGY_AI_MAX_AVERAGE_TOKENS",1,10_000_000,50_000),
    auditDir:resolve(process.env.ONTOLOGY_AI_AUDIT_DIR||".data/ontology-generation"),
  },
};

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function textFromEnv(name, fallback) {
  const value = process.env[name];
  return value == null || String(value).trim() === "" ? fallback : String(value).trim();
}

function decimalRangeFromEnv(name, min, max, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function numberRatioFromEnv(name,fallback) { const value=Number(process.env[name]);return Number.isFinite(value)&&value>=0&&value<=1?value:fallback; }

function integerRangeFromEnv(name,min,max,fallback) { const value=Number(process.env[name]);return Number.isInteger(value)&&value>=min&&value<=max?value:fallback; }

function jsonFromEnv(name,fallback) { try{return process.env[name]?JSON.parse(process.env[name]):fallback;}catch{throw new Error(`${name} 必须是合法 JSON`);} }

function enumFromEnv(name,allowed,fallback) { const value=String(process.env[name]||fallback).trim().toLowerCase();if(!allowed.includes(value))throw new Error(`${name} 必须是 ${allowed.join("、")} 之一`);return value; }
