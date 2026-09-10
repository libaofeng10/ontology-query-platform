import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { createSettingsService } from "../src/settings-service.mjs";

const BASE_CONFIG={
  llm:{baseUrl:"https://env-llm.example/v1",apiKey:"env-llm-key",model:"env-model"},
  embedding:{baseUrl:"",apiKey:"",model:"",dimensions:null},
  retrieval:{vectorEnabled:true,vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55},
  discovery:{enumMaxDistinctRatio:0.05,labelDictionaryMaxRows:20},
  claudeQuery:{mode:"off",trafficPercent:0,binary:"/app/node_modules/.bin/claude",model:"",promptVersion:"claude-query-v1",timeoutMs:120_000,maxTurns:12,maxBudgetUsd:1,maxConcurrency:2,queueTimeoutMs:5_000,maxStdioBytes:2*1024*1024},
  ontologyAi:{mode:"off",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000},
  queryMaxSqlCalls:5,queryMaxScannedRows:5_000_000,queryPendingTtlMs:600_000,queryMaxRows:500,explainMaxRows:1_000_000,queryTimeoutMs:30_000,queryLlmTimeoutMs:90_000,
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
    assert.equal(settings.config.claudeQuery.maxTurns,12);
    assert.equal(settings.publicView().sources["llm.model"],"default");
    const view=settings.update({llm:{model:"qwen-plus"},retrieval:{vectorWeight:0.6},query:{queryMaxRows:200},claudeQuery:{maxTurns:20,maxBudgetUsd:2}},"admin-user");
    assert.equal(settings.config.llm.model,"qwen-plus");
    assert.equal(settings.config.retrieval.vectorWeight,0.6);
    assert.equal(settings.config.queryMaxRows,200);
    assert.equal(settings.config.claudeQuery.maxTurns,20);
    assert.equal(settings.config.claudeQuery.maxBudgetUsd,2);
    settings.update({ontologyAi:{mode:"review",autoConfirmScore:81}});
    assert.equal(settings.config.ontologyAi.mode,"review");
    assert.equal(settings.config.ontologyAi.autoConfirmScore,81);
    assert.equal(view.sources["llm.model"],"db");
    assert.equal(view.sources["llm.baseUrl"],"default");
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
    assert.throws(()=>settings.update({retrieval:{topK:0}}),/未知设置项 retrieval.topK/);
    assert.throws(()=>settings.update({query:{queryMaxSqlCalls:0}}),/必须是 1 到 10 的整数/);
    assert.throws(()=>settings.update({query:{queryPendingTtlMs:999}}),/必须是 1000 到 3600000 的整数/);
    assert.throws(()=>settings.update({llm:{baseUrl:"ftp://bad"}}),/必须是 http\(s\) 地址/);
    assert.throws(()=>settings.update({ontologyAi:{mode:"publish"}}),/必须是 off、review、auto_draft 之一/);
    assert.throws(()=>settings.update({claudeQuery:{mode:"maybe"}}),/未知设置项 claudeQuery.mode/);
    assert.throws(()=>settings.update({claudeQuery:{maxBudgetUsd:101}}),/必须在 0 和 100 之间/);
    assert.throws(()=>settings.update({claudeQuery:{binary:"/tmp/other"}}),/由部署配置固定/);
    assert.throws(()=>settings.update({ontologyAi:{autoConfirmScore:101}}),/必须是 0 到 100 的整数/);
    assert.throws(()=>settings.update({llm:{unknown:"x"}}),/未知设置项/);
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

test("deployment-owned Claude path and prompt version ignore stale settings rows",async()=>{
  const {store,settings}=await createFixture();
  try {
    store.upsertSetting({key:"claudeQuery.binary",valueJson:JSON.stringify("/tmp/attacker"),encrypted:0,updatedBy:"test"});
    store.upsertSetting({key:"claudeQuery.model",valueJson:JSON.stringify("claude-attacker-model"),encrypted:0,updatedBy:"test"});
    store.upsertSetting({key:"claudeQuery.promptVersion",valueJson:JSON.stringify("forged"),encrypted:0,updatedBy:"test"});
    settings.reload();
    assert.equal(settings.config.claudeQuery.binary,"/app/node_modules/.bin/claude");
    assert.equal(settings.config.claudeQuery.promptVersion,"claude-query-v1");
    assert.notEqual(settings.publicView().sources["claudeQuery.binary"],"db");
    for (const key of ["claudeQuery.binary","claudeQuery.model","claudeQuery.promptVersion"]) {
      assert.equal(store.getSetting(key),undefined);
    }
    assert.throws(()=>settings.update({claudeQuery:{binary:"/tmp/other"}}),/由部署配置固定/);
    assert.throws(()=>settings.update({claudeQuery:{model:"claude-other"}}),/由部署配置固定/);
  } finally { store.close(); }
});

test("startup removes retired settings without changing active budgets, secrets or migration markers",async()=>{
  const {store,settings}=await createFixture();
  try {
    settings.update({llm:{apiKey:"sk-preserve-me"},query:{queryMaxSqlCalls:5},claudeQuery:{maxTurns:15}});
    const secret=store.getSetting("llm.apiKey").valueJson;
    store.upsertSetting({key:"retrieval.topK",valueJson:"12"});
    store.upsertSetting({key:"system.enumDictionaryRuleVersion",valueJson:"3"});
    const restarted=createSettingsService({store,baseConfig:BASE_CONFIG,appSecret:"settings-test-secret"});
    assert.equal(store.getSetting("retrieval.topK"),undefined);
    assert.equal(Object.hasOwn(restarted.config.retrieval,"topK"),false);
    assert.equal(Object.hasOwn(restarted.publicView().retrieval,"topK"),false);
    assert.equal(restarted.publicView().sources["retrieval.topK"],undefined);
    assert.equal(restarted.config.queryMaxSqlCalls,5);
    assert.equal(restarted.config.llm.apiKey,"sk-preserve-me");
    assert.equal(store.getSetting("llm.apiKey").valueJson,secret);
    assert.equal(store.getSetting("system.enumDictionaryRuleVersion").valueJson,"3");
    assert.throws(()=>restarted.update({llm:{model:"not-written"},retrieval:{topK:8}}),/未知设置项 retrieval.topK/);
    assert.equal(store.getSetting("llm.model"),undefined);
    assert.throws(()=>restarted.update({llm:{model:"not-written"},retiredGroup:{enabled:true}}),/未知设置分组 retiredGroup/);
    assert.equal(store.getSetting("llm.model"),undefined);
  } finally {store.close();}
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

test("retiring Agent setting names preserves saved budgets without overwriting newer values",async()=>{
  const {store}=await createFixture();
  try {
    store.upsertSetting({key:"query.queryAgentMaxSqlCalls",valueJson:"2",updatedBy:"editor"});
    store.upsertSetting({key:"query.queryAgentMaxScannedRows",valueJson:"300",updatedBy:"editor"});
    store.upsertSetting({key:"query.queryMaxScannedRows",valueJson:"200",updatedBy:"admin"});
    store.upsertSetting({key:"query.queryAgentPendingTtlMs",valueJson:"5000",updatedBy:"editor"});
    for(let attempt=0;attempt<2;attempt++) {
      const migrated=createSettingsService({store,baseConfig:BASE_CONFIG,appSecret:"settings-test-secret"});
      assert.equal(migrated.config.queryMaxSqlCalls,2);
      assert.equal(migrated.config.queryMaxScannedRows,200);
      assert.equal(migrated.config.queryPendingTtlMs,5000);
      assert.equal(store.getSetting("query.queryMaxSqlCalls").updatedBy,"editor");
      assert.equal(store.getSetting("query.queryAgentMaxSqlCalls"),undefined);
    }
  } finally {store.close();}
});
