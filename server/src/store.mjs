import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ds_source (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'mysql',
    host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3306, db_name TEXT NOT NULL,
    user_name TEXT NOT NULL, cred_enc TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0,
    last_test_at TEXT, last_test_ok INTEGER, last_test_error TEXT, last_discovery_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_table_selection (
    source_id INTEGER NOT NULL, table_name TEXT NOT NULL, included INTEGER NOT NULL DEFAULT 1,
    decided_by TEXT, decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(source_id, table_name)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_table (
    source_id INTEGER NOT NULL, table_name TEXT NOT NULL, row_estimate INTEGER DEFAULT 0,
    grade TEXT, grade_override TEXT, active INTEGER DEFAULT 1, last_probe_at TEXT, comment TEXT,
    days_since_write INTEGER, inbound_relations INTEGER DEFAULT 0, present INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(source_id, table_name)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_column (
    source_id INTEGER NOT NULL, table_name TEXT NOT NULL, column_name TEXT NOT NULL,
    data_type TEXT NOT NULL, nullable INTEGER, null_rate REAL, cardinality INTEGER,
    is_sensitive INTEGER DEFAULT 0, comment TEXT, is_primary INTEGER DEFAULT 0,
    is_unique INTEGER DEFAULT 0, is_indexed INTEGER DEFAULT 0, present INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(source_id, table_name, column_name)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_enum (
    source_id INTEGER NOT NULL, table_name TEXT NOT NULL, column_name TEXT NOT NULL,
    value TEXT NOT NULL, count INTEGER, ratio REAL, last_written_at TEXT, meaning TEXT,
    meaning_source TEXT, PRIMARY KEY(source_id, table_name, column_name, value)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_column_profile (
    source_id INTEGER NOT NULL, table_name TEXT NOT NULL, column_name TEXT NOT NULL,
    profile_json TEXT NOT NULL DEFAULT '{}', sampled_at TEXT NOT NULL,
    sample_size INTEGER NOT NULL DEFAULT 0, profile_version TEXT NOT NULL,
    PRIMARY KEY(source_id, table_name, column_name)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, from_table TEXT NOT NULL,
    from_col TEXT NOT NULL, to_table TEXT NOT NULL, to_col TEXT NOT NULL, cardinality TEXT,
    confidence REAL, overlap_ratio REAL, status TEXT NOT NULL DEFAULT 'review', present INTEGER NOT NULL DEFAULT 1,
    inference_source TEXT, model_decision TEXT, model_confidence REAL, model_reason TEXT,
    model_name TEXT, structural_score REAL, structural_reason TEXT, evaluated_at TEXT,
    UNIQUE(source_id, from_table, from_col, to_table, to_col)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_question (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, kind TEXT NOT NULL,
    scope TEXT NOT NULL, table_name TEXT, column_name TEXT, question TEXT NOT NULL,
    evidence TEXT NOT NULL, options TEXT NOT NULL, answer TEXT, answered_at TEXT,
    outruled_by TEXT, status TEXT NOT NULL DEFAULT 'pending', relation_id INTEGER, enum_value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ds_relation_analysis (
    source_id INTEGER PRIMARY KEY, model_status TEXT NOT NULL, model_name TEXT,
    candidate_count INTEGER NOT NULL DEFAULT 0, judged_count INTEGER NOT NULL DEFAULT 0,
    suggested_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
    error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_relation_doc (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, file_name TEXT NOT NULL,
    file_path TEXT NOT NULL, checksum TEXT NOT NULL, status TEXT NOT NULL,
    assertions_json TEXT NOT NULL DEFAULT '[]', assertion_count INTEGER NOT NULL DEFAULT 0,
    accepted_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
    error TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, checksum)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, name TEXT NOT NULL,
    content TEXT NOT NULL, applies_to TEXT, verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, source_id INTEGER, question TEXT NOT NULL,
    retrieved_pages TEXT, prompt_hash TEXT, sql_text TEXT, verdict TEXT NOT NULL,
    fail_reason TEXT, duration_ms INTEGER, row_count INTEGER, planning_mode TEXT,
    query_plan_json TEXT, ontology_schema_version INTEGER, semantic_path_json TEXT,
    semantic_fallback_reason TEXT, planning_attempts INTEGER, iterations INTEGER,
    clarification_count INTEGER NOT NULL DEFAULT 0, tool_trace_json TEXT,
    intent_version TEXT, intent_json TEXT, prompt_version TEXT, retrieval_trace_json TEXT, failure_class TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_eval (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL DEFAULT 1, set_name TEXT NOT NULL, question TEXT NOT NULL,
    gold_sql TEXT, category TEXT, held_out INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_eval_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT, eval_id INTEGER NOT NULL, run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    generated_sql TEXT, passed INTEGER NOT NULL, fail_reason TEXT,
    requested_mode TEXT, planning_mode TEXT, comparison_role TEXT,
    ontology_schema_version INTEGER, semantic_path_json TEXT, repair_hints_json TEXT,
    table_count INTEGER, planning_attempts INTEGER, agent_metrics_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ds_eval_gate (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, set_name TEXT NOT NULL, total INTEGER NOT NULL,
    ontology_schema_version INTEGER, ontology_schema_published_at TEXT, evaluation_checksum TEXT,
    baseline_json TEXT NOT NULL, candidate_json TEXT NOT NULL, passed INTEGER NOT NULL,
    decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_knowledge_page (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, page_type TEXT NOT NULL,
    slug TEXT NOT NULL, title TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
    tables_json TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL DEFAULT '',
    sql_content TEXT, anti_examples TEXT, verified INTEGER NOT NULL DEFAULT 0,
    owner TEXT, verified_at TEXT, file_path TEXT, checksum TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, page_type, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_query_session (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, user_name TEXT NOT NULL,
    title TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_query_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content_json TEXT NOT NULL, audit_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES ds_query_session(id) ON DELETE CASCADE,
    FOREIGN KEY(audit_id) REFERENCES ds_audit(id)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_task (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 100, current_step TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_schema_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, version INTEGER NOT NULL,
    checksum TEXT NOT NULL, schema_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_schema_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','deprecated')),
    schema_name TEXT NOT NULL, schema_json TEXT NOT NULL, checksum TEXT NOT NULL,
    validation_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_by TEXT, published_at TEXT,
    UNIQUE(source_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_publication (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, schema_version_id INTEGER NOT NULL,
    previous_schema_version_id INTEGER, action TEXT NOT NULL CHECK(action IN ('publish','rollback')),
    user_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_generation_run (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, task_id TEXT,
    mode TEXT NOT NULL DEFAULT 'selected_tables' CHECK(mode IN ('selected_tables','business_domain')),
    scope_json TEXT NOT NULL DEFAULT '{}', catalog_checksum TEXT NOT NULL,
    base_schema_version_id INTEGER, model_name TEXT, prompt_version TEXT NOT NULL,
    scoring_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
    progress INTEGER NOT NULL DEFAULT 0, summary_json TEXT NOT NULL DEFAULT '{}',
    token_usage_json TEXT NOT NULL DEFAULT '{}', error TEXT, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_candidate (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id INTEGER NOT NULL,
    candidate_type TEXT NOT NULL CHECK(candidate_type IN ('object','link')), stable_key TEXT NOT NULL,
    payload_json TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', model_confidence REAL,
    score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
    score_breakdown_json TEXT NOT NULL DEFAULT '{}', validation_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'generated'
      CHECK(status IN ('generated','blocked','auto_confirmed','review_required','confirmed','rejected','superseded','applied')),
    forced_review_reasons_json TEXT NOT NULL DEFAULT '[]', decision_note TEXT,
    reviewed_by TEXT, reviewed_at TEXT, applied_schema_version_id INTEGER, superseded_by_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id,candidate_type,stable_key),
    FOREIGN KEY(run_id) REFERENCES ds_ontology_generation_run(id),
    FOREIGN KEY(superseded_by_id) REFERENCES ds_ontology_candidate(id)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_candidate_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL,
    source_id INTEGER NOT NULL, event_type TEXT NOT NULL, actor TEXT,
    from_status TEXT, to_status TEXT, note TEXT, before_json TEXT, after_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(candidate_id) REFERENCES ds_ontology_candidate(id),
    FOREIGN KEY(run_id) REFERENCES ds_ontology_generation_run(id)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_calibration_gate (
    id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, run_ids_json TEXT NOT NULL DEFAULT '[]',
    draft_schema_version_id INTEGER, eval_gate_id TEXT, manual_object_count INTEGER NOT NULL DEFAULT 0,
    final_object_count INTEGER NOT NULL DEFAULT 0, metrics_json TEXT NOT NULL DEFAULT '{}',
    passed INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL CHECK(decision IN ('enable_auto_draft','keep_review')),
    reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_by TEXT, activated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ds_ontology_domain_plan (
    source_id INTEGER PRIMARY KEY, plan_json TEXT NOT NULL, catalog_checksum TEXT NOT NULL,
    created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_setting (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_source_ontology_setting (
    source_id INTEGER PRIMARY KEY, auto_confirm_score INTEGER NOT NULL CHECK(auto_confirm_score BETWEEN 0 AND 100),
    evidence_run_ids_json TEXT NOT NULL DEFAULT '[]', updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_source_ontology_setting_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, setting_key TEXT NOT NULL,
    old_value_json TEXT, new_value_json TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
    actor TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ds_term_anchor (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vocabulary TEXT NOT NULL, canonical_id TEXT NOT NULL,
    pref_label_zh TEXT, pref_label_en TEXT, alt_labels TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'object' CHECK(kind IN ('object','property','metric')),
    broader_canonical_id TEXT, note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(vocabulary,canonical_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ds_embedding (
    source_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('page','table')),
    ref_key TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
    text_hash TEXT NOT NULL, vector_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(source_id, kind, ref_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ds_embedding_source_model ON ds_embedding(source_id, model)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_question_source_status ON ds_question(source_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_audit_source_created ON ds_audit(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_relation_source_status ON ds_relation(source_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_relation_doc_source_created ON ds_relation_doc(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_column_profile_source ON ds_column_profile(source_id, table_name)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_knowledge_source_type ON ds_knowledge_page(source_id, page_type, verified)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_task_source_created ON ds_task(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_task_status ON ds_task(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_snapshot_source_version ON ds_schema_snapshot(source_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_schema_source_version ON ds_ontology_schema_version(source_id, version DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_ontology_schema_one_published ON ds_ontology_schema_version(source_id) WHERE status='published'`,
  `CREATE INDEX IF NOT EXISTS idx_ds_eval_gate_source_created ON ds_eval_gate(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_publication_source_created ON ds_ontology_publication(source_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_ontology_generation_one_active ON ds_ontology_generation_run(source_id) WHERE status IN ('queued','running')`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_generation_source_created ON ds_ontology_generation_run(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_candidate_source_status_score ON ds_ontology_candidate(source_id, status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_candidate_run_type ON ds_ontology_candidate(run_id, candidate_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_candidate_event_candidate ON ds_ontology_candidate_event(candidate_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_ontology_calibration_source_created ON ds_ontology_calibration_gate(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_source_ontology_setting_audit ON ds_source_ontology_setting_audit(source_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_term_anchor_vocabulary_kind ON ds_term_anchor(vocabulary, kind, canonical_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ds_query_message_session ON ds_query_message(session_id, id)`,
];

const MIGRATIONS = [
  `ALTER TABLE ds_source ADD COLUMN last_test_at TEXT`,
  `ALTER TABLE ds_source ADD COLUMN last_test_ok INTEGER`,
  `ALTER TABLE ds_source ADD COLUMN last_test_error TEXT`,
  `ALTER TABLE ds_source ADD COLUMN last_discovery_at TEXT`,
  `ALTER TABLE ds_eval ADD COLUMN source_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ds_table ADD COLUMN present INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ds_column ADD COLUMN present INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ds_relation ADD COLUMN present INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ds_eval ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ds_eval ADD COLUMN created_at TEXT`,
  `ALTER TABLE ds_eval ADD COLUMN updated_at TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN source_id INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN batch_id TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN expected_json TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN actual_json TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN duration_ms INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN failure_class TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN suggestion TEXT`,
  `ALTER TABLE ds_column ADD COLUMN is_unique INTEGER DEFAULT 0`,
  `ALTER TABLE ds_column ADD COLUMN is_indexed INTEGER DEFAULT 0`,
  `ALTER TABLE ds_relation ADD COLUMN inference_source TEXT`,
  `ALTER TABLE ds_relation ADD COLUMN model_decision TEXT`,
  `ALTER TABLE ds_relation ADD COLUMN model_confidence REAL`,
  `ALTER TABLE ds_relation ADD COLUMN model_reason TEXT`,
  `ALTER TABLE ds_relation ADD COLUMN model_name TEXT`,
  `ALTER TABLE ds_relation ADD COLUMN structural_score REAL`,
  `ALTER TABLE ds_relation ADD COLUMN structural_reason TEXT`,
  `ALTER TABLE ds_relation ADD COLUMN evaluated_at TEXT`,
  `ALTER TABLE ds_knowledge_page ADD COLUMN contract_json TEXT`,
  `ALTER TABLE ds_knowledge_page ADD COLUMN semantic_health TEXT`,
  `ALTER TABLE ds_question ADD COLUMN relation_id INTEGER`,
  `ALTER TABLE ds_question ADD COLUMN enum_value TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN planning_mode TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN query_plan_json TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN ontology_schema_version INTEGER`,
  `ALTER TABLE ds_audit ADD COLUMN semantic_path_json TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN semantic_fallback_reason TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN planning_attempts INTEGER`,
  `ALTER TABLE ds_audit ADD COLUMN iterations INTEGER`,
  `ALTER TABLE ds_audit ADD COLUMN clarification_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ds_audit ADD COLUMN tool_trace_json TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN intent_version TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN intent_json TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN prompt_version TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN retrieval_trace_json TEXT`,
  `ALTER TABLE ds_audit ADD COLUMN failure_class TEXT`,
  `ALTER TABLE ds_query_message ADD COLUMN audit_id INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN requested_mode TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN planning_mode TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN comparison_role TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN ontology_schema_version INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN semantic_path_json TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN table_count INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN planning_attempts INTEGER`,
  `ALTER TABLE ds_eval_run ADD COLUMN repair_hints_json TEXT`,
  `ALTER TABLE ds_eval_run ADD COLUMN agent_metrics_json TEXT`,
  `ALTER TABLE ds_eval_gate ADD COLUMN ontology_schema_version INTEGER`,
  `ALTER TABLE ds_eval_gate ADD COLUMN ontology_schema_published_at TEXT`,
  `ALTER TABLE ds_eval_gate ADD COLUMN evaluation_checksum TEXT`,
];

export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const statement of SCHEMA) db.prepare(statement).run();
  for (const statement of MIGRATIONS) {
    try { db.prepare(statement).run(); } catch (error) { if (!/duplicate column name/i.test(String(error.message))) throw error; }
  }
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ds_relation_source_inference ON ds_relation(source_id, present, inference_source, status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ds_eval_gate_source_schema_set ON ds_eval_gate(source_id, ontology_schema_version, set_name, passed)`).run();
  db.pragma("optimize");

  const answerEnumQuestionTransaction=db.transaction(({id,answer,outruledBy=null})=>{
    const question=db.prepare(`SELECT id,source_id AS sourceId,kind,table_name AS tableName,column_name AS columnName,enum_value AS enumValue,options,status FROM ds_question WHERE id=?`).get(id);
    if(!question)return {ok:false,reason:"not_found"};
    if(question.status!=="pending")return {ok:false,reason:"not_pending"};
    if(question.kind!=="枚举含义")return {ok:false,reason:"invalid_kind"};
    const options=parseQuestionOptions(question.options);
    if(!options.length)return {ok:false,reason:"invalid_options"};
    const normalizedAnswer=typeof answer==="string"?answer.trim():"";
    if(!options.includes(normalizedAnswer))return {ok:false,reason:"answer_not_allowed",options};
    if(!question.tableName||!question.columnName||question.enumValue==null)return {ok:false,reason:"invalid_binding"};
    if(normalizedAnswer!=="补充说明"){
      const existing=db.prepare(`SELECT meaning,meaning_source AS meaningSource FROM ds_enum WHERE source_id=? AND table_name=? AND column_name=? AND value=?`).get(question.sourceId,question.tableName,question.columnName,String(question.enumValue));
      if(existing?.meaning!=null&&existing.meaningSource==="human"&&String(existing.meaning)!==normalizedAnswer)return {ok:false,reason:"meaning_conflict"};
    }
    const claimed=db.prepare(`UPDATE ds_question SET answer=?,answered_at=CURRENT_TIMESTAMP,outruled_by=?,status='answered' WHERE id=? AND status='pending'`).run(normalizedAnswer,outruledBy,id).changes;
    if(claimed!==1)return {ok:false,reason:"not_pending"};
    if(normalizedAnswer!=="补充说明")db.prepare(`INSERT INTO ds_enum(source_id,table_name,column_name,value,count,ratio,meaning,meaning_source) VALUES(?,?,?,?,NULL,NULL,?,'human') ON CONFLICT(source_id,table_name,column_name,value) DO UPDATE SET meaning=excluded.meaning,meaning_source=excluded.meaning_source`).run(question.sourceId,question.tableName,question.columnName,String(question.enumValue),normalizedAnswer);
    return {ok:true,changes:1,wroteMeaning:normalizedAnswer!=="补充说明"};
  });

  return {
    db,
    close: () => db.close(),
    listSources: () => db.prepare(`SELECT id, name, kind, host, port, db_name AS dbName, user_name AS userName, is_demo AS isDemo, last_test_at AS lastTestAt, last_test_ok AS lastTestOk, last_test_error AS lastTestError, last_discovery_at AS lastDiscoveryAt, created_at AS createdAt FROM ds_source ORDER BY id`).all(),
    getSource: (id) => db.prepare(`SELECT id, name, kind, host, port, db_name AS dbName, user_name AS userName, cred_enc AS credential, is_demo AS isDemo, last_test_at AS lastTestAt, last_test_ok AS lastTestOk, last_test_error AS lastTestError, last_discovery_at AS lastDiscoveryAt FROM ds_source WHERE id = ?`).get(id),
    createSource(source) {
      const result = db.prepare(`INSERT INTO ds_source (name, kind, host, port, db_name, user_name, cred_enc, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(source.name, source.kind || "mysql", source.host, source.port || 3306, source.dbName, source.userName, source.credential, source.isDemo ? 1 : 0);
      return this.getSource(Number(result.lastInsertRowid));
    },
    markSourceTest(id, ok, error=null) { db.prepare(`UPDATE ds_source SET last_test_at=CURRENT_TIMESTAMP,last_test_ok=?,last_test_error=? WHERE id=?`).run(ok?1:0,error,id); },
    updateSourceCredential(id,credential) { return db.prepare(`UPDATE ds_source SET cred_enc=?,last_test_ok=NULL,last_test_error=NULL WHERE id=? AND is_demo=0`).run(credential,id).changes; },
    markSourceDiscovered(id) { db.prepare(`UPDATE ds_source SET last_discovery_at=CURRENT_TIMESTAMP WHERE id=?`).run(id); },
    upsertTable(table) {
      db.prepare(`INSERT INTO ds_table (source_id, table_name, row_estimate, grade, grade_override, active, last_probe_at, comment, days_since_write, inbound_relations, present)
        VALUES (@sourceId,@tableName,@rowEstimate,@grade,@gradeOverride,@active,CURRENT_TIMESTAMP,@comment,@daysSinceWrite,@inboundRelations,1)
        ON CONFLICT(source_id,table_name) DO UPDATE SET row_estimate=excluded.row_estimate, grade=CASE WHEN ds_table.grade_override IS NOT NULL THEN ds_table.grade_override ELSE excluded.grade END, active=CASE WHEN ds_table.grade_override IS NOT NULL THEN (ds_table.grade_override<>'C') ELSE excluded.active END, present=1, last_probe_at=CURRENT_TIMESTAMP, comment=excluded.comment, days_since_write=excluded.days_since_write, inbound_relations=excluded.inbound_relations`).run({ gradeOverride:null, active:1, comment:null, daysSinceWrite:null, inboundRelations:0, rowEstimate:0, ...table });
    },
    upsertColumn(column) {
      db.prepare(`INSERT INTO ds_column (source_id, table_name, column_name, data_type, nullable, null_rate, cardinality, is_sensitive, comment, is_primary, is_unique, is_indexed)
        VALUES (@sourceId,@tableName,@columnName,@dataType,@nullable,@nullRate,@cardinality,@isSensitive,@comment,@isPrimary,@isUnique,@isIndexed)
        ON CONFLICT(source_id,table_name,column_name) DO UPDATE SET data_type=excluded.data_type, nullable=excluded.nullable, null_rate=excluded.null_rate, cardinality=excluded.cardinality, is_sensitive=excluded.is_sensitive, comment=excluded.comment, is_primary=excluded.is_primary, is_unique=excluded.is_unique, is_indexed=excluded.is_indexed, present=1`).run({ nullable:1, nullRate:null, cardinality:null, isSensitive:0, comment:null, isPrimary:0, isUnique:0, isIndexed:0, ...column });
    },
    promoteSensitiveColumns(columns=[]) {
      const update=db.prepare(`UPDATE ds_column SET is_sensitive=1 WHERE source_id=? AND table_name=? AND column_name=? AND present=1 AND is_sensitive=0`);
      const promote=db.transaction((items)=>{let changes=0;for(const item of items)changes+=update.run(item.sourceId,item.tableName,item.columnName).changes;return changes;});
      return promote(Array.isArray(columns)?columns:[]);
    },
    upsertEnum(item) {
      db.prepare(`INSERT INTO ds_enum (source_id,table_name,column_name,value,count,ratio,last_written_at,meaning,meaning_source) VALUES (@sourceId,@tableName,@columnName,@value,@count,@ratio,@lastWrittenAt,@meaning,@meaningSource)
        ON CONFLICT(source_id,table_name,column_name,value) DO UPDATE SET count=excluded.count,ratio=excluded.ratio,last_written_at=excluded.last_written_at,meaning=COALESCE(ds_enum.meaning,excluded.meaning),meaning_source=COALESCE(ds_enum.meaning_source,excluded.meaning_source)`).run({ count:null, ratio:null, lastWrittenAt:null, meaning:null, meaningSource:null, ...item });
    },
    upsertColumnProfile(item) {
      const sampledAt=item.sampledAt||new Date().toISOString();
      db.prepare(`INSERT INTO ds_column_profile(source_id,table_name,column_name,profile_json,sampled_at,sample_size,profile_version)
        VALUES(@sourceId,@tableName,@columnName,@profileJson,@sampledAt,@sampleSize,@profileVersion)
        ON CONFLICT(source_id,table_name,column_name) DO UPDATE SET profile_json=excluded.profile_json,sampled_at=excluded.sampled_at,sample_size=excluded.sample_size,profile_version=excluded.profile_version`).run({...item,profileJson:JSON.stringify(item.profile||{}),sampledAt,sampleSize:Math.max(0,Number(item.sampleSize)||0)});
      return this.getColumnProfile(item.sourceId,item.tableName,item.columnName);
    },
    getColumnProfile(sourceId,tableName,columnName) {
      const row=db.prepare(`SELECT profile_json AS profileJson,sampled_at AS sampledAt,sample_size AS sampleSize,profile_version AS profileVersion FROM ds_column_profile WHERE source_id=? AND table_name=? AND column_name=?`).get(sourceId,tableName,columnName);
      return row?{...safeJson(row.profileJson,{}),sampledAt:row.sampledAt,sampleSize:row.sampleSize,profileVersion:row.profileVersion}:null;
    },
    listColumnProfiles(sourceId,tableName=null) {
      const rows=tableName==null?db.prepare(`SELECT table_name AS tableName,column_name AS columnName,profile_json AS profileJson,sampled_at AS sampledAt,sample_size AS sampleSize,profile_version AS profileVersion FROM ds_column_profile WHERE source_id=? ORDER BY table_name,column_name`).all(sourceId):db.prepare(`SELECT table_name AS tableName,column_name AS columnName,profile_json AS profileJson,sampled_at AS sampledAt,sample_size AS sampleSize,profile_version AS profileVersion FROM ds_column_profile WHERE source_id=? AND table_name=? ORDER BY column_name`).all(sourceId,tableName);
      return rows.map((row)=>({...safeJson(row.profileJson,{}),tableName:row.tableName,columnName:row.columnName,sampledAt:row.sampledAt,sampleSize:row.sampleSize,profileVersion:row.profileVersion}));
    },
    upsertRelation(item) {
      const values={cardinality:null,confidence:0,overlapRatio:null,status:"review",inferenceSource:null,modelDecision:null,modelConfidence:null,modelReason:null,modelName:null,structuralScore:null,structuralReason:null,...item};
      db.prepare(`INSERT INTO ds_relation (source_id,from_table,from_col,to_table,to_col,cardinality,confidence,overlap_ratio,status,inference_source,model_decision,model_confidence,model_reason,model_name,structural_score,structural_reason,evaluated_at)
        VALUES (@sourceId,@fromTable,@fromCol,@toTable,@toCol,@cardinality,@confidence,@overlapRatio,@status,@inferenceSource,@modelDecision,@modelConfidence,@modelReason,@modelName,@structuralScore,@structuralReason,CURRENT_TIMESTAMP)
        ON CONFLICT(source_id,from_table,from_col,to_table,to_col) DO UPDATE SET cardinality=excluded.cardinality,confidence=excluded.confidence,overlap_ratio=excluded.overlap_ratio,status=CASE WHEN excluded.inference_source='foreign_key' THEN 'confirmed' WHEN ds_relation.status IN ('confirmed','denied') THEN ds_relation.status ELSE excluded.status END,present=1,inference_source=CASE WHEN excluded.inference_source='foreign_key' THEN excluded.inference_source WHEN ds_relation.inference_source='document' THEN ds_relation.inference_source ELSE excluded.inference_source END,model_decision=excluded.model_decision,model_confidence=excluded.model_confidence,model_reason=excluded.model_reason,model_name=excluded.model_name,structural_score=excluded.structural_score,structural_reason=excluded.structural_reason,evaluated_at=CURRENT_TIMESTAMP`).run(values);
      return this.getRelationByKey(item.sourceId,item.fromTable,item.fromCol,item.toTable,item.toCol);
    },
    listTables: (sourceId) => db.prepare(`SELECT source_id AS sourceId, table_name AS tableName, row_estimate AS rowEstimate, grade, grade_override AS gradeOverride, active, last_probe_at AS lastProbeAt, comment, days_since_write AS daysSinceWrite FROM ds_table WHERE source_id=? AND present=1 ORDER BY CASE grade WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, table_name`).all(sourceId),
    setTableGrade(sourceId, tableName, grade) { return db.prepare(`UPDATE ds_table SET grade=?,grade_override=?,active=? WHERE source_id=? AND table_name=?`).run(grade,grade,grade==="C"?0:1,sourceId,tableName).changes; },
    // Table selection is decided BEFORE probing: excluded tables never get a probe, never
    // enter ds_table, and therefore never surface anywhere downstream. Unlike grade C
    // (a quality judgment on a probed table), exclusion is a scope decision — the table
    // does not belong to this platform's world at all.
    listTableSelections: (sourceId) => db.prepare(`SELECT table_name AS tableName, included, decided_by AS decidedBy, decided_at AS decidedAt FROM ds_table_selection WHERE source_id=? ORDER BY table_name`).all(sourceId),
    excludedTableNames: (sourceId) => new Set(db.prepare(`SELECT table_name AS tableName FROM ds_table_selection WHERE source_id=? AND included=0`).all(sourceId).map((row)=>row.tableName)),
    saveTableSelections(sourceId, selections, decidedBy=null) {
      const upsert=db.prepare(`INSERT INTO ds_table_selection (source_id,table_name,included,decided_by,decided_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(source_id,table_name) DO UPDATE SET included=excluded.included, decided_by=excluded.decided_by, decided_at=CURRENT_TIMESTAMP`);
      db.transaction(()=>{ for(const item of selections) upsert.run(sourceId,item.tableName,item.included?1:0,decidedBy); })();
      return selections.length;
    },
    // Excluding an already-probed table must erase it from the platform's world, not merely
    // hide it: probed metadata (columns, enum values, relations, questions) would otherwise
    // keep resurfacing through every consumer that reads those tables directly.
    purgeExcludedTables(sourceId) {
      const excluded=db.prepare(`SELECT table_name AS tableName FROM ds_table_selection WHERE source_id=? AND included=0`).all(sourceId).map((row)=>row.tableName);
      let removed=0;
      db.transaction(()=>{
        for(const tableName of excluded) {
          const gone=db.prepare(`DELETE FROM ds_table WHERE source_id=? AND table_name=?`).run(sourceId,tableName).changes;
          if(!gone)continue;
          removed++;
          db.prepare(`DELETE FROM ds_column WHERE source_id=? AND table_name=?`).run(sourceId,tableName);
          db.prepare(`DELETE FROM ds_column_profile WHERE source_id=? AND table_name=?`).run(sourceId,tableName);
          db.prepare(`DELETE FROM ds_enum WHERE source_id=? AND table_name=?`).run(sourceId,tableName);
          db.prepare(`UPDATE ds_relation SET present=0 WHERE source_id=? AND (from_table=? OR to_table=?)`).run(sourceId,tableName,tableName);
          db.prepare(`UPDATE ds_question SET status='obsolete',answered_at=CURRENT_TIMESTAMP WHERE source_id=? AND status='pending' AND table_name=?`).run(sourceId,tableName);
        }
      })();
      return removed;
    },
    listColumns(sourceId,tableName) {
      const profiles=new Map(this.listColumnProfiles(sourceId,tableName).map((profile)=>[profile.columnName,profile]));
      return db.prepare(`SELECT source_id AS sourceId,table_name AS tableName,column_name AS columnName,data_type AS dataType,nullable,null_rate AS nullRate,cardinality,is_sensitive AS isSensitive,comment,is_primary AS isPrimary,is_unique AS isUnique,is_indexed AS isIndexed FROM ds_column WHERE source_id=? AND table_name=? AND present=1 ORDER BY rowid`).all(sourceId,tableName).map((column)=>({...column,profile:profiles.get(column.columnName)||null}));
    },
    listEnums: (sourceId, tableName) => db.prepare(`SELECT column_name AS columnName,value,count,ratio,meaning,meaning_source AS meaningSource FROM ds_enum WHERE source_id=? AND table_name=? ORDER BY column_name,count DESC`).all(sourceId, tableName),
    listEnumColumns: () => db.prepare(`SELECT source_id AS sourceId,table_name AS tableName,column_name AS columnName,COUNT(*) AS valueCount,COALESCE(SUM(CASE WHEN meaning_source='human' THEN 1 ELSE 0 END),0) AS humanMeaningCount FROM ds_enum GROUP BY source_id,table_name,column_name ORDER BY source_id,table_name,column_name`).all(),
    // Deletes whole columns, never single values: query-service keeps validating a column as a
    // closed dictionary while any row of it survives, so a partial delete keeps the defect.
    deleteEnumColumns(columns=[]) {
      const remove=db.prepare(`DELETE FROM ds_enum WHERE source_id=? AND table_name=? AND column_name=?`);
      const run=db.transaction((items)=>{let changes=0;for(const item of items)changes+=remove.run(item.sourceId,item.tableName,item.columnName).changes;return changes;});
      return run(Array.isArray(columns)?columns:[]);
    },
    upsertTermAnchor(input) {
      const item={vocabulary:String(input.vocabulary||"").trim(),canonicalId:String(input.canonicalId||"").trim(),prefLabelZh:input.prefLabelZh==null?null:String(input.prefLabelZh).trim()||null,prefLabelEn:input.prefLabelEn==null?null:String(input.prefLabelEn).trim()||null,altLabels:[...new Set((Array.isArray(input.altLabels)?input.altLabels:[]).map((value)=>String(value).trim()).filter(Boolean))],kind:String(input.kind||"object").trim().toLowerCase(),broaderCanonicalId:input.broaderCanonicalId==null?null:String(input.broaderCanonicalId).trim()||null,note:input.note==null?null:String(input.note).trim()||null};
      if(!item.vocabulary||!item.canonicalId)throw new Error("术语锚点 vocabulary 与 canonicalId 必填");
      if(!["object","property","metric"].includes(item.kind))throw new Error("术语锚点 kind 只允许 object、property、metric");
      db.prepare(`INSERT INTO ds_term_anchor(vocabulary,canonical_id,pref_label_zh,pref_label_en,alt_labels,kind,broader_canonical_id,note)
        VALUES(@vocabulary,@canonicalId,@prefLabelZh,@prefLabelEn,@altLabelsJson,@kind,@broaderCanonicalId,@note)
        ON CONFLICT(vocabulary,canonical_id) DO UPDATE SET pref_label_zh=excluded.pref_label_zh,pref_label_en=excluded.pref_label_en,alt_labels=excluded.alt_labels,kind=excluded.kind,broader_canonical_id=excluded.broader_canonical_id,note=excluded.note,updated_at=CURRENT_TIMESTAMP`).run({...item,altLabelsJson:JSON.stringify(item.altLabels)});
      return this.getTermAnchor(item.vocabulary,item.canonicalId);
    },
    getTermAnchor(vocabulary,canonicalId) {
      const row=db.prepare(`SELECT id,vocabulary,canonical_id AS canonicalId,pref_label_zh AS prefLabelZh,pref_label_en AS prefLabelEn,alt_labels AS altLabelsJson,kind,broader_canonical_id AS broaderCanonicalId,note,created_at AS createdAt,updated_at AS updatedAt FROM ds_term_anchor WHERE vocabulary=? AND canonical_id=?`).get(vocabulary,canonicalId);
      return row?parseTermAnchor(row):null;
    },
    listTermAnchors(vocabulary=null) {
      const rows=vocabulary==null?db.prepare(`SELECT id,vocabulary,canonical_id AS canonicalId,pref_label_zh AS prefLabelZh,pref_label_en AS prefLabelEn,alt_labels AS altLabelsJson,kind,broader_canonical_id AS broaderCanonicalId,note,created_at AS createdAt,updated_at AS updatedAt FROM ds_term_anchor ORDER BY vocabulary,kind,canonical_id`).all():db.prepare(`SELECT id,vocabulary,canonical_id AS canonicalId,pref_label_zh AS prefLabelZh,pref_label_en AS prefLabelEn,alt_labels AS altLabelsJson,kind,broader_canonical_id AS broaderCanonicalId,note,created_at AS createdAt,updated_at AS updatedAt FROM ds_term_anchor WHERE vocabulary=? ORDER BY kind,canonical_id`).all(vocabulary);
      return rows.map(parseTermAnchor);
    },
    listRelations: (sourceId, acceptedOnly=false, includeRejected=false) => db.prepare(`SELECT id,from_table AS fromTable,from_col AS fromCol,to_table AS toTable,to_col AS toCol,cardinality,confidence,overlap_ratio AS overlapRatio,status,inference_source AS inferenceSource,model_decision AS modelDecision,model_confidence AS modelConfidence,model_reason AS modelReason,model_name AS modelName,structural_score AS structuralScore,structural_reason AS structuralReason,evaluated_at AS evaluatedAt FROM ds_relation WHERE source_id=? AND present=1 ${acceptedOnly ? "AND status IN ('accepted','confirmed')" : includeRejected ? "" : "AND status NOT IN ('rejected','denied')"} ORDER BY confidence DESC`).all(sourceId),
    getRelationByKey: (sourceId,fromTable,fromCol,toTable,toCol) => db.prepare(`SELECT id,source_id AS sourceId,from_table AS fromTable,from_col AS fromCol,to_table AS toTable,to_col AS toCol,cardinality,confidence,overlap_ratio AS overlapRatio,status,inference_source AS inferenceSource,model_decision AS modelDecision,model_confidence AS modelConfidence,model_reason AS modelReason,model_name AS modelName,structural_score AS structuralScore,structural_reason AS structuralReason,evaluated_at AS evaluatedAt FROM ds_relation WHERE source_id=? AND from_table=? AND from_col=? AND to_table=? AND to_col=?`).get(sourceId,fromTable,fromCol,toTable,toCol),
    addQuestion(question) {
      const existing=db.prepare(`SELECT id FROM ds_question WHERE source_id=@sourceId AND kind=@kind AND ((@relationId IS NOT NULL AND relation_id=@relationId) OR (@relationId IS NULL AND COALESCE(table_name,'')=COALESCE(@tableName,'') AND COALESCE(column_name,'')=COALESCE(@columnName,'') AND COALESCE(enum_value,'')=COALESCE(@enumValue,'') AND question=@question)) AND status='pending'`).get({tableName:null,columnName:null,relationId:null,enumValue:null,...question});
      if(existing) return existing.id;
      const result = db.prepare(`INSERT INTO ds_question (source_id,kind,scope,table_name,column_name,question,evidence,options,relation_id,enum_value) VALUES (@sourceId,@kind,@scope,@tableName,@columnName,@question,@evidence,@options,@relationId,@enumValue)`).run({ tableName:null,columnName:null,relationId:null,enumValue:null,...question, options:JSON.stringify(question.options || []) });
      return Number(result.lastInsertRowid);
    },
    listQuestions: (sourceId) => db.prepare(`SELECT id,kind,scope,table_name AS tableName,column_name AS columnName,enum_value AS enumValue,question,evidence,options,status,relation_id AS relationId FROM ds_question WHERE source_id=? AND status='pending' ORDER BY id`).all(sourceId).map(parseQuestionRow),
    getQuestion: (id) => parseQuestionRow(db.prepare(`SELECT id,source_id AS sourceId,kind,scope,table_name AS tableName,column_name AS columnName,enum_value AS enumValue,question,evidence,options,status,relation_id AS relationId FROM ds_question WHERE id=?`).get(id)),
    answerQuestion(id, answer, outruledBy=null) { return db.prepare(`UPDATE ds_question SET answer=?, answered_at=CURRENT_TIMESTAMP, outruled_by=?, status='answered' WHERE id=? AND status='pending'`).run(answer, outruledBy, id).changes; },
    answerEnumQuestion(id,answer,outruledBy=null) { return answerEnumQuestionTransaction({id,answer,outruledBy}); },
    setEnumMeaning(sourceId,tableName,columnName,value,meaning,meaningSource="human") {
      db.prepare(`INSERT INTO ds_enum(source_id,table_name,column_name,value,count,ratio,meaning,meaning_source) VALUES(?,?,?,?,NULL,NULL,?,?) ON CONFLICT(source_id,table_name,column_name,value) DO UPDATE SET meaning=excluded.meaning,meaning_source=excluded.meaning_source`).run(sourceId,tableName,columnName,String(value),String(meaning),String(meaningSource));
    },
    confirmRelationByColumn(sourceId, tableName, columnName) { return db.prepare(`UPDATE ds_relation SET status='confirmed' WHERE source_id=? AND from_table=? AND from_col=?`).run(sourceId,tableName,columnName).changes; },
    setRelationStatus(id,status) { if(!["review","confirmed","rejected","denied"].includes(status)) throw new Error("不支持的关系状态");return db.prepare(`UPDATE ds_relation SET status=? WHERE id=?`).run(status,id).changes; },
    closeStaleRelationQuestions(sourceId) { return db.prepare(`UPDATE ds_question SET status='obsolete',answered_at=CURRENT_TIMESTAMP WHERE source_id=? AND kind='JOIN 路径' AND status='pending' AND (relation_id IS NULL OR NOT EXISTS (SELECT 1 FROM ds_relation r WHERE r.id=ds_question.relation_id AND r.present=1 AND r.status='review'))`).run(sourceId).changes; },
    // A question about a table the query layer refuses to read can never bind anything,
    // so it is reviewer cost with no payoff. Generation is now filtered, but questions
    // seeded before the table was graded C (or before that filter existed) stay pending
    // forever — nothing else expires 枚举含义. Global-scope questions carry no table and
    // are left alone.
    closeQuestionsOnExcludedTables(sourceId) { return db.prepare(`UPDATE ds_question SET status='obsolete',answered_at=CURRENT_TIMESTAMP WHERE source_id=? AND status='pending' AND table_name IS NOT NULL AND EXISTS (SELECT 1 FROM ds_table t WHERE t.source_id=ds_question.source_id AND t.table_name=ds_question.table_name AND (t.grade='C' OR t.active=0 OR t.present=0))`).run(sourceId).changes; },
    saveRelationAnalysis(item) { db.prepare(`INSERT INTO ds_relation_analysis(source_id,model_status,model_name,candidate_count,judged_count,suggested_count,rejected_count,error,updated_at) VALUES(@sourceId,@modelStatus,@modelName,@candidateCount,@judgedCount,@suggestedCount,@rejectedCount,@error,CURRENT_TIMESTAMP) ON CONFLICT(source_id) DO UPDATE SET model_status=excluded.model_status,model_name=excluded.model_name,candidate_count=excluded.candidate_count,judged_count=excluded.judged_count,suggested_count=excluded.suggested_count,rejected_count=excluded.rejected_count,error=excluded.error,updated_at=CURRENT_TIMESTAMP`).run({modelName:null,candidateCount:0,judgedCount:0,suggestedCount:0,rejectedCount:0,error:null,...item}); },
    relationStats(sourceId) { const counts=db.prepare(`SELECT COALESCE(SUM(CASE WHEN inference_source='foreign_key' AND present=1 AND status<>'rejected' THEN 1 ELSE 0 END),0) AS explicit,COALESCE(SUM(CASE WHEN inference_source='model' AND present=1 AND status='review' THEN 1 ELSE 0 END),0) AS modelSuggested,COALESCE(SUM(CASE WHEN present=1 AND status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed,COALESCE(SUM(CASE WHEN inference_source='model' AND present=1 AND status='rejected' THEN 1 ELSE 0 END),0) AS rejected FROM ds_relation WHERE source_id=?`).get(sourceId);const analysis=db.prepare(`SELECT model_status AS modelStatus,model_name AS modelName,candidate_count AS candidateCount,judged_count AS judgedCount,suggested_count AS suggestedCount,rejected_count AS rejectedCount,error,updated_at AS updatedAt FROM ds_relation_analysis WHERE source_id=?`).get(sourceId);return {...counts,...(analysis||{modelStatus:"not_run",modelName:null,candidateCount:0,judgedCount:0,suggestedCount:0,rejectedCount:0,error:null,updatedAt:null})}; },
    createRelationDoc(item) {
      db.prepare(`INSERT INTO ds_relation_doc(id,source_id,file_name,file_path,checksum,status,assertions_json,assertion_count,accepted_count,rejected_count,error,created_by) VALUES(@id,@sourceId,@fileName,@filePath,@checksum,@status,@assertionsJson,@assertionCount,@acceptedCount,@rejectedCount,@error,@createdBy)`).run({...item,assertionsJson:JSON.stringify(item.assertions||[]),assertionCount:Number(item.assertionCount)||0,acceptedCount:Number(item.acceptedCount)||0,rejectedCount:Number(item.rejectedCount)||0,error:item.error||null,createdBy:item.createdBy||null});
      return this.getRelationDoc(item.id);
    },
    getRelationDoc(id) { const row=db.prepare(`SELECT id,source_id AS sourceId,file_name AS fileName,file_path AS filePath,checksum,status,assertions_json AS assertionsJson,assertion_count AS assertionCount,accepted_count AS acceptedCount,rejected_count AS rejectedCount,error,created_by AS createdBy,created_at AS createdAt FROM ds_relation_doc WHERE id=?`).get(id);return row?parseRelationDoc(row):null; },
    getRelationDocByChecksum(sourceId,checksum) { const row=db.prepare(`SELECT id,source_id AS sourceId,file_name AS fileName,file_path AS filePath,checksum,status,assertions_json AS assertionsJson,assertion_count AS assertionCount,accepted_count AS acceptedCount,rejected_count AS rejectedCount,error,created_by AS createdBy,created_at AS createdAt FROM ds_relation_doc WHERE source_id=? AND checksum=?`).get(sourceId,checksum);return row?parseRelationDoc(row):null; },
    listRelationDocs(sourceId) { return db.prepare(`SELECT id,source_id AS sourceId,file_name AS fileName,file_path AS filePath,checksum,status,assertions_json AS assertionsJson,assertion_count AS assertionCount,accepted_count AS acceptedCount,rejected_count AS rejectedCount,error,created_by AS createdBy,created_at AS createdAt FROM ds_relation_doc WHERE source_id=? ORDER BY created_at DESC,id DESC`).all(sourceId).map(parseRelationDoc); },
    addRule(rule) { db.prepare(`INSERT INTO ds_rule(source_id,name,content,applies_to,verified) VALUES(@sourceId,@name,@content,@appliesTo,@verified) ON CONFLICT(source_id,name) DO UPDATE SET content=excluded.content,applies_to=excluded.applies_to,verified=excluded.verified`).run({appliesTo:null,verified:0,...rule}); },
    listRules: (sourceId) => db.prepare(`SELECT id,name,content,applies_to AS appliesTo,verified FROM ds_rule WHERE source_id=? ORDER BY verified DESC,name`).all(sourceId),
    addAudit(item) { const result=db.prepare(`INSERT INTO ds_audit(user_name,source_id,question,retrieved_pages,prompt_hash,sql_text,verdict,fail_reason,duration_ms,row_count,planning_mode,query_plan_json,ontology_schema_version,semantic_path_json,semantic_fallback_reason,planning_attempts,iterations,clarification_count,tool_trace_json,intent_version,intent_json,prompt_version,retrieval_trace_json,failure_class) VALUES(@userName,@sourceId,@question,@retrievedPages,@promptHash,@sql,@verdict,@failReason,@durationMs,@rowCount,@planningMode,@queryPlanJson,@ontologySchemaVersion,@semanticPathJson,@semanticFallbackReason,@planningAttempts,@iterations,@clarificationCount,@toolTraceJson,@intentVersion,@intentJson,@promptVersion,@retrievalTraceJson,@failureClass)`).run({userName:"local-user",sourceId:null,retrievedPages:"[]",promptHash:null,sql:null,failReason:null,durationMs:null,rowCount:null,planningMode:null,queryPlanJson:null,ontologySchemaVersion:null,semanticPathJson:null,semanticFallbackReason:null,planningAttempts:null,iterations:null,clarificationCount:0,toolTraceJson:"[]",intentVersion:null,intentJson:null,promptVersion:null,retrievalTraceJson:null,failureClass:null,...item});return Number(result.lastInsertRowid); },
    listAudits: (sourceId, limit=100) => db.prepare(`SELECT id,user_name AS userName,question,retrieved_pages AS retrievedPages,sql_text AS sql,verdict,fail_reason AS failReason,duration_ms AS durationMs,row_count AS rowCount,planning_mode AS planningMode,query_plan_json AS queryPlanJson,ontology_schema_version AS ontologySchemaVersion,semantic_path_json AS semanticPathJson,semantic_fallback_reason AS semanticFallbackReason,planning_attempts AS planningAttempts,iterations,clarification_count AS clarificationCount,tool_trace_json AS toolTraceJson,intent_version AS intentVersion,intent_json AS intentJson,prompt_version AS promptVersion,retrieval_trace_json AS retrievalTraceJson,failure_class AS failureClass,created_at AS createdAt FROM ds_audit WHERE (? IS NULL OR source_id=?) ORDER BY id DESC LIMIT ?`).all(sourceId,sourceId,limit).map((row)=>({...row,queryPlan:safeJson(row.queryPlanJson,null),semanticPath:safeJson(row.semanticPathJson,null),toolTrace:safeJson(row.toolTraceJson,[]),intent:safeJson(row.intentJson,null),retrievalTrace:safeJson(row.retrievalTraceJson,null)})),
    auditStats(sourceId) { return db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verdict='passed' THEN 1 ELSE 0 END),0) AS passed, COALESCE(SUM(CASE WHEN verdict IN ('refused','failed') THEN 1 ELSE 0 END),0) AS blocked, COALESCE(AVG(duration_ms),0) AS averageMs FROM ds_audit WHERE source_id=?`).get(sourceId); },
    upsertKnowledge(page) {
      db.prepare(`INSERT INTO ds_knowledge_page(source_id,page_type,slug,title,aliases,tables_json,content,sql_content,anti_examples,verified,owner,verified_at,file_path,checksum,contract_json,semantic_health)
        VALUES(@sourceId,@pageType,@slug,@title,@aliases,@tablesJson,@content,@sqlContent,@antiExamples,@verified,@owner,@verifiedAt,@filePath,@checksum,@contractJson,@semanticHealth)
        ON CONFLICT(source_id,page_type,slug) DO UPDATE SET title=excluded.title,aliases=excluded.aliases,tables_json=excluded.tables_json,content=excluded.content,sql_content=excluded.sql_content,anti_examples=excluded.anti_examples,verified=excluded.verified,owner=excluded.owner,verified_at=excluded.verified_at,file_path=excluded.file_path,checksum=excluded.checksum,contract_json=excluded.contract_json,semantic_health=excluded.semantic_health,updated_at=CURRENT_TIMESTAMP`).run({aliases:"[]",tablesJson:"[]",content:"",sqlContent:null,antiExamples:null,verified:0,owner:null,verifiedAt:null,filePath:null,checksum:null,contractJson:null,semanticHealth:null,...page});
      return this.getKnowledge(page.sourceId,page.pageType,page.slug);
    },
    listKnowledge(sourceId) { return db.prepare(`SELECT id,source_id AS sourceId,page_type AS pageType,slug,title,aliases,tables_json AS tablesJson,content,sql_content AS sqlContent,anti_examples AS antiExamples,verified,owner,verified_at AS verifiedAt,file_path AS filePath,checksum,contract_json AS contractJson,semantic_health AS semanticHealth,created_at AS createdAt,updated_at AS updatedAt FROM ds_knowledge_page WHERE source_id=? ORDER BY CASE page_type WHEN 'term' THEN 1 WHEN 'metric' THEN 2 WHEN 'rule' THEN 3 WHEN 'join' THEN 4 ELSE 5 END,verified DESC,title`).all(sourceId).map(parseKnowledge); },
    getKnowledge(sourceId,pageType,slug) { const row=db.prepare(`SELECT id,source_id AS sourceId,page_type AS pageType,slug,title,aliases,tables_json AS tablesJson,content,sql_content AS sqlContent,anti_examples AS antiExamples,verified,owner,verified_at AS verifiedAt,file_path AS filePath,checksum,contract_json AS contractJson,semantic_health AS semanticHealth,created_at AS createdAt,updated_at AS updatedAt FROM ds_knowledge_page WHERE source_id=? AND page_type=? AND slug=?`).get(sourceId,pageType,slug); return row?parseKnowledge(row):null; },
    deleteKnowledge(sourceId,pageType,slug) { return db.prepare(`DELETE FROM ds_knowledge_page WHERE source_id=? AND page_type=? AND slug=?`).run(sourceId,pageType,slug).changes; },
    listEvalCases(sourceId) { return db.prepare(`SELECT id,set_name AS setName,question,CASE WHEN held_out=1 THEN NULL ELSE gold_sql END AS goldSql,CASE WHEN gold_sql IS NULL OR gold_sql='' THEN 0 ELSE 1 END AS hasGoldSql,category,held_out AS heldOut FROM ds_eval WHERE source_id=? AND active=1 ORDER BY id`).all(sourceId); },
    getEvalCase(id) { return db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,question,gold_sql AS goldSql,category,held_out AS heldOut,active FROM ds_eval WHERE id=?`).get(id); },
    addEvalCase(item) { const result=db.prepare(`INSERT INTO ds_eval(source_id,set_name,question,gold_sql,category,held_out) VALUES(@sourceId,@setName,@question,@goldSql,@category,@heldOut)`).run({goldSql:null,category:"未分类",heldOut:0,...item}); return this.getEvalCase(Number(result.lastInsertRowid)); },
    updateEvalCase(id,item) { db.prepare(`UPDATE ds_eval SET set_name=@setName,question=@question,gold_sql=@goldSql,category=@category,held_out=@heldOut,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND active=1`).run({id,goldSql:null,category:"未分类",heldOut:0,...item}); return this.getEvalCase(id); },
    archiveEvalCase(id) { return db.prepare(`UPDATE ds_eval SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`).run(id).changes; },
    listEvalCasesForRun(sourceId,setName) { return db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,question,gold_sql AS goldSql,category,held_out AS heldOut FROM ds_eval WHERE source_id=? AND set_name=? AND active=1 ORDER BY id`).all(sourceId,setName); },
    listEvalCasesForImpact(sourceId) { return db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,question,gold_sql AS goldSql,category,held_out AS heldOut FROM ds_eval WHERE source_id=? AND active=1 ORDER BY id`).all(sourceId); },
    addEvalRun(item) { const result=db.prepare(`INSERT INTO ds_eval_run(eval_id,source_id,batch_id,generated_sql,passed,fail_reason,expected_json,actual_json,duration_ms,failure_class,suggestion,repair_hints_json,requested_mode,planning_mode,comparison_role,ontology_schema_version,semantic_path_json,table_count,planning_attempts,agent_metrics_json) VALUES(@evalId,@sourceId,@batchId,@generatedSql,@passed,@failReason,@expectedJson,@actualJson,@durationMs,@failureClass,@suggestion,@repairHintsJson,@requestedMode,@planningMode,@comparisonRole,@ontologySchemaVersion,@semanticPathJson,@tableCount,@planningAttempts,@agentMetricsJson)`).run({generatedSql:null,failReason:null,expectedJson:null,actualJson:null,durationMs:null,failureClass:null,suggestion:null,repairHintsJson:"[]",requestedMode:null,planningMode:null,comparisonRole:null,ontologySchemaVersion:null,semanticPathJson:null,tableCount:null,planningAttempts:null,agentMetricsJson:null,...item}); return Number(result.lastInsertRowid); },
    listEvalRuns(sourceId,limit=400) { return db.prepare(`SELECT r.id,r.eval_id AS evalId,r.batch_id AS batchId,e.set_name AS setName,e.question,r.generated_sql AS generatedSql,r.passed,r.fail_reason AS failReason,r.duration_ms AS durationMs,r.failure_class AS failureClass,r.suggestion,r.repair_hints_json AS repairHintsJson,r.requested_mode AS requestedMode,r.planning_mode AS planningMode,r.comparison_role AS comparisonRole,r.ontology_schema_version AS ontologySchemaVersion,r.semantic_path_json AS semanticPathJson,r.table_count AS tableCount,r.planning_attempts AS planningAttempts,r.agent_metrics_json AS agentMetricsJson,r.run_at AS runAt FROM ds_eval_run r JOIN ds_eval e ON e.id=r.eval_id WHERE r.source_id=? ORDER BY r.id DESC LIMIT ?`).all(sourceId,limit).map((row)=>({...row,semanticPath:safeJson(row.semanticPathJson,null),repairHints:safeJson(row.repairHintsJson,[]),agentMetrics:safeJson(row.agentMetricsJson,null)})); },
    saveEvalGate(item) { db.prepare(`INSERT INTO ds_eval_gate(id,source_id,set_name,total,ontology_schema_version,ontology_schema_published_at,evaluation_checksum,baseline_json,candidate_json,passed,decision,reason) VALUES(@id,@sourceId,@setName,@total,@ontologySchemaVersion,@ontologySchemaPublishedAt,@evaluationChecksum,@baselineJson,@candidateJson,@passed,@decision,@reason) ON CONFLICT(id) DO UPDATE SET ontology_schema_version=excluded.ontology_schema_version,ontology_schema_published_at=excluded.ontology_schema_published_at,evaluation_checksum=excluded.evaluation_checksum,baseline_json=excluded.baseline_json,candidate_json=excluded.candidate_json,passed=excluded.passed,decision=excluded.decision,reason=excluded.reason`).run({ontologySchemaVersion:null,ontologySchemaPublishedAt:null,evaluationChecksum:null,...item,baselineJson:JSON.stringify(item.baseline),candidateJson:JSON.stringify(item.candidate)});return this.getEvalGate(item.id); },
    getEvalGate(id) { const row=db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,total,ontology_schema_version AS ontologySchemaVersion,ontology_schema_published_at AS ontologySchemaPublishedAt,evaluation_checksum AS evaluationChecksum,baseline_json AS baselineJson,candidate_json AS candidateJson,passed,decision,reason,created_at AS createdAt FROM ds_eval_gate WHERE id=?`).get(id);return row?{...row,baseline:safeJson(row.baselineJson,{}),candidate:safeJson(row.candidateJson,{})}:null; },
    listEvalGates(sourceId,limit=20) { return db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,total,ontology_schema_version AS ontologySchemaVersion,ontology_schema_published_at AS ontologySchemaPublishedAt,evaluation_checksum AS evaluationChecksum,baseline_json AS baselineJson,candidate_json AS candidateJson,passed,decision,reason,created_at AS createdAt FROM ds_eval_gate WHERE source_id=? ORDER BY created_at DESC LIMIT ?`).all(sourceId,limit).map((row)=>({...row,baseline:safeJson(row.baselineJson,{}),candidate:safeJson(row.candidateJson,{})})); },
    findPassedEvalGate(sourceId,setName,ontologySchemaVersion,evaluationChecksum) { const row=db.prepare(`SELECT id,source_id AS sourceId,set_name AS setName,total,ontology_schema_version AS ontologySchemaVersion,ontology_schema_published_at AS ontologySchemaPublishedAt,evaluation_checksum AS evaluationChecksum,baseline_json AS baselineJson,candidate_json AS candidateJson,passed,decision,reason,created_at AS createdAt FROM ds_eval_gate WHERE source_id=? AND set_name=? AND ontology_schema_version=? AND evaluation_checksum=? AND passed=1 ORDER BY created_at DESC LIMIT 1`).get(sourceId,setName,ontologySchemaVersion,evaluationChecksum);return row?{...row,baseline:safeJson(row.baselineJson,{}),candidate:safeJson(row.candidateJson,{})}:null; },
    createSession(item) { db.prepare(`INSERT INTO ds_query_session(id,source_id,user_name,title,context_json) VALUES(@id,@sourceId,@userName,@title,@contextJson)`).run({title:"新问数会话",contextJson:"{}",...item}); return this.getSession(item.id); },
    getSession(id) { const row=db.prepare(`SELECT id,source_id AS sourceId,user_name AS userName,title,context_json AS contextJson,created_at AS createdAt,updated_at AS updatedAt FROM ds_query_session WHERE id=?`).get(id); return row?{...row,context:safeJson(row.contextJson,{})}:null; },
    updateSession(id,context) { db.prepare(`UPDATE ds_query_session SET context_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(context),id); },
    listSessions(sourceId,userName,limit=50) { return db.prepare(`SELECT s.id,s.source_id AS sourceId,s.user_name AS userName,s.title,s.created_at AS createdAt,s.updated_at AS updatedAt,COUNT(m.id) AS messageCount FROM ds_query_session s LEFT JOIN ds_query_message m ON m.session_id=s.id WHERE s.source_id=? AND s.user_name=? GROUP BY s.id ORDER BY s.updated_at DESC,s.rowid DESC LIMIT ?`).all(sourceId,userName,limit); },
    listSessionMessages(sessionId) { return db.prepare(`SELECT m.id,m.session_id AS sessionId,m.role,m.content_json AS contentJson,m.audit_id AS auditId,a.tool_trace_json AS auditToolTraceJson,m.created_at AS createdAt FROM ds_query_message m LEFT JOIN ds_audit a ON a.id=m.audit_id WHERE m.session_id=? ORDER BY m.id`).all(sessionId).map(parseQueryMessage); },
    getSessionDetail(id) { const session=this.getSession(id);return session?{...session,messages:this.listSessionMessages(id)}:null; },
    appendSessionTurn(sessionId,question,response,auditId=null) {
      return db.transaction(()=>{
        const session=this.getSession(sessionId);if(!session)throw new Error("问数会话不存在");
        const existing=Number(db.prepare(`SELECT COUNT(*) AS count FROM ds_query_message WHERE session_id=?`).get(sessionId).count||0);
        db.prepare(`INSERT INTO ds_query_message(session_id,role,content_json) VALUES(?,?,?)`).run(sessionId,"user",JSON.stringify({text:String(question)}));
        const storedResponse=structuredClone(response);delete storedResponse._auditId;if(storedResponse.evidence)delete storedResponse.evidence.toolTrace;delete storedResponse.toolTrace;
        db.prepare(`INSERT INTO ds_query_message(session_id,role,content_json,audit_id) VALUES(?,?,?,?)`).run(sessionId,"assistant",JSON.stringify(storedResponse),auditId||null);
        const title=existing===0?conversationTitle(question):session.title;
        db.prepare(`UPDATE ds_query_session SET title=?,updated_at=STRFTIME('%Y-%m-%d %H:%M:%f','NOW') WHERE id=?`).run(title,sessionId);
        return this.getSessionDetail(sessionId);
      })();
    },
    getSessionPlanningHistory(sessionId,maxMessages=10) {
      const rows=db.prepare(`SELECT role,content_json AS contentJson FROM ds_query_message WHERE session_id=? ORDER BY id DESC LIMIT ?`).all(sessionId,Math.max(1,Math.min(20,Number(maxMessages)||10))).reverse();
      return rows.map((row)=>{const content=safeJson(row.contentJson,{});if(row.role==="user")return {role:"user",content:String(content.text||"")};const clarification=Array.isArray(content.evidence?.clarifications)&&content.evidence.clarifications.length?`澄清口径：${content.evidence.clarifications.map((item)=>`${item.question} = ${item.answer}`).join("；")}\n`:"";const scope=Array.isArray(content.evidence?.tables)&&content.evidence.tables.length?`查询范围：${content.evidence.tables.slice(0,12).join("、")}\n`:"";return {role:"assistant",content:`${clarification}${scope}${String(content.refused?content.reason||"安全拒答":content.conclusion||"查询完成")}`};}).filter((item)=>item.content);
    },
    deleteSession(id) { return db.transaction(()=>{db.prepare(`DELETE FROM ds_query_message WHERE session_id=?`).run(id);return db.prepare(`DELETE FROM ds_query_session WHERE id=?`).run(id).changes;})(); },
    createTask(item) { db.prepare(`INSERT INTO ds_task(id,source_id,task_type,status,progress,total,current_step,payload_json) VALUES(@id,@sourceId,@taskType,'queued',0,@total,@currentStep,@payloadJson)`).run({total:100,currentStep:"等待执行",payloadJson:"{}",...item}); return this.getTask(item.id); },
    getTask(id) { const row=db.prepare(`SELECT id,source_id AS sourceId,task_type AS taskType,status,progress,total,current_step AS currentStep,payload_json AS payloadJson,result_json AS resultJson,error,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_task WHERE id=?`).get(id); return row?parseTask(row):null; },
    listTasks(sourceId,limit=50) { return db.prepare(`SELECT id,source_id AS sourceId,task_type AS taskType,status,progress,total,current_step AS currentStep,payload_json AS payloadJson,result_json AS resultJson,error,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_task WHERE source_id=? ORDER BY created_at DESC LIMIT ?`).all(sourceId,limit).map(parseTask); },
    findActiveTask(sourceId,taskType) { const row=db.prepare(`SELECT id,source_id AS sourceId,task_type AS taskType,status,progress,total,current_step AS currentStep,payload_json AS payloadJson,result_json AS resultJson,error,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_task WHERE source_id=? AND task_type=? AND status IN ('queued','running') ORDER BY created_at LIMIT 1`).get(sourceId,taskType); return row?parseTask(row):null; },
    listRecoverableTasks() { return db.prepare(`SELECT id,source_id AS sourceId,task_type AS taskType,status,progress,total,current_step AS currentStep,payload_json AS payloadJson,result_json AS resultJson,error,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_task WHERE status IN ('queued','running') ORDER BY created_at`).all().map(parseTask); },
    startTask(id) { db.prepare(`UPDATE ds_task SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),current_step='开始执行',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running')`).run(id); return this.getTask(id); },
    updateTaskProgress(id,{progress,total=100,currentStep}) { db.prepare(`UPDATE ds_task SET progress=?,total=?,current_step=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'`).run(Math.max(0,Math.min(total,Math.round(progress))),total,currentStep,id); return this.getTask(id); },
    completeTask(id,result) { db.prepare(`UPDATE ds_task SET status='succeeded',progress=total,current_step='已完成',result_json=?,error=NULL,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(result??null),id); return this.getTask(id); },
    failTask(id,error) { db.prepare(`UPDATE ds_task SET status='failed',current_step='执行失败',error=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(String(error),id); return this.getTask(id); },
    requeueInterruptedTasks() { return db.prepare(`UPDATE ds_task SET status='queued',current_step='服务重启，等待恢复',started_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='running'`).run().changes; },
    addSchemaSnapshot(sourceId,checksum,schema) { const current=db.prepare(`SELECT COALESCE(MAX(version),0) AS version FROM ds_schema_snapshot WHERE source_id=?`).get(sourceId); const version=Number(current.version)+1; db.prepare(`INSERT INTO ds_schema_snapshot(source_id,version,checksum,schema_json) VALUES(?,?,?,?)`).run(sourceId,version,checksum,JSON.stringify(schema)); return this.getLatestSchemaSnapshot(sourceId); },
    getLatestSchemaSnapshot(sourceId) { const row=db.prepare(`SELECT id,source_id AS sourceId,version,checksum,schema_json AS schemaJson,created_at AS createdAt FROM ds_schema_snapshot WHERE source_id=? ORDER BY version DESC LIMIT 1`).get(sourceId); return row?{...row,schema:safeJson(row.schemaJson,{tables:[],columns:[],foreignKeys:[]})}:null; },
    listSchemaSnapshots(sourceId,limit=20) { return db.prepare(`SELECT id,source_id AS sourceId,version,checksum,created_at AS createdAt FROM ds_schema_snapshot WHERE source_id=? ORDER BY version DESC LIMIT ?`).all(sourceId,limit); },
    createOntologySchemaVersion(item) {
      const id=db.transaction((input)=>{
        const current=db.prepare(`SELECT COALESCE(MAX(version),0) AS version FROM ds_ontology_schema_version WHERE source_id=?`).get(input.sourceId);
        const version=Number(current.version)+1;
        const result=db.prepare(`INSERT INTO ds_ontology_schema_version(source_id,version,status,schema_name,schema_json,checksum,validation_json,created_by) VALUES(@sourceId,@version,'draft',@schemaName,@schemaJson,@checksum,@validationJson,@createdBy)`).run({...input,version,schemaJson:JSON.stringify(input.schema),validationJson:JSON.stringify(input.validation)});
        return Number(result.lastInsertRowid);
      }).immediate(item);
      return this.getOntologySchemaVersion(id);
    },
    createOntologyDraftWithCandidates(item) {
      const id=db.transaction((input)=>{
        const candidateIds=[...new Set((input.candidateIds||[]).map(String))];
        const repairFromSchemaVersionId=Number(input.repairFromSchemaVersionId)||null;
        if(!candidateIds.length)throw storeConflict("没有可应用的已确认候选");
        if((input.validation?.errors||[]).some((issue)=>issue?.code==="ONTOLOGY_LIMIT_EXCEEDED"))throw storeConflict("Schema 超出容量上限，已阻止保存会丢失定义的草稿");
        const currentPublished=db.prepare(`SELECT id FROM ds_ontology_schema_version WHERE source_id=? AND status='published' ORDER BY version DESC LIMIT 1`).get(input.sourceId);
        if((currentPublished?.id||null)!==(input.expectedPublishedSchemaVersionId||null))throw storeConflict("当前发布 Schema 已变化，请基于最新版本重新生成批次");
        if(input.baseSchemaVersionId!=null) {
          const base=db.prepare(`SELECT source_id AS sourceId FROM ds_ontology_schema_version WHERE id=?`).get(input.baseSchemaVersionId);
          if(!base||Number(base.sourceId)!==Number(input.sourceId))throw storeConflict("基础 Schema 版本不存在或不属于当前数据源");
        }
        if(repairFromSchemaVersionId) {
          const previous=db.prepare(`SELECT source_id AS sourceId,status FROM ds_ontology_schema_version WHERE id=?`).get(repairFromSchemaVersionId);
          if(!previous||Number(previous.sourceId)!==Number(input.sourceId)||previous.status!=="draft")throw storeConflict("待修复草稿不存在、已发布或不属于当前数据源");
        }
        const allowedRunIds=new Set((input.runIds||[input.runId]).map(String));
        const candidates=candidateIds.map((candidateId)=>this.getOntologyCandidate(candidateId));
        if(candidates.some((candidate)=>!candidate))throw storeConflict("待应用候选不存在，请刷新后重试");
        if(candidates.some((candidate)=>!allowedRunIds.has(candidate.runId)||Number(candidate.sourceId)!==Number(input.sourceId)))throw storeConflict("待应用候选不属于当前生成批次");
        if(candidates.some((candidate)=>!["auto_confirmed","confirmed"].includes(candidate.status)&&!(repairFromSchemaVersionId&&candidate.status==="applied"&&Number(candidate.appliedSchemaVersionId)===repairFromSchemaVersionId)))throw storeConflict("候选状态已变化，请刷新后重试");

        const current=db.prepare(`SELECT COALESCE(MAX(version),0) AS version FROM ds_ontology_schema_version WHERE source_id=?`).get(input.sourceId);
        const version=Number(current.version)+1;
        const inserted=db.prepare(`INSERT INTO ds_ontology_schema_version(source_id,version,status,schema_name,schema_json,checksum,validation_json,created_by) VALUES(@sourceId,@version,'draft',@schemaName,@schemaJson,@checksum,@validationJson,@createdBy)`).run({...input,version,schemaJson:JSON.stringify(input.schema),validationJson:JSON.stringify(input.validation)});
        const schemaVersionId=Number(inserted.lastInsertRowid);
        const candidateRowNumber=db.prepare(`SELECT rowid AS rowNumber FROM ds_ontology_candidate WHERE id=?`);
        const olderCandidates=db.prepare(`SELECT id FROM ds_ontology_candidate WHERE source_id=? AND candidate_type=? AND stable_key=? AND run_id<>? AND rowid<? AND status IN ('auto_confirmed','confirmed') ORDER BY rowid`);
        for(const candidate of candidates) {
          const before=this.getOntologyCandidate(candidate.id);
          const reapplied=before.status==="applied";
          const applied=reapplied
            ?db.prepare(`UPDATE ds_ontology_candidate SET applied_schema_version_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='applied' AND applied_schema_version_id=?`).run(schemaVersionId,before.id,repairFromSchemaVersionId)
            :db.prepare(`UPDATE ds_ontology_candidate SET status='applied',applied_schema_version_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`).run(schemaVersionId,before.id,before.status);
          if(applied.changes!==1)throw storeConflict("候选状态已变化，请刷新后重试");
          const after=this.getOntologyCandidate(before.id);
          db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(before.id,before.runId,before.sourceId,reapplied?"reapplied":"applied",input.createdBy||null,before.status,"applied",reapplied?`从异常草稿重建到 Schema 草稿 v${version}`:`应用到 Schema 草稿 v${version}`,JSON.stringify(before),JSON.stringify(after));

          if(reapplied)continue;
          const rowNumber=candidateRowNumber.get(before.id)?.rowNumber;
          for(const older of olderCandidates.all(before.sourceId,before.candidateType,before.stableKey,before.runId,rowNumber)) {
            if(candidateIds.includes(older.id))continue;
            const supersededBefore=this.getOntologyCandidate(older.id);
            const superseded=db.prepare(`UPDATE ds_ontology_candidate SET status='superseded',superseded_by_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`).run(before.id,supersededBefore.id,supersededBefore.status);
            if(superseded.changes!==1)throw storeConflict("跨批次同键候选状态已变化，请刷新后重试");
            const supersededAfter=this.getOntologyCandidate(supersededBefore.id);
            db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(supersededBefore.id,supersededBefore.runId,supersededBefore.sourceId,"cross_run_superseded",input.createdBy||null,supersededBefore.status,"superseded",`由候选 ${before.id} 在 Schema 草稿 v${version} 中替代`,JSON.stringify(supersededBefore),JSON.stringify(supersededAfter));
          }
        }
        return schemaVersionId;
      }).immediate(item);
      return this.getOntologySchemaVersion(id);
    },
    getOntologySchemaVersion(id) { const row=db.prepare(`SELECT id,source_id AS sourceId,version,status,schema_name AS schemaName,schema_json AS schemaJson,checksum,validation_json AS validationJson,created_by AS createdBy,created_at AS createdAt,published_by AS publishedBy,published_at AS publishedAt FROM ds_ontology_schema_version WHERE id=?`).get(id); return row?parseOntologySchemaVersion(row):null; },
    listOntologySchemaVersions(sourceId,limit=50) { return db.prepare(`SELECT id,source_id AS sourceId,version,status,schema_name AS schemaName,checksum,validation_json AS validationJson,created_by AS createdBy,created_at AS createdAt,published_by AS publishedBy,published_at AS publishedAt FROM ds_ontology_schema_version WHERE source_id=? ORDER BY version DESC LIMIT ?`).all(sourceId,limit).map((row)=>parseOntologySchemaVersion(row,false)); },
    getPublishedOntologySchema(sourceId) { const row=db.prepare(`SELECT id,source_id AS sourceId,version,status,schema_name AS schemaName,schema_json AS schemaJson,checksum,validation_json AS validationJson,created_by AS createdBy,created_at AS createdAt,published_by AS publishedBy,published_at AS publishedAt FROM ds_ontology_schema_version WHERE source_id=? AND status='published' ORDER BY version DESC LIMIT 1`).get(sourceId); return row?parseOntologySchemaVersion(row):null; },
    updateOntologySchemaValidation(id,validation) { return db.prepare(`UPDATE ds_ontology_schema_version SET validation_json=? WHERE id=?`).run(JSON.stringify(validation),id).changes; },
    publishOntologySchemaVersion(id,publishedBy,action="publish") {
      db.transaction((versionId,userName,publicationAction)=>{
        const selected=db.prepare(`SELECT source_id AS sourceId FROM ds_ontology_schema_version WHERE id=?`).get(versionId);
        if(!selected) return;
        const previous=db.prepare(`SELECT id FROM ds_ontology_schema_version WHERE source_id=? AND status='published' AND id<>?`).get(selected.sourceId,versionId);
        db.prepare(`UPDATE ds_ontology_schema_version SET status='deprecated' WHERE source_id=? AND status='published' AND id<>?`).run(selected.sourceId,versionId);
        db.prepare(`UPDATE ds_ontology_schema_version SET status='published',published_by=?,published_at=CURRENT_TIMESTAMP WHERE id=?`).run(userName,versionId);
        db.prepare(`INSERT INTO ds_ontology_publication(source_id,schema_version_id,previous_schema_version_id,action,user_name) VALUES(?,?,?,?,?)`).run(selected.sourceId,versionId,previous?.id||null,publicationAction,userName);
      }).immediate(id,publishedBy,action);
      return this.getOntologySchemaVersion(id);
    },
    listOntologyPublications(sourceId,limit=50) { return db.prepare(`SELECT id,source_id AS sourceId,schema_version_id AS schemaVersionId,previous_schema_version_id AS previousSchemaVersionId,action,user_name AS userName,created_at AS createdAt FROM ds_ontology_publication WHERE source_id=? ORDER BY id DESC LIMIT ?`).all(sourceId,limit); },
    createOntologyGenerationRun(item) {
      db.prepare(`INSERT INTO ds_ontology_generation_run(id,source_id,task_id,mode,scope_json,catalog_checksum,base_schema_version_id,model_name,prompt_version,scoring_version,status,progress,summary_json,token_usage_json,error,created_by)
        VALUES(@id,@sourceId,@taskId,@mode,@scopeJson,@catalogChecksum,@baseSchemaVersionId,@modelName,@promptVersion,@scoringVersion,@status,@progress,@summaryJson,@tokenUsageJson,@error,@createdBy)`).run({
        taskId:null,mode:"selected_tables",scopeJson:JSON.stringify(item.scope||{}),baseSchemaVersionId:null,modelName:null,status:"queued",progress:0,summaryJson:JSON.stringify(item.summary||{}),tokenUsageJson:JSON.stringify(item.tokenUsage||{}),error:null,...item,
      });
      return this.getOntologyGenerationRun(item.id);
    },
    getOntologyGenerationRun(id) {
      const row=db.prepare(`SELECT id,source_id AS sourceId,task_id AS taskId,mode,scope_json AS scopeJson,catalog_checksum AS catalogChecksum,base_schema_version_id AS baseSchemaVersionId,model_name AS modelName,prompt_version AS promptVersion,scoring_version AS scoringVersion,status,progress,summary_json AS summaryJson,token_usage_json AS tokenUsageJson,error,created_by AS createdBy,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_ontology_generation_run WHERE id=?`).get(id);
      return row?parseOntologyGenerationRun(row):null;
    },
    listOntologyGenerationRuns(sourceId,limit=50,offset=0) {
      return db.prepare(`SELECT id,source_id AS sourceId,task_id AS taskId,mode,scope_json AS scopeJson,catalog_checksum AS catalogChecksum,base_schema_version_id AS baseSchemaVersionId,model_name AS modelName,prompt_version AS promptVersion,scoring_version AS scoringVersion,status,progress,summary_json AS summaryJson,token_usage_json AS tokenUsageJson,error,created_by AS createdBy,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,updated_at AS updatedAt FROM ds_ontology_generation_run WHERE source_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(sourceId,Math.max(1,Math.min(500,Number(limit)||50)),Math.max(0,Number(offset)||0)).map(parseOntologyGenerationRun);
    },
    countOntologyGenerationRuns(sourceId) { return Number(db.prepare(`SELECT COUNT(*) AS count FROM ds_ontology_generation_run WHERE source_id=?`).get(sourceId)?.count||0); },
    transitionOntologyGenerationRun(item) {
      return db.transaction((input)=>{
        const before=this.getOntologyGenerationRun(input.id);
        if(!before||before.status!==input.expectedStatus)return {ok:false,reason:before?"status_conflict":"not_found",run:before};
        const next={
          status:input.status,
          progress:input.progress??before.progress,
          summary:input.summary??before.summary,
          tokenUsage:input.tokenUsage??before.tokenUsage,
          error:input.error??null,
          startedAt:input.startedAt??(input.status==="running"?before.startedAt||new Date().toISOString():before.startedAt),
          finishedAt:input.finishedAt??(["succeeded","failed","cancelled"].includes(input.status)?new Date().toISOString():before.finishedAt),
        };
        const result=db.prepare(`UPDATE ds_ontology_generation_run SET status=@status,progress=@progress,summary_json=@summaryJson,token_usage_json=@tokenUsageJson,error=@error,started_at=@startedAt,finished_at=@finishedAt,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND status=@expectedStatus`).run({...input,...next,summaryJson:JSON.stringify(next.summary),tokenUsageJson:JSON.stringify(next.tokenUsage)});
        return result.changes===1?{ok:true,run:this.getOntologyGenerationRun(input.id)}:{ok:false,reason:"status_conflict",run:this.getOntologyGenerationRun(input.id)};
      }).immediate(item);
    },
    createOntologyCandidate(item) {
      return db.transaction((input)=>{
        const values={
          evidence:[],modelConfidence:null,score:0,scoreBreakdown:{},validation:{ok:false,errors:[],warnings:[]},status:"generated",forcedReviewReasons:[],decisionNote:null,reviewedBy:null,reviewedAt:null,appliedSchemaVersionId:null,supersededById:null,...input,
        };
        db.prepare(`INSERT INTO ds_ontology_candidate(id,run_id,source_id,candidate_type,stable_key,payload_json,evidence_json,model_confidence,score,score_breakdown_json,validation_json,status,forced_review_reasons_json,decision_note,reviewed_by,reviewed_at,applied_schema_version_id,superseded_by_id)
          VALUES(@id,@runId,@sourceId,@candidateType,@stableKey,@payloadJson,@evidenceJson,@modelConfidence,@score,@scoreBreakdownJson,@validationJson,@status,@forcedReviewReasonsJson,@decisionNote,@reviewedBy,@reviewedAt,@appliedSchemaVersionId,@supersededById)`).run({...values,payloadJson:JSON.stringify(values.payload),evidenceJson:JSON.stringify(values.evidence),scoreBreakdownJson:JSON.stringify(values.scoreBreakdown),validationJson:JSON.stringify(values.validation),forcedReviewReasonsJson:JSON.stringify(values.forcedReviewReasons)});
        const created=this.getOntologyCandidate(values.id);
        db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(values.id,values.runId,values.sourceId,values.eventType||"generated",values.actor||null,null,values.status,values.eventNote||null,null,JSON.stringify(created));
        return created;
      }).immediate(item);
    },
    getOntologyCandidate(id) {
      const row=db.prepare(`SELECT id,run_id AS runId,source_id AS sourceId,candidate_type AS candidateType,stable_key AS stableKey,payload_json AS payloadJson,evidence_json AS evidenceJson,model_confidence AS modelConfidence,score,score_breakdown_json AS scoreBreakdownJson,validation_json AS validationJson,status,forced_review_reasons_json AS forcedReviewReasonsJson,decision_note AS decisionNote,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt,applied_schema_version_id AS appliedSchemaVersionId,superseded_by_id AS supersededById,created_at AS createdAt,updated_at AS updatedAt FROM ds_ontology_candidate WHERE id=?`).get(id);
      return row?parseOntologyCandidate(row):null;
    },
    listOntologyCandidates({sourceId=null,runId=null,status=null,candidateType=null,limit=500}={}) {
      return db.prepare(`SELECT id,run_id AS runId,source_id AS sourceId,candidate_type AS candidateType,stable_key AS stableKey,payload_json AS payloadJson,evidence_json AS evidenceJson,model_confidence AS modelConfidence,score,score_breakdown_json AS scoreBreakdownJson,validation_json AS validationJson,status,forced_review_reasons_json AS forcedReviewReasonsJson,decision_note AS decisionNote,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt,applied_schema_version_id AS appliedSchemaVersionId,superseded_by_id AS supersededById,created_at AS createdAt,updated_at AS updatedAt FROM ds_ontology_candidate WHERE (? IS NULL OR source_id=?) AND (? IS NULL OR run_id=?) AND (? IS NULL OR status=?) AND (? IS NULL OR candidate_type=?) ORDER BY score DESC,created_at,id LIMIT ?`).all(sourceId,sourceId,runId,runId,status,status,candidateType,candidateType,Math.max(1,Math.min(2000,Number(limit)||500))).map(parseOntologyCandidate);
    },
    transitionOntologyCandidate(item) {
      return db.transaction((input)=>{
        const before=this.getOntologyCandidate(input.id);
        if(!before||before.status!==input.expectedStatus)return {ok:false,reason:before?"status_conflict":"not_found",candidate:before};
        if(!candidateTransitionAllowed(before.status,input.status))throw new Error(`不允许候选从 ${before.status} 转为 ${input.status}`);
        const next={
          payload:input.payload??before.payload,evidence:input.evidence??before.evidence,modelConfidence:input.modelConfidence??before.modelConfidence,
          score:input.score??before.score,scoreBreakdown:input.scoreBreakdown??before.scoreBreakdown,validation:input.validation??before.validation,
          status:input.status,forcedReviewReasons:input.forcedReviewReasons??before.forcedReviewReasons,decisionNote:input.decisionNote??before.decisionNote,
          reviewedBy:input.reviewedBy??before.reviewedBy,reviewedAt:input.reviewedAt??(input.reviewedBy?new Date().toISOString():before.reviewedAt),
          appliedSchemaVersionId:input.appliedSchemaVersionId??before.appliedSchemaVersionId,supersededById:input.supersededById??before.supersededById,
        };
        const result=db.prepare(`UPDATE ds_ontology_candidate SET payload_json=@payloadJson,evidence_json=@evidenceJson,model_confidence=@modelConfidence,score=@score,score_breakdown_json=@scoreBreakdownJson,validation_json=@validationJson,status=@status,forced_review_reasons_json=@forcedReviewReasonsJson,decision_note=@decisionNote,reviewed_by=@reviewedBy,reviewed_at=@reviewedAt,applied_schema_version_id=@appliedSchemaVersionId,superseded_by_id=@supersededById,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND status=@expectedStatus`).run({...input,...next,payloadJson:JSON.stringify(next.payload),evidenceJson:JSON.stringify(next.evidence),scoreBreakdownJson:JSON.stringify(next.scoreBreakdown),validationJson:JSON.stringify(next.validation),forcedReviewReasonsJson:JSON.stringify(next.forcedReviewReasons)});
        if(result.changes!==1)return {ok:false,reason:"status_conflict",candidate:this.getOntologyCandidate(input.id)};
        const after=this.getOntologyCandidate(input.id);
        db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(before.id,before.runId,before.sourceId,input.eventType||"state_transition",input.actor||null,before.status,after.status,input.note||null,JSON.stringify(before),JSON.stringify(after));
        return {ok:true,candidate:after};
      }).immediate(item);
    },
    mergeOntologyCandidates(item) {
      return db.transaction((input)=>{
        if(input.id===input.intoCandidateId)throw storeConflict("不能将候选合并到自身");
        const before=this.getOntologyCandidate(input.id);const retainedBefore=this.getOntologyCandidate(input.intoCandidateId);
        if(!before||!retainedBefore)throw storeConflict("待合并候选不存在，请刷新后重试");
        if(before.runId!==retainedBefore.runId||Number(before.sourceId)!==Number(retainedBefore.sourceId)||before.candidateType!==retainedBefore.candidateType)throw storeConflict("只能合并同一批次、同一类型的候选");
        const mergeable=new Set(["review_required","auto_confirmed","confirmed"]);
        if(!mergeable.has(before.status)||!mergeable.has(retainedBefore.status))throw storeConflict("当前候选状态不允许合并");
        const evidence=dedupeJsonItems([...(retainedBefore.evidence||[]),...(before.evidence||[])]);
        const retained=db.prepare(`UPDATE ds_ontology_candidate SET evidence_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`).run(JSON.stringify(evidence),retainedBefore.id,retainedBefore.status);
        if(retained.changes!==1)throw storeConflict("保留候选状态已变化，请刷新后重试");
        const merged=db.prepare(`UPDATE ds_ontology_candidate SET status='superseded',superseded_by_id=?,decision_note=COALESCE(?,decision_note),reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`).run(retainedBefore.id,input.note||null,input.actor||null,before.id,before.status);
        if(merged.changes!==1)throw storeConflict("待合并候选状态已变化，请刷新后重试");
        const retainedAfter=this.getOntologyCandidate(retainedBefore.id);const after=this.getOntologyCandidate(before.id);
        db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(retainedBefore.id,retainedBefore.runId,retainedBefore.sourceId,"merge_evidence",input.actor||null,retainedBefore.status,retainedAfter.status,input.note||`合并候选 ${before.id} 的证据`,JSON.stringify(retainedBefore),JSON.stringify(retainedAfter));
        db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(before.id,before.runId,before.sourceId,"merged",input.actor||null,before.status,after.status,input.note||`合并到候选 ${retainedBefore.id}`,JSON.stringify(before),JSON.stringify(after));
        return {candidate:after,retainedCandidate:retainedAfter};
      }).immediate(item);
    },
    listOntologyCandidateEvents(candidateId) {
      return db.prepare(`SELECT id,candidate_id AS candidateId,run_id AS runId,source_id AS sourceId,event_type AS eventType,actor,from_status AS fromStatus,to_status AS toStatus,note,before_json AS beforeJson,after_json AS afterJson,created_at AS createdAt FROM ds_ontology_candidate_event WHERE candidate_id=? ORDER BY id`).all(candidateId).map(parseOntologyCandidateEvent);
    },
    recordOntologyCandidateCalibration(item) {
      return db.transaction((input)=>{
        const candidate=this.getOntologyCandidate(input.candidateId);
        if(!candidate)throw storeConflict("候选不存在，请刷新后重试");
        const calibration={verdict:input.verdict,majorModification:Boolean(input.majorModification),issueType:input.issueType||null,note:input.note||null,labeledBy:input.actor||null,labeledAt:new Date().toISOString()};
        db.prepare(`INSERT INTO ds_ontology_candidate_event(candidate_id,run_id,source_id,event_type,actor,from_status,to_status,note,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(candidate.id,candidate.runId,candidate.sourceId,"calibration_labeled",input.actor||null,candidate.status,candidate.status,input.note||null,JSON.stringify(candidate),JSON.stringify({candidate,calibration}));
        return {candidateId:candidate.id,runId:candidate.runId,sourceId:candidate.sourceId,...calibration};
      }).immediate(item);
    },
    listOntologyCandidateCalibrationLabels(sourceId) {
      const rows=db.prepare(`SELECT id,candidate_id AS candidateId,run_id AS runId,source_id AS sourceId,actor,note,after_json AS afterJson,created_at AS createdAt FROM ds_ontology_candidate_event WHERE source_id=? AND event_type='calibration_labeled' ORDER BY id`).all(sourceId);
      const latest=new Map();
      for(const row of rows){const after=safeJson(row.afterJson,{});const calibration=after?.calibration||{};latest.set(row.candidateId,{candidateId:row.candidateId,runId:row.runId,sourceId:row.sourceId,verdict:calibration.verdict,majorModification:Boolean(calibration.majorModification),issueType:calibration.issueType||null,note:calibration.note??row.note??null,labeledBy:calibration.labeledBy??row.actor??null,labeledAt:calibration.labeledAt??row.createdAt});}
      return [...latest.values()];
    },
    saveOntologyCalibrationGate(item) {
      db.prepare(`INSERT INTO ds_ontology_calibration_gate(id,source_id,run_ids_json,draft_schema_version_id,eval_gate_id,manual_object_count,final_object_count,metrics_json,passed,decision,reason,created_by) VALUES(@id,@sourceId,@runIdsJson,@draftSchemaVersionId,@evalGateId,@manualObjectCount,@finalObjectCount,@metricsJson,@passed,@decision,@reason,@createdBy)`).run({...item,runIdsJson:JSON.stringify(item.runIds||[]),metricsJson:JSON.stringify(item.metrics||{}),draftSchemaVersionId:item.draftSchemaVersionId||null,evalGateId:item.evalGateId||null,manualObjectCount:Number(item.manualObjectCount)||0,finalObjectCount:Number(item.finalObjectCount)||0,passed:item.passed?1:0});
      return this.getOntologyCalibrationGate(item.id);
    },
    getOntologyCalibrationGate(id) {
      const row=db.prepare(`SELECT id,source_id AS sourceId,run_ids_json AS runIdsJson,draft_schema_version_id AS draftSchemaVersionId,eval_gate_id AS evalGateId,manual_object_count AS manualObjectCount,final_object_count AS finalObjectCount,metrics_json AS metricsJson,passed,decision,reason,created_by AS createdBy,created_at AS createdAt,activated_by AS activatedBy,activated_at AS activatedAt FROM ds_ontology_calibration_gate WHERE id=?`).get(id);
      return row?parseOntologyCalibrationGate(row):null;
    },
    listOntologyCalibrationGates(sourceId,limit=20) {
      return db.prepare(`SELECT id,source_id AS sourceId,run_ids_json AS runIdsJson,draft_schema_version_id AS draftSchemaVersionId,eval_gate_id AS evalGateId,manual_object_count AS manualObjectCount,final_object_count AS finalObjectCount,metrics_json AS metricsJson,passed,decision,reason,created_by AS createdBy,created_at AS createdAt,activated_by AS activatedBy,activated_at AS activatedAt FROM ds_ontology_calibration_gate WHERE source_id=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(sourceId,Math.max(1,Math.min(100,Number(limit)||20))).map(parseOntologyCalibrationGate);
    },
    activateOntologyCalibrationGate(id,actor) {
      const result=db.prepare(`UPDATE ds_ontology_calibration_gate SET activated_by=?,activated_at=CURRENT_TIMESTAMP WHERE id=? AND passed=1 AND activated_at IS NULL`).run(actor,id);
      if(result.changes!==1)throw storeConflict("校准门禁不存在、未通过或已经启用");
      return this.getOntologyCalibrationGate(id);
    },
    getSetting: (key) => db.prepare(`SELECT key,value_json AS valueJson,encrypted,updated_by AS updatedBy,updated_at AS updatedAt FROM ds_setting WHERE key=?`).get(key),
    getOntologyDomainPlan(sourceId) { const row=db.prepare(`SELECT source_id AS sourceId,plan_json AS planJson,catalog_checksum AS catalogChecksum,created_by AS createdBy,created_at AS createdAt FROM ds_ontology_domain_plan WHERE source_id=?`).get(sourceId);return row?{...row,plan:safeJson(row.planJson,null)}:null; },
    upsertOntologyDomainPlan({sourceId,planJson,catalogChecksum,createdBy=null}) { db.prepare(`INSERT INTO ds_ontology_domain_plan(source_id,plan_json,catalog_checksum,created_by,created_at) VALUES(@sourceId,@planJson,@catalogChecksum,@createdBy,CURRENT_TIMESTAMP) ON CONFLICT(source_id) DO UPDATE SET plan_json=excluded.plan_json,catalog_checksum=excluded.catalog_checksum,created_by=excluded.created_by,created_at=CURRENT_TIMESTAMP`).run({sourceId,planJson,catalogChecksum,createdBy}); },
    listSettings: () => db.prepare(`SELECT key,value_json AS valueJson,encrypted,updated_by AS updatedBy,updated_at AS updatedAt FROM ds_setting ORDER BY key`).all(),
    upsertSetting({key,valueJson,encrypted=0,updatedBy=null}) { db.prepare(`INSERT INTO ds_setting(key,value_json,encrypted,updated_by,updated_at) VALUES(@key,@valueJson,@encrypted,@updatedBy,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,encrypted=excluded.encrypted,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run({key,valueJson,encrypted:encrypted?1:0,updatedBy}); },
    deleteSetting(key) { return db.prepare(`DELETE FROM ds_setting WHERE key=?`).run(key).changes; },
    getSourceOntologySetting(sourceId) { const row=db.prepare(`SELECT source_id AS sourceId,auto_confirm_score AS autoConfirmScore,evidence_run_ids_json AS evidenceRunIdsJson,updated_by AS updatedBy,updated_at AS updatedAt FROM ds_source_ontology_setting WHERE source_id=?`).get(sourceId);return row?{...row,evidenceRunIds:safeJson(row.evidenceRunIdsJson,[])}:null; },
    updateSourceOntologyAutoConfirmScore({sourceId,autoConfirmScore,evidenceRunIds=[],actor=null}) {
      const score=Number(autoConfirmScore);if(!Number.isInteger(score)||score<0||score>100)throw new Error("autoConfirmScore 必须是 0 到 100 的整数");
      return db.transaction(()=>{const previous=this.getSourceOntologySetting(sourceId);const evidence={runIds:[...new Set(evidenceRunIds.map(String))]};db.prepare(`INSERT INTO ds_source_ontology_setting(source_id,auto_confirm_score,evidence_run_ids_json,updated_by,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_id) DO UPDATE SET auto_confirm_score=excluded.auto_confirm_score,evidence_run_ids_json=excluded.evidence_run_ids_json,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(sourceId,score,JSON.stringify(evidence.runIds),actor);db.prepare(`INSERT INTO ds_source_ontology_setting_audit(source_id,setting_key,old_value_json,new_value_json,evidence_json,actor) VALUES(?,?,?,?,?,?)`).run(sourceId,"autoConfirmScore",previous?JSON.stringify(previous.autoConfirmScore):null,JSON.stringify(score),JSON.stringify(evidence),actor);return this.getSourceOntologySetting(sourceId);})();
    },
    listSourceOntologySettingAudit(sourceId) { return db.prepare(`SELECT id,source_id AS sourceId,setting_key AS settingKey,old_value_json AS oldValueJson,new_value_json AS newValueJson,evidence_json AS evidenceJson,actor,created_at AS createdAt FROM ds_source_ontology_setting_audit WHERE source_id=? ORDER BY id DESC`).all(sourceId).map((row)=>({...row,oldValue:safeJson(row.oldValueJson,null),newValue:safeJson(row.newValueJson,null),evidence:safeJson(row.evidenceJson,{})})); },
    upsertEmbedding(item) { db.prepare(`INSERT INTO ds_embedding(source_id,kind,ref_key,model,dims,text_hash,vector_json,updated_at) VALUES(@sourceId,@kind,@refKey,@model,@dims,@textHash,@vectorJson,CURRENT_TIMESTAMP) ON CONFLICT(source_id,kind,ref_key) DO UPDATE SET model=excluded.model,dims=excluded.dims,text_hash=excluded.text_hash,vector_json=excluded.vector_json,updated_at=CURRENT_TIMESTAMP`).run(item); },
    getEmbedding(sourceId,kind,refKey) { return db.prepare(`SELECT source_id AS sourceId,kind,ref_key AS refKey,model,dims,text_hash AS textHash,updated_at AS updatedAt FROM ds_embedding WHERE source_id=? AND kind=? AND ref_key=?`).get(sourceId,kind,refKey); },
    listEmbeddings(sourceId,model) { return db.prepare(`SELECT kind,ref_key AS refKey,model,dims,text_hash AS textHash,vector_json AS vectorJson FROM ds_embedding WHERE source_id=? AND model=?`).all(sourceId,model).map((row)=>({...row,vector:safeJson(row.vectorJson,null)})); },
    deleteEmbedding(sourceId,kind,refKey) { return db.prepare(`DELETE FROM ds_embedding WHERE source_id=? AND kind=? AND ref_key=?`).run(sourceId,kind,refKey).changes; },
    deleteEmbeddingsNotIn(sourceId,kind,refKeys) { const keep=new Set(refKeys);const rows=db.prepare(`SELECT ref_key AS refKey FROM ds_embedding WHERE source_id=? AND kind=?`).all(sourceId,kind);let removed=0;for(const row of rows)if(!keep.has(row.refKey))removed+=db.prepare(`DELETE FROM ds_embedding WHERE source_id=? AND kind=? AND ref_key=?`).run(sourceId,kind,row.refKey).changes;return removed; },
    countEmbeddings(sourceId,model) { return Number(db.prepare(`SELECT COUNT(*) AS count FROM ds_embedding WHERE source_id=? AND model=?`).get(sourceId,model).count||0); },
    finishSchemaRefresh(sourceId,schema,relationKeys=[]) {
      const tableNames=new Set(schema.tables.map((item)=>item.tableName));
      const columns=new Set(schema.columns.map((item)=>`${item.tableName}.${item.columnName}`));
      const relations=new Set(relationKeys);
      db.transaction(()=>{
        const knownTables=db.prepare(`SELECT table_name AS tableName FROM ds_table WHERE source_id=?`).all(sourceId);
        for(const table of knownTables) db.prepare(`UPDATE ds_table SET present=?,active=CASE WHEN ?=1 THEN active ELSE 0 END WHERE source_id=? AND table_name=?`).run(tableNames.has(table.tableName)?1:0,tableNames.has(table.tableName)?1:0,sourceId,table.tableName);
        const knownColumns=db.prepare(`SELECT table_name AS tableName,column_name AS columnName FROM ds_column WHERE source_id=?`).all(sourceId);
        for(const column of knownColumns) db.prepare(`UPDATE ds_column SET present=? WHERE source_id=? AND table_name=? AND column_name=?`).run(columns.has(`${column.tableName}.${column.columnName}`)?1:0,sourceId,column.tableName,column.columnName);
        const knownProfiles=db.prepare(`SELECT table_name AS tableName,column_name AS columnName FROM ds_column_profile WHERE source_id=?`).all(sourceId);
        for(const profile of knownProfiles)if(!columns.has(`${profile.tableName}.${profile.columnName}`))db.prepare(`DELETE FROM ds_column_profile WHERE source_id=? AND table_name=? AND column_name=?`).run(sourceId,profile.tableName,profile.columnName);
        const knownRelations=db.prepare(`SELECT id,from_table AS fromTable,from_col AS fromCol,to_table AS toTable,to_col AS toCol,inference_source AS inferenceSource,status FROM ds_relation WHERE source_id=?`).all(sourceId);
        for(const relation of knownRelations) { const key=`${relation.fromTable}.${relation.fromCol}>${relation.toTable}.${relation.toCol}`;const documentStillValid=relation.inferenceSource==="document"&&["review","confirmed","denied"].includes(relation.status)&&columns.has(`${relation.fromTable}.${relation.fromCol}`)&&columns.has(`${relation.toTable}.${relation.toCol}`);db.prepare(`UPDATE ds_relation SET present=? WHERE id=?`).run(relations.has(key)||documentStillValid?1:0,relation.id); }
      })();
    },
  };
}

function parseKnowledge(row) {
  const {tablesJson,contractJson,...page}=row;
  const contract=safeJson(contractJson,null);
  return {...page,aliases:safeJson(row.aliases,[]),tables:safeJson(tablesJson,[]),verified:Boolean(row.verified),...(contract&&typeof contract==="object"?{contract}:{})};
}

function parseRelationDoc(row) { const {assertionsJson,...doc}=row;return {...doc,assertions:safeJson(assertionsJson,[])}; }

function parseTask(row) { const {payloadJson,resultJson,...task}=row;return {...task,payload:safeJson(payloadJson,{}),result:safeJson(resultJson,null)}; }

function parseQueryMessage(row) {
  const {contentJson,auditToolTraceJson,...message}=row;
  let content=safeJson(contentJson,{});
  const parsedTrace=safeJson(auditToolTraceJson,[]);const toolTrace=Array.isArray(parsedTrace)?parsedTrace:[];
  if(toolTrace.length) content=content.evidence?{...content,evidence:{...content.evidence,toolTrace}}:{...content,toolTrace};
  return {...message,content};
}

function conversationTitle(question) { const text=String(question||"").trim().replace(/\s+/g," ");const chars=[...text];return chars.length>40?`${chars.slice(0,40).join("")}…`:text||"新问数会话"; }

function parseOntologySchemaVersion(row,includeSchema=true) {
  const {schemaJson,validationJson,...record}=row;
  return {...record,...(includeSchema&&schemaJson?{schema:safeJson(schemaJson,{})}:{}),validation:safeJson(validationJson,{ok:false,errors:[],warnings:[]})};
}

function parseOntologyGenerationRun(row) {
  const {scopeJson,summaryJson,tokenUsageJson,...run}=row;
  return {...run,scope:safeJson(scopeJson,{}),summary:safeJson(summaryJson,{}),tokenUsage:safeJson(tokenUsageJson,{})};
}

function parseOntologyCandidate(row) {
  const {payloadJson,evidenceJson,scoreBreakdownJson,validationJson,forcedReviewReasonsJson,...candidate}=row;
  return {...candidate,payload:safeJson(payloadJson,{}),evidence:safeJson(evidenceJson,[]),scoreBreakdown:safeJson(scoreBreakdownJson,{}),validation:safeJson(validationJson,{ok:false,errors:[],warnings:[]}),forcedReviewReasons:safeJson(forcedReviewReasonsJson,[])};
}

function parseOntologyCandidateEvent(row) {
  const {beforeJson,afterJson,...event}=row;
  return {...event,before:safeJson(beforeJson,null),after:safeJson(afterJson,null)};
}

function parseOntologyCalibrationGate(row) {
  const {runIdsJson,metricsJson,...gate}=row;
  return {...gate,passed:Boolean(gate.passed),runIds:safeJson(runIdsJson,[]),metrics:safeJson(metricsJson,{})};
}

function parseTermAnchor(row) {
  const {altLabelsJson,...anchor}=row;
  return {...anchor,altLabels:safeJson(altLabelsJson,[])};
}

function parseQuestionRow(row) {
  if(!row)return null;
  return {...row,options:parseQuestionOptions(row.options)};
}

function parseQuestionOptions(value) {
  const parsed=typeof value==="string"?safeJson(value,null):value;
  if(!Array.isArray(parsed)||!parsed.length||parsed.length>100)return [];
  const options=[];
  for(const item of parsed) {
    if(typeof item!=="string")return [];
    const option=item.trim();
    if(!option||option.length>200)return [];
    if(!options.includes(option))options.push(option);
  }
  return options;
}

function candidateTransitionAllowed(from,to) {
  const transitions={
    generated:new Set(["blocked","auto_confirmed","review_required"]),
    review_required:new Set(["confirmed","rejected","superseded"]),
    auto_confirmed:new Set(["review_required","superseded","applied"]),
    confirmed:new Set(["superseded","applied"]),
    blocked:new Set(),rejected:new Set(),superseded:new Set(),applied:new Set(),
  };
  return transitions[from]?.has(to)===true;
}

function storeConflict(message) { const error=new Error(message);error.status=409;return error; }
function dedupeJsonItems(items) { const seen=new Set();return items.filter((item)=>{const key=JSON.stringify(item);if(seen.has(key))return false;seen.add(key);return true;}); }
function safeJson(value,fallback) { try{return JSON.parse(value);}catch{return fallback;} }
