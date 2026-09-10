import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeIntentConcepts, catalogFilterConcepts } from "../src/knowledge-concepts.mjs";

test("metric CASE expressions do not become legal-case grain",()=>{
  const pages=[{pageType:"metric",slug:"repeat-rate",title:"复购率",aliases:[],tables:["customer_fact"],content:"复购客户占比",sqlContent:"COUNT(DISTINCT CASE WHEN order_count >= 2 THEN customer_id END) / COUNT(DISTINCT customer_id)",verified:true}];
  const concepts=knowledgeIntentConcepts(pages,{customer_fact:[{columnName:"order_count"},{columnName:"customer_id"}]});
  assert.equal(concepts[0].grain,"customer");
});

test("verified metric predicates bind each literal to one physical field",()=>{
  const pages=[{pageType:"metric",slug:"won-rate",title:"成单率",aliases:[],tables:["lead_entity"],content:"有效线索中的成单线索占比。",sqlContent:"COUNT(DISTINCT CASE WHEN lead_entity.is_won = 1 AND lead_entity.is_deleted = 0 THEN lead_entity.id END) / COUNT(DISTINCT CASE WHEN lead_entity.is_deleted = 0 THEN lead_entity.id END)",verified:true}];
  const concepts=knowledgeIntentConcepts(pages,{lead_entity:[{columnName:"id"},{columnName:"is_won"},{columnName:"is_deleted"}]});
  const formula=concepts[0].metricDefinition.formula;
  assert.equal(formula.numerator.predicateBinding,"physical");
  assert.deepEqual(formula.numerator.predicates,[
    {column:"lead_entity.is_deleted",operator:"=",valueType:"number",value:"0"},
    {column:"lead_entity.is_won",operator:"=",valueType:"number",value:"1"},
  ]);
  assert.deepEqual(formula.denominator.predicates,[{column:"lead_entity.is_deleted",operator:"=",valueType:"number",value:"0"}]);
  const unsupported=knowledgeIntentConcepts([{...pages[0],sqlContent:pages[0].sqlContent.replace(" AND "," OR ")}],{lead_entity:[{columnName:"id"},{columnName:"is_won"},{columnName:"is_deleted"}]})[0];
  assert.equal(unsupported.metricDefinition.formula.numerator.predicateBinding,"unsupported");
});

// T6: an operator-less “抖音渠道” is provable when 抖音 is a registered member of
// that field's dictionary. Before this, the parser never recognized the phrasing
// and the filter never reached the binding layer that resolves 抖音 to its code.
const CHANNEL_TABLES=[{tableName:"clue",comment:"线索表"}];
const CHANNEL_COLUMNS={clue:[
  {columnName:"id",dataType:"bigint",isPrimary:1},
  {columnName:"source_data_channel",dataType:"tinyint",comment:"数据来源"},
  {columnName:"owner_cell",dataType:"varchar",comment:"负责人手机号",isSensitive:1},
]};
const CHANNEL_ENUMS={"clue.source_data_channel":[
  {value:"0",meaning:"百度",meaningSource:"human"},
  {value:"2",meaning:"抖音",meaningSource:"human"},
  {value:"3",meaning:null,meaningSource:null},
]};

function channelConcepts(enums=CHANNEL_ENUMS) {
  return catalogFilterConcepts(CHANNEL_TABLES,CHANNEL_COLUMNS,null,[],enums);
}

test("a confirmed enum meaning becomes parser vocabulary, and only a confirmed one",()=>{
  const concept=channelConcepts().find((item)=>item.aliases[0]==="数据来源");
  assert.deepEqual(concept.memberValues,["抖音","百度"],"未确认含义的取值 3 不得进入词表");

  // 2026-09-04 敏感列逻辑已移除：isSensitive 恒为 false，之前被标记为
  // 敏感的列（负责人手机号）现在正常参与词表构建，其原始文本取值直接
  // 成为可解析的词面（数字型取值仍需确认含义才会进入词表，规则不变）。
  const formerlySensitive=channelConcepts({"clue.owner_cell":[{value:"老王的客户",meaning:null,meaningSource:null}]}).find((item)=>item.aliases[0]==="负责人手机号");
  assert.deepEqual(formerlySensitive.memberValues,["老王的客户"],"敏感标记移除后原始文本取值可进入解析词表");
});
