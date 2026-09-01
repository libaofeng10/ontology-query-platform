import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { createSettingsService } from "../src/settings-service.mjs";
import { QUERY_PROMPT_DEFAULTS } from "../src/query-prompts.mjs";

const BASE_CONFIG={
  llm:{baseUrl:"https://env-llm.example/v1",apiKey:"env-llm-key",model:"env-model"},
  embedding:{baseUrl:"",apiKey:"",model:"",dimensions:null},
  retrieval:{vectorEnabled:true,topK:8,vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55},
  discovery:{enumMaxDistinctRatio:0.05,labelDictionaryMaxRows:20},
  ontologyAi:{mode:"off",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000},
  semanticQueryPlanMode:"off",queryAgentMode:"off",queryAgentTrafficPercent:100,queryAgentMaxIterations:8,queryAgentMaxSqlCalls:5,queryAgentMaxScannedRows:5_000_000,queryAgentPendingTtlMs:600_000,queryMaxRows:500,explainMaxRows:1_000_000,queryTimeoutMs:30_000,queryLlmTimeoutMs:90_000,
};

async function createFixture(lockedKeys=[]) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-settings-"));
  const store=createStore(join(root,"store.sqlite"));
  const settings=createSettingsService({store,baseConfig:structuredClone(BASE_CONFIG),appSecret:"settings-test-secret",lockedKeys});
  return {store,settings};
}

test("settings fall back to env defaults and update hot-reloads getters",async()=>{
  const {store,settings}=await createFixture();
  try {
    assert.equal(settings.config.llm.model,"env-model");
    assert.equal(settings.config.queryMaxRows,500);
    assert.equal(settings.publicView().sources["llm.model"],"default");
    assert.equal(settings.config.prompts.agentSystem,QUERY_PROMPT_DEFAULTS.agentSystem);
    assert.equal(settings.publicView().sources["prompts.agentSystem"],"default");
    assert.deepEqual(settings.publicView().promptMeta.agentQuestion.variables,["context"]);
    const view=settings.update({llm:{model:"qwen-plus"},retrieval:{vectorWeight:0.6},query:{queryMaxRows:200,semanticQueryPlanMode:"prefer",queryAgentMode:"prefer",queryAgentTrafficPercent:10}},"admin-user");
    assert.equal(settings.config.llm.model,"qwen-plus");
    assert.equal(settings.config.retrieval.vectorWeight,0.6);
    assert.equal(settings.config.queryMaxRows,200);
    assert.equal(settings.config.semanticQueryPlanMode,"prefer");
    assert.equal(settings.config.queryAgentMode,"prefer");
    assert.equal(settings.config.queryAgentTrafficPercent,10);
    settings.update({ontologyAi:{mode:"review",autoConfirmScore:81}});
    assert.equal(settings.config.ontologyAi.mode,"review");
    assert.equal(settings.config.ontologyAi.autoConfirmScore,81);
    assert.equal(view.sources["llm.model"],"db");
    assert.equal(view.sources["llm.baseUrl"],"default");
  } finally { store.close(); }
});

test("query prompts persist, hot-reload, validate variables, and reset to defaults",async()=>{
  const {store,settings}=await createFixture();
  try {
    const custom=`自定义 Agent 任务\n{{context}}`;
    const view=settings.update({prompts:{agentQuestion:custom}},"admin-user");
    assert.equal(settings.config.prompts.agentQuestion,custom);
    assert.equal(view.prompts.agentQuestion,custom);
    assert.equal(view.sources["prompts.agentQuestion"],"db");
    assert.equal(JSON.parse(store.getSetting("prompts.agentQuestion").valueJson),custom);
    assert.throws(()=>settings.update({prompts:{agentQuestion:"缺少上下文变量"}}),/缺少必需变量.*\{\{context\}\}/);
    assert.throws(()=>settings.update({prompts:{agentQuestion:"{{context}} {{unknown}}"}}),/包含未知变量.*unknown/);
    settings.update({prompts:{agentQuestion:null}});
    assert.equal(settings.config.prompts.agentQuestion,QUERY_PROMPT_DEFAULTS.agentQuestion);
    assert.equal(settings.publicView().sources["prompts.agentQuestion"],"default");
    assert.equal(store.getSetting("prompts.agentQuestion"),undefined);
  } finally { store.close(); }
});

