import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityGapService, _internal } from "../src/capability-gap-service.mjs";
import { createStore } from "../src/store.mjs";

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-gaps-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"gaps",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:100,grade:"A",active:1,comment:"线索"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"is_win_order",dataType:"tinyint",isSensitive:0,comment:"是否成单"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"order_time",dataType:"datetime",isSensitive:0,comment:"成单时间"});
  return {store,source};
}

function metricRefusalIntent(sourceText) {
  return JSON.stringify({version:"2.0",ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",message:`比例指标“${sourceText}”缺少已验证的分子、分母和去重口径`,blocking:true,sourceText}]});
}

test("gap aggregation groups repeated metric refusals and caps sample questions at 3",async()=>{
  const {store,source}=await createFixture();
  try {
    for(const question of ["查询成交率","上月成交率是多少","按渠道看成交率","成交率趋势"])
      store.addAudit({userName:"analyst",sourceId:source.id,question,verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("成交率")});
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询已通过的问题",verdict:"passed"});
    const service=createCapabilityGapService({store});
    const {gaps,auditWindow}=service.listGaps(source.id);
    assert.equal(auditWindow,4);
    assert.equal(gaps.length,1);
    assert.equal(gaps[0].code,"MEASURE_DEFINITION_REQUIRED");
    assert.equal(gaps[0].assetLabel,"成交率");
    assert.equal(gaps[0].count,4);
    assert.equal(gaps[0].sampleQuestions.length,3);
    assert.equal(gaps[0].status,"open");
    assert.deepEqual(gaps[0].remedy,{action:"create_metric_page",prefill:{pageType:"metric",title:"成交率"}});
  } finally { store.close(); }
});

test("degraded path merges intent-less audits that differ only in literals",async()=>{
  const {store,source}=await createFixture();
  try {
    for(const reason of [
      '找不到"线索"主表 crm_lead_2024，共扫描 120 张表',
      '找不到"商机线索"主表 crm_lead_2025，共扫描 121 张表',
      '找不到"新线索"主表 legacy_leads，共扫描 98 张表',
    ])
      store.addAudit({userName:"analyst",sourceId:source.id,question:`按线索统计（${reason.slice(0,6)}）`,verdict:"failed",failReason:reason,failureClass:"schema_gap"});
    const service=createCapabilityGapService({store});
    const {gaps}=service.listGaps(source.id);
    assert.equal(gaps.length,1,JSON.stringify(gaps.map((gap)=>gap.key)));
    assert.equal(gaps[0].count,3);
    assert.equal(gaps[0].code,"CLASS:schema_gap");
    // Fingerprints group; display keeps the raw questions.
    assert.equal(gaps[0].sampleQuestions.length,3);
  } finally { store.close(); }
});

test("llm_unconfigured rows always take the degraded path and get a configure remedy",async()=>{
  const {store,source}=await createFixture();
  try {
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询成交率",verdict:"refused",failReason:"真实数据源已连接，但 LLM 配置不可用：未配置 LLM_BASE_URL。",failureClass:"llm_unconfigured"});
    const {gaps}=createCapabilityGapService({store}).listGaps(source.id);
    assert.equal(gaps.length,1);
    assert.equal(gaps[0].assetLabel,"LLM 未配置");
    assert.deepEqual(gaps[0].remedy,{action:"configure_llm"});
    assert.equal(gaps[0].status,"open");
  } finally { store.close(); }
});

test("a verified metric page with a matching alias resolves the gap on the next read",async()=>{
  const {store,source}=await createFixture();
  try {
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询成交率",verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("成交率")});
    const service=createCapabilityGapService({store});
    assert.equal(service.listGaps(source.id).gaps[0].status,"open");

    store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"clue-win-rate",title:"线索成交率",aliases:'["成交率"]',tablesJson:'["crm_clue"]',content:"成单线索数除以全部线索数",sqlContent:"COUNT(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END) / COUNT(DISTINCT clue_id) 按 order_time 归属",antiExamples:"",verified:1,owner:"editor"});
    const after=service.listGaps(source.id).gaps[0];
    assert.equal(after.status,"resolved");
    // resolved gaps sort after open ones
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询回款率",verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("回款率")});
    const {gaps}=service.listGaps(source.id);
    assert.deepEqual(gaps.map((gap)=>[gap.assetLabel,gap.status]),[["回款率","open"],["成交率","resolved"]]);
  } finally { store.close(); }
});

test("fail reason fingerprints strip literals, numbers and table tokens",()=>{
  const first=_internal.failReasonFingerprint('找不到"线索"主表 crm_lead_2024，共扫描 120 张表');
  const second=_internal.failReasonFingerprint('找不到"商机线索"主表 crm_lead_x，共扫描 3 张表');
  assert.equal(first,second);
  assert.doesNotMatch(first,/crm_lead|120|线索/);
});
