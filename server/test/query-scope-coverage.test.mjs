import assert from "node:assert/strict";
import test from "node:test";
import { exhaustiveAccountTables, missingExhaustiveAccountProductColumns, missingExhaustiveAccountTables, missingIntentSubjectFacets, organizationNamePhrase, organizationPhraseFilterError, queryIntentFilterError } from "../src/query-scope-coverage.mjs";
import { parseQueryIntent } from "../src/query-intent.mjs";

const question="查询一下北京大成律所所有账号情况";
const context={
  tables:[
    {tableName:"alpha_user",comment:"Alpha用户信息"},
    {tableName:"alpha_account_user",comment:""},
    {tableName:"alpha_account_user_business_details",comment:"用户额度明细表"},
    {tableName:"alpha_account_user_business_details_day",comment:"用户额度明细表-天维度"},
    {tableName:"alpha_user_activate_product",comment:""},
    {tableName:"alpha_nps_user_feedback",comment:"NPS 用户反馈信息表"},
    {tableName:"alpha_user_director",comment:"Alpha用户分配表"},
  ],
  columns:{
    alpha_user:[{columnName:"alpha_id",comment:"Alpha用户id"},{columnName:"alp_office_name",comment:"Alpha律所名称"}],
    alpha_account_user:[{columnName:"user_id",comment:"产品用户 ID"},{columnName:"user_office_name",comment:"用户所属律所"},{columnName:"product_key",comment:"产品key"}],
    alpha_account_user_business_details:[{columnName:"user_id",comment:"产品账户用户id"},{columnName:"office_id",comment:"律所id"}],
    alpha_account_user_business_details_day:[{columnName:"user_id",comment:"产品账户用户id"},{columnName:"office_id",comment:"律所id"}],
    alpha_user_activate_product:[{columnName:"alpha_id",comment:"用户id"},{columnName:"office_id",comment:"律所id"},{columnName:"activate_product",comment:"开通产品"}],
    alpha_nps_user_feedback:[{columnName:"user_id",comment:"用户id"},{columnName:"law_firm",comment:"律所"}],
    alpha_user_director:[{columnName:"alpha_user_id",comment:"alpha_userid"},{columnName:"base_id",comment:"律所大数据 id"}],
  },
};

test("exhaustive account coverage keeps account masters and excludes auxiliary user tables",()=>{
  assert.deepEqual(exhaustiveAccountTables(question,context),["alpha_user","alpha_account_user"]);
  assert.deepEqual(missingExhaustiveAccountTables(question,context,["alpha_user"]),["alpha_account_user"]);
  assert.deepEqual(missingExhaustiveAccountTables(question,context,["alpha_user","alpha_account_user"]),[]);
  const withGenericUser={
    ...context,
    tables:[...context.tables,{tableName:"user",comment:"用户基础信息表"}],
    columns:{...context.columns,user:[{columnName:"user_id",comment:"用户编号"},{columnName:"institution",comment:"机构名称"}]},
    retrieval:{diagnostics:{facets:[{key:"subject:account",kind:"subject",required:true,selectedTables:["alpha_user","alpha_account_user","user"],authoritativeTables:["alpha_user","alpha_account_user"]}]}},
  };
  assert.deepEqual(exhaustiveAccountTables(question,withGenericUser),["alpha_user","alpha_account_user"]);
});

test("product-dimension coverage only applies to real account masters",()=>{
  assert.deepEqual(missingExhaustiveAccountProductColumns(question,context,[{tables:["alpha_user"],sql:"SELECT alpha_id FROM alpha_user"},{tables:["alpha_account_user"],sql:"SELECT user_id FROM alpha_account_user"}]),["alpha_account_user.product_key"]);
  assert.deepEqual(missingExhaustiveAccountProductColumns(question,context,[{tables:["alpha_user"],sql:"SELECT alpha_id FROM alpha_user"},{tables:["alpha_account_user"],sql:"SELECT user_id, product_key FROM alpha_account_user"}]),[]);
});

test("law-firm proper names stay as one continuous SQL filter value",()=>{
  assert.equal(organizationNamePhrase(question),"北京大成");
  assert.equal(organizationNamePhrase("查询北京地区律所的账号"),"");
  assert.equal(organizationPhraseFilterError(question,"SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京大成%'"),null);
  assert.match(organizationPhraseFilterError(question,"SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京%' AND alp_office_name LIKE '%大成%'"),/必须作为连续字符串过滤/);
});

test("intent subject coverage blocks substituting an unrelated high-score table",()=>{
  const intent=parseQueryIntent("查询线索");
  const retrieval={diagnostics:{facets:[{key:"subject:clue",kind:"subject",required:true,covered:true,selectedTables:["crm_clue"]}]}};
  const error=queryIntentFilterError("查询线索","SELECT user_id FROM alpha_account_user",intent,{usedTables:["alpha_account_user"],retrieval});
  assert.equal(error.code,"INTENT_SUBJECT_DROPPED");
  assert.equal(queryIntentFilterError("查询线索","SELECT clue_id FROM crm_clue",intent,{usedTables:["crm_clue"],retrieval}),null);
  assert.deepEqual(missingIntentSubjectFacets(intent,retrieval,["alpha_account_user"]),["subject:clue"]);
  assert.deepEqual(missingIntentSubjectFacets(intent,retrieval,["crm_clue"]),[]);
});

test("verified page bindings narrow execution without removing structural recall candidates",()=>{
  const intent=parseQueryIntent("查询账号");
  const retrieval={diagnostics:{facets:[{key:"subject:account",kind:"subject",required:true,covered:true,selectedTables:["alpha_user","user"],authoritativeTables:["alpha_user"]}]}};
  assert.equal(queryIntentFilterError("查询账号","SELECT id FROM user",intent,{usedTables:["user"],retrieval}).code,"INTENT_SUBJECT_DROPPED");
  assert.equal(queryIntentFilterError("查询账号","SELECT alpha_id FROM alpha_user",intent,{usedTables:["alpha_user"],retrieval}),null);
});