test("secret settings are encrypted at rest and masked in the public view",async()=>{
  const {store,settings}=await createFixture();
  try {
    settings.update({llm:{apiKey:"sk-super-secret-abcd"}},"admin-user");
    const row=store.getSetting("llm.apiKey");
    assert.equal(row.encrypted,1);
    assert.ok(!row.valueJson.includes("sk-super-secret-abcd"));
    assert.equal(settings.config.llm.apiKey,"sk-super-secret-abcd");
    const view=settings.publicView();
    assert.deepEqual(view.llm.apiKey,{set:true,masked:"****abcd"});
    assert.deepEqual(view.embedding.apiKey,{set:false});
  } finally { store.close(); }
});

test("empty secret keeps the stored value and null clears back to env",async()=>{
  const {store,settings}=await createFixture();
  try {
    settings.update({llm:{apiKey:"sk-first",model:"custom-model"}});
    settings.update({llm:{apiKey:""}});
    assert.equal(settings.config.llm.apiKey,"sk-first");
    settings.update({llm:{model:null}});
    assert.equal(settings.config.llm.model,"env-model");
    assert.equal(settings.publicView().sources["llm.model"],"default");
    assert.equal(store.getSetting("llm.model"),undefined);
  } finally { store.close(); }
});

test("invalid values are rejected with a chinese error and nothing is written",async()=>{
  const {store,settings}=await createFixture();
  try {
    assert.throws(()=>settings.update({retrieval:{vectorWeight:1.5}}),/vectorWeight 必须在 0 和 1 之间/);
    assert.throws(()=>settings.update({retrieval:{topK:0}}),/topK 必须是 1 到 50 的整数/);
    assert.throws(()=>settings.update({query:{semanticQueryPlanMode:"maybe"}}),/必须是 off、prefer、required 之一/);
    assert.throws(()=>settings.update({query:{queryAgentMaxIterations:1}}),/必须是 2 到 20 的整数/);
    assert.throws(()=>settings.update({query:{queryAgentTrafficPercent:101}}),/必须是 0 到 100 的整数/);
    assert.throws(()=>settings.update({query:{queryAgentPendingTtlMs:999}}),/必须是 1000 到 3600000 的整数/);
    assert.throws(()=>settings.update({llm:{baseUrl:"ftp://bad"}}),/必须是 http\(s\) 地址/);
    assert.throws(()=>settings.update({ontologyAi:{mode:"publish"}}),/必须是 off、review、auto_draft 之一/);
    assert.throws(()=>settings.update({ontologyAi:{autoConfirmScore:101}}),/必须是 0 到 100 的整数/);
    assert.throws(()=>settings.update({llm:{unknown:"x"}}),/未知设置项/);
    assert.throws(()=>settings.update({prompts:{unknown:"x"}}),/未知设置项/);
    assert.equal(store.listSettings().length,0);
  } finally { store.close(); }
});

test("keys locked by createApp overrides ignore db values and refuse updates",async()=>{
  const {store,settings}=await createFixture(["llm.model"]);
  try {
    assert.throws(()=>settings.update({llm:{model:"other"}}),/由启动参数固定/);
    assert.equal(settings.config.llm.model,"env-model");
    assert.equal(settings.publicView().sources["llm.model"],"override");
    settings.update({llm:{baseUrl:"https://db-llm.example/v1"}});
    assert.equal(settings.config.llm.baseUrl,"https://db-llm.example/v1");
  } finally { store.close(); }
});

test("label dictionary row cap is an online-editable discovery setting",async()=>{
  const {store,settings}=await createFixture();
  try {
    assert.equal(settings.config.discovery.labelDictionaryMaxRows,20);
    assert.equal(settings.publicView().discovery.labelDictionaryMaxRows,20);
    settings.update({discovery:{labelDictionaryMaxRows:100}},"admin-user");
    assert.equal(settings.config.discovery.labelDictionaryMaxRows,100);
    assert.equal(settings.publicView().sources["discovery.labelDictionaryMaxRows"],"db");
    assert.throws(()=>settings.update({discovery:{labelDictionaryMaxRows:0}},"admin-user"),/labelDictionaryMaxRows/);
    settings.update({discovery:{labelDictionaryMaxRows:null}},"admin-user");
    assert.equal(settings.config.discovery.labelDictionaryMaxRows,20);
  } finally { store.close(); }
});
