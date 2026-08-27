import assert from "node:assert/strict";
import test from "node:test";
import { createKnowledgeProposalService, _internal } from "../src/knowledge-proposal-service.mjs";
import { knowledgeIntentConcepts } from "../src/query-intent.mjs";

const COLUMNS_BY_TABLE={
  crm_clue:[
    {columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"},
    {columnName:"is_win_order",dataType:"tinyint",isSensitive:0,comment:"是否成单"},
    {columnName:"order_time",dataType:"datetime",isSensitive:0,comment:"成单时间"},
    {columnName:"create_time",dataType:"datetime",isSensitive:0,comment:"创建时间"},
    {columnName:"owner_cell",dataType:"varchar(32)",isSensitive:1,comment:"负责人手机号"},
  ],
};

function contextFixture() {
  return {
    tables:[{tableName:"crm_clue"}],
    columns:COLUMNS_BY_TABLE,
    relations:[],
    retrieval:{diagnostics:{facets:[{key:"measure:win_rate",kind:"measure",required:true,executionTables:["crm_clue"],bindingTables:[]}]}},
    parseOptions:{concepts:[],filterConcepts:[],rowDomainConcepts:[],protectedTermAliases:[]},
  };
}

test("composeDraftPage renders a page whose formula round-trips through knowledgeIntentConcepts",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  const draft=_internal.composeDraftPage({
    table:"crm_clue",
    numerator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[{column:"is_win_order",operator:"=",value:1}]},
    denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},
    timeColumn:"order_time",
  },{sourceId:1,assetLabel:"成交率",shortlist});
  assert.ok(draft);
  assert.match(draft.page.sqlContent,/COUNT\(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END\) \/ COUNT\(DISTINCT clue_id\)/);
  const concept=knowledgeIntentConcepts([{...draft.page,verified:true,owner:"o"}],COLUMNS_BY_TABLE)[0];
  assert.equal(concept.aggregation,"ratio");
  assert.equal(concept.timeRole,"completion");
  const formula=concept.metricDefinition.formula;
  assert.ok(formula);
  assert.equal(formula.numerator.predicateBinding,"physical");
  assert.deepEqual(formula.numerator.predicates,[{column:"crm_clue.is_win_order",operator:"=",valueType:"number",value:"1"}]);
  const verdict=_internal.validateDraftPage(draft,{question:"查询成交率",context:contextFixture()});
  assert.equal(verdict.ok,true,verdict.reason);
});

test("unknown columns, bad operators and time literals are rejected at composition",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  const base={denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},timeColumn:"order_time"};
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"ghost_column",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"clue_id",predicates:[{column:"is_win_order",operator:"LIKE",value:"1"}]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"clue_id",predicates:[{column:"order_time",operator:">",value:"2026-01-01"}]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"ghost_table",numerator:{aggregation:"count",column:"clue_id",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  // The sensitive column is not in the shortlist column whitelist either.
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"owner_cell",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
});

test("a hand-written OR predicate fails validation even if composition is bypassed",()=>{
  const draft={
    slug:"cheat",timeColumn:"order_time",table:"crm_clue",
    page:{pageType:"metric",slug:"cheat",title:"成交率",aliases:["成交率"],tables:["crm_clue"],content:"成交率 成单",sqlContent:"SELECT COUNT(DISTINCT CASE WHEN is_win_order = 1 OR is_win_order = 2 THEN clue_id END) / COUNT(DISTINCT clue_id) FROM crm_clue",antiExamples:""},
  };
  const verdict=_internal.validateDraftPage(draft,{question:"查询成交率",context:contextFixture()});
  assert.equal(verdict.ok,false);
  assert.equal(verdict.reason,"predicate_unsupported");
});

