import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeIntentConcepts } from "../src/knowledge-concepts.mjs";

const COLUMNS={
  alpha_crm_clue:[
    {columnName:"id",dataType:"bigint",isPrimary:1},
    {columnName:"clue_create_time",dataType:"datetime"},
    {columnName:"source_data_channel",dataType:"tinyint"},
  ],
  alpha_clue_order_rel:[
    {columnName:"crm_clue_id",dataType:"bigint"},
    {columnName:"is_deleted",dataType:"tinyint"},
    {columnName:"order_time",dataType:"datetime"},
  ],
};

const RATIO_SQL="COUNT(DISTINCT CASE WHEN alpha_clue_order_rel.is_deleted = 0 THEN alpha_clue_order_rel.crm_clue_id END) / COUNT(DISTINCT alpha_crm_clue.id)";

function metricPage(overrides={}) {
  return {
    pageType:"metric",slug:"rate",title:"成交率",aliases:["成交率"],
    tables:["alpha_crm_clue","alpha_clue_order_rel"],
    content:"分母是进线的唯一线索，分子是其中成单的唯一线索。",
    sqlContent:RATIO_SQL,verified:true,owner:"editor-a",
    ...overrides,
  };
}

function conceptFor(page,columns=COLUMNS) { return knowledgeIntentConcepts([page],columns)[0]; }

test("a definition naming its own period column derives the role from that column, not from keyword counts",()=>{
  // Regression on the production failure: the prose mentions both 进线 and 成单, so
  // keyword counting cannot decide. The named column is verifiable evidence.
  const concept=conceptFor(metricPage({content:"分母是统计周期内进入的唯一线索，分子是其中成单的唯一线索。统计周期固定绑定线索进线时间 alpha_crm_clue.clue_create_time。"}));
  assert.equal(concept.timeRole,"entry");
  assert.equal(concept.timeRoleDerivation.status,"inferred");
  assert.equal(concept.timeRoleDerivation.reason,"period_column_named");
  assert.equal(concept.timeRoleDerivation.periodColumn,"alpha_crm_clue.clue_create_time");
  assert.equal(concept.metricDefinition.periodColumn,"alpha_crm_clue.clue_create_time");
  assert.equal(concept.metricDefinition.timeRole,"entry");
});

test("multiple prose roles with no named column report undetermined and carry their candidates",()=>{
  const concept=conceptFor(metricPage());
  assert.equal(concept.timeRole,null);
  assert.equal(concept.timeRoleDerivation.status,"undetermined");
  assert.deepEqual(concept.timeRoleDerivation.candidates,["entry","completion"]);
  assert.equal(concept.timeRoleDerivation.source,"metric:rate");
});

test("undetermined is not the same as not_applicable",()=>{
  // A definition mentioning no business event time at all must stay silent rather
  // than manufacture an ambiguity the operator cannot act on.
  const concept=conceptFor(metricPage({content:"分子与分母都取全量唯一线索。",sqlContent:"COUNT(DISTINCT alpha_crm_clue.id) / COUNT(DISTINCT alpha_crm_clue.id)"}));
  assert.equal(concept.timeRoleDerivation.status,"not_applicable");
  assert.equal(concept.timeRole,null);
});

test("an explicit contract outranks prose and records itself as declared",()=>{
  const concept=conceptFor(metricPage({contract:{timeRole:"entry",periodColumn:"alpha_crm_clue.clue_create_time",grain:"clue"}}));
  assert.equal(concept.timeRoleDerivation.status,"declared");
  assert.equal(concept.timeRole,"entry");
  assert.equal(concept.grainDerivation.status,"declared");
  assert.equal(concept.grain,"clue");
});

test("an unknown role in a contract is ignored rather than trusted",()=>{
  const concept=conceptFor(metricPage({contract:{timeRole:"not_a_role"}}));
  assert.notEqual(concept.timeRoleDerivation.status,"declared");
});

test("grain resolves through qualified column names",()=>{
  // `\b` never fires between a table prefix and the token, so `alpha_crm_clue.id`
  // used to fall through to null and lose the page's declared grain.
  const concept=conceptFor(metricPage({content:"分母是唯一线索。",sqlContent:"COUNT(DISTINCT alpha_crm_clue.id)"}));
  assert.equal(concept.grain,"clue");
  assert.equal(concept.grainDerivation.status,"inferred");
});