test("shortlist excludes sensitive columns and tags event, identity and time roles",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  assert.equal(shortlist.tables.length,1);
  const [table]=shortlist.tables;
  assert.equal(table.tableName,"crm_clue");
  assert.deepEqual(table.numeratorEvents.map((column)=>column.columnName),["is_win_order","order_time"]);
  assert.deepEqual(table.identities.map((column)=>column.columnName),["clue_id"]);
  assert.deepEqual(table.timeColumns.map((column)=>column.columnName),["order_time","create_time"]);
  assert.equal(table.columns.includes("owner_cell"),false);
  assert.doesNotMatch(JSON.stringify(shortlist),/owner_cell/);
});

test("unimplemented kinds return null without throwing and without calling the LLM",async()=>{
  let llmCalls=0;
  const service=createKnowledgeProposalService({store:{},config:{llm:{}},knowledge:{},evaluation:null,callJson:async()=>{llmCalls++;return {value:{proposals:[]}};}});
  assert.equal(await service.propose("term",{sourceId:1,question:"什么是有效客户",context:contextFixture()}),null);
  assert.equal(llmCalls,0);
});

test("propose returns validated metric drafts and drops unusable formulas",async()=>{
  const callJson=async()=>({value:{proposals:[
    {table:"crm_clue",numerator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[{column:"is_win_order",operator:"=",value:1}]},denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},timeColumn:"order_time",rationale:"以成单标记为分子"},
    {table:"crm_clue",numerator:{aggregation:"count",column:"ghost",predicates:[]},denominator:{aggregation:"count",column:"clue_id",predicates:[]},timeColumn:"order_time",rationale:"引用了不存在的列"},
  ]}});
  const service=createKnowledgeProposalService({store:{},config:{llm:{baseUrl:"http://llm.test",apiKey:"k",model:"m"},queryLlmTimeoutMs:1000},knowledge:{},evaluation:null,callJson});
  const proposal=await service.propose("metric",{sourceId:1,question:"查询成交率",context:contextFixture(),assetLabel:"成交率"});
  assert.ok(proposal);
  assert.equal(proposal.drafts.length,1);
  assert.equal(proposal.drafts[0].table,"crm_clue");
  assert.match(proposal.drafts[0].summary,/成交率 =/);
});

test("confirmProposal saves a verified page with the confirming editor as owner",async()=>{
  const saved=[];const evalCases=[];
  const knowledge={save:async(sourceId,input)=>{saved.push({sourceId,input});return {...input,sourceId};}};
  const evaluation={create:(sourceId,input)=>{evalCases.push({sourceId,input});}};
  const store={getKnowledge:()=>null};
  const service=createKnowledgeProposalService({store,config:{llm:{}},knowledge,evaluation,callJson:async()=>({value:{proposals:[]}})});
  const pending={sourceId:7,question:"查询成交率",drafts:[{slug:"成交率",page:{pageType:"metric",slug:"成交率",title:"成交率",aliases:["成交率"],tables:["crm_clue"],content:"定义",sqlContent:"SELECT 1/2 FROM crm_clue",antiExamples:""}}]};
  const result=await service.confirmProposal(pending,0,{userName:"editor-a"});
  assert.equal(result.verified,true);
  assert.equal(result.owner,"editor-a");
  assert.equal(saved.length,1);
  assert.deepEqual(evalCases,[{sourceId:7,input:{setName:"口径确认",question:"查询成交率",goldSql:null,category:"口径确认"}}]);
});

test("confirmProposal refuses to overwrite an existing verified page",async()=>{
  const store={getKnowledge:()=>({verified:1,title:"成交率"})};
  const service=createKnowledgeProposalService({store,config:{llm:{}},knowledge:{save:async()=>{throw new Error("不应到达");}},evaluation:null,callJson:async()=>({value:{proposals:[]}})});
  const pending={sourceId:7,question:"查询成交率",drafts:[{slug:"成交率",page:{pageType:"metric",slug:"成交率",title:"成交率",aliases:[],tables:[],content:"",sqlContent:"SELECT 1",antiExamples:""}}]};
  await assert.rejects(()=>service.confirmProposal(pending,0,{userName:"editor-a"}),/已存在同名的已验证指标页/);
});
