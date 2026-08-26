import test from "node:test";
import assert from "node:assert/strict";
import { extractKnowledgeColumnRefs, findKnowledgeOntologyConflicts, findKnowledgeOntologyMappingConflicts, schemaMappedColumns } from "../src/knowledge-column-refs.mjs";
import { probeTargets, probeZeroResult, siblingColumns } from "../src/query-result-probe.mjs";

const columnsByTable={
  alpha_account_user:[
    {columnName:"office_name",dataType:"varchar(100)",isSensitive:0},
    {columnName:"user_office_name",dataType:"varchar(100)",isSensitive:0},
    {columnName:"standard_office_name",dataType:"varchar(255)",isSensitive:0},
    {columnName:"office_id",dataType:"varchar(100)",isSensitive:0},
    {columnName:"phone",dataType:"varchar(20)",isSensitive:1},
    {columnName:"expire_time",dataType:"datetime",isSensitive:0},
  ],
};

test("知识页字段引用提取：只认绑定表中真实存在的字段名", () => {
  const page={verified:true,title:"律所名称",pageType:"term",slug:"office",tables:["alpha_account_user"],sqlContent:"user_office_name LIKE CONCAT('%', ?, '%')",content:"按律所名称查用户时用 user_office_name；office_name 是开通时律所。",antiExamples:"不要用 office_name"};
  const refs=extractKnowledgeColumnRefs(page,columnsByTable);
  const columns=refs.map((ref)=>ref.column).sort();
  assert.deepEqual(columns,["office_name","user_office_name"]);
});

test("知识-本体冲突：模型已映射表中缺失被引用字段时报冲突", () => {
  const page={verified:true,title:"律所名称",pageType:"term",slug:"office",tables:["alpha_account_user"],sqlContent:"user_office_name LIKE ...",content:""};
  const schema={objectTypes:[{apiName:"alpha_product_account",properties:[
    {apiName:"office_name",mapping:{table:"alpha_account_user",column:"office_name"}},
    {apiName:"expire_time",mapping:{table:"alpha_account_user",column:"expire_time"}},
  ]}]};
  const conflicts=findKnowledgeOntologyConflicts([page],columnsByTable,schemaMappedColumns(schema));
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].column,"user_office_name");
  // 字段补进模型后不再冲突
  schema.objectTypes[0].properties.push({apiName:"user_office_name",mapping:{table:"alpha_account_user",column:"user_office_name"}});
  assert.equal(findKnowledgeOntologyConflicts([page],columnsByTable,schemaMappedColumns(schema)).length,0);
  // 未验证页不参与
  assert.equal(findKnowledgeOntologyConflicts([{...page,verified:false}],columnsByTable,schemaMappedColumns({objectTypes:[]})).length,0);
});

test("查询期硬冲突要求同一属性概念的正向映射证据，anti 与 join 引用不升级",()=>{
  const schema={objectTypes:[{apiName:"alpha_product_account",properties:[
    {apiName:"office_name",displayName:"律所名称",mapping:{table:"alpha_account_user",column:"office_name"}},
  ]}]};
  const positive={verified:true,title:"律所名称",aliases:["所属律所"],pageType:"term",slug:"office",tables:["alpha_account_user"],sqlContent:"user_office_name LIKE ...",content:""};
  const conflicts=findKnowledgeOntologyMappingConflicts([positive],columnsByTable,schema);
  assert.deepEqual(conflicts.map((item)=>[item.column,item.mappedProperty,item.mappedColumn]),[["user_office_name","alpha_product_account.office_name","office_name"]]);
  const antiOnly={...positive,sqlContent:"office_name LIKE ...",antiExamples:"不要使用 user_office_name"};
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([antiOnly],columnsByTable,schema),[],"antiExamples 不能成为正向字段绑定");
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([{...positive,pageType:"join"}],columnsByTable,schema),[],"join 页 FK/字段不是属性映射冲突");
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([{...positive,title:"到期时间",aliases:[]}],columnsByTable,schema),[],"未映射字段本身只构成 coverage gap，不能在概念不一致时硬阻断");
});

test("metric/rule 多列表达式的辅助谓词列不能借用页面标题升级为硬冲突",()=>{
  const formulaColumns={fact_order:[
    {columnName:"gross_amount",comment:"原始订单金额",isSensitive:0},
    {columnName:"net_amount",comment:"本体订单金额",isSensitive:0},
    {columnName:"order_status",comment:"订单状态",isSensitive:0},
    {columnName:"order_time",comment:"下单时间",isSensitive:0},
    {columnName:"is_deleted",comment:"删除标记",isSensitive:0},
  ]};
  const schema={objectTypes:[{apiName:"order",properties:[
    {apiName:"amount",displayName:"订单金额",mapping:{table:"fact_order",column:"net_amount"}},
    {apiName:"status",displayName:"订单状态",mapping:{table:"fact_order",column:"order_status"}},
    {apiName:"created_at",displayName:"下单时间",mapping:{table:"fact_order",column:"order_time"}},
  ]}]};
  const metric={verified:true,pageType:"metric",slug:"order-amount",title:"订单金额",aliases:["成交金额"],tables:["fact_order"],sqlContent:"SUM(gross_amount) WHERE order_status = 'paid' AND order_time >= ? AND is_deleted = 0",content:""};
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([metric],formulaColumns,schema),[],"多列 metric 没有 ref→property 结构化绑定时只能形成 coverage gap");
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([{...metric,propertyRef:"order.amount"}],formulaColumns,schema),[],"多列表达式仅有页级 propertyRef 仍不能确定它绑定哪个物理 ref");
  const rule={...metric,pageType:"rule",slug:"paid-order",title:"订单金额规则"};
  assert.deepEqual(findKnowledgeOntologyMappingConflicts([rule],formulaColumns,schema),[],"多列 rule 的状态、时间、删除列不能被页面标题连带升级");
  const bound={...metric,propertyBindings:{"fact_order.gross_amount":"order.amount"}};
  const conflicts=findKnowledgeOntologyMappingConflicts([bound],formulaColumns,schema);
  assert.deepEqual(conflicts.map((item)=>[item.column,item.mappedProperty,item.mappedColumn,item.evidence]),[["gross_amount","order.amount","net_amount","structured_property_ref"]]);
});

test("兄弟字段：按词干重叠找同表字符串字段，排除敏感与非字符串", () => {
  const siblings=siblingColumns("alpha_account_user","office_name",{columnsByTable});
  assert.ok(siblings.includes("user_office_name"));
  assert.ok(siblings.includes("standard_office_name"));
  assert.ok(!siblings.includes("phone"));
  assert.ok(!siblings.includes("expire_time"));
});

const schema={objectTypes:[{apiName:"alpha_product_account",primaryKey:"id",properties:[
  {apiName:"office_name",type:"string",mapping:{table:"alpha_account_user",column:"office_name"}},
]}]};

test("探针目标：仅字符串 eq/contains 过滤产生目标", () => {
  const plan={filters:[{property:"alpha_product_account.office_name",operator:"contains",value:"北京大成"}]};
  const targets=probeTargets(plan,schema,{columnsByTable});
  assert.ok(targets.length>=1);
  assert.ok(targets.every((target)=>target.table==="alpha_account_user"&&target.filterColumn==="office_name"));
  assert.equal(probeTargets({filters:[{property:"alpha_product_account.office_name",operator:"gt",value:"1"}]},schema,{columnsByTable}).length,0);
  assert.equal(probeTargets({filters:[{property:"alpha_product_account.office_name",operator:"eq",value:123}]},schema,{columnsByTable}).length,0);
});

test("零行探针：兄弟字段有命中时产出 findings，探针 SQL 过护栏", async () => {
  const executed=[];
  const connector={
    explain:async()=>[{rows:100}],
    query:async(_source,sql)=>{executed.push(sql);return sql.includes("user_office_name")?[[{match_count:37}]]:[[{match_count:0}]];},
  };
  const plan={filters:[{property:"alpha_product_account.office_name",operator:"contains",value:"北京大成"}]};
  const findings=await probeZeroResult({plan,schema,catalog:{columnsByTable},connector,source:{},signal:undefined});
  assert.equal(findings.length,1);
  assert.equal(findings[0].siblingColumn,"user_office_name");
  assert.equal(findings[0].matchCount,37);
  assert.ok(executed.every((sql)=>sql.startsWith("SELECT COUNT(*)")));
});

test("零行探针：EXPLAIN 超阈值或查询失败时静默跳过", async () => {
  const plan={filters:[{property:"alpha_product_account.office_name",operator:"eq",value:"北京大成"}]};
  const tooBig={explain:async()=>[{rows:2_000_000}],query:async()=>{throw new Error("should not run");}};
  assert.deepEqual(await probeZeroResult({plan,schema,catalog:{columnsByTable},connector:tooBig,source:{}}),[]);
  const failing={explain:async()=>[{rows:1}],query:async()=>{throw new Error("boom");}};
  assert.deepEqual(await probeZeroResult({plan,schema,catalog:{columnsByTable},connector:failing,source:{}}),[]);
});

test("发布校验：已验证知识页引用未映射字段产生 warning，不阻塞发布", async () => {
  const {validateSemanticSchema}=await import("../src/semantic-schema.mjs");
  const catalog={
    tables:[{tableName:"alpha_account_user",grade:"A",active:1}],
    columnsByTable:{alpha_account_user:[
      {columnName:"id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,isSensitive:0},
      {columnName:"office_name",dataType:"varchar(100)",nullable:1,isSensitive:0},
      {columnName:"user_office_name",dataType:"varchar(100)",nullable:1,isSensitive:0},
    ]},
    relations:[],
    knowledgePages:[{verified:true,title:"律所名称",pageType:"term",slug:"office",tables:["alpha_account_user"],sqlContent:"user_office_name LIKE ...",content:""}],
  };
  const schema={name:"crm",displayName:"m",objectTypes:[{apiName:"account",displayName:"账号",primaryKey:"id",properties:[
    {apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"alpha_account_user",column:"id"}},
    {apiName:"office_name",displayName:"律所",type:"string",required:false,mapping:{table:"alpha_account_user",column:"office_name"}},
  ]}],linkTypes:[]};
  const result=validateSemanticSchema(schema,catalog);
  assert.equal(result.ok,true);
  const warning=result.warnings.find((item)=>item.code==="ONTOLOGY_KNOWLEDGE_COLUMN_UNMAPPED");
  assert.ok(warning);
  assert.match(warning.message,/user_office_name/);
  // 补上映射后不再告警
  schema.objectTypes[0].properties.push({apiName:"user_office_name",displayName:"所属律所",type:"string",required:false,mapping:{table:"alpha_account_user",column:"user_office_name"}});
  assert.ok(!validateSemanticSchema(schema,catalog).warnings.some((item)=>item.code==="ONTOLOGY_KNOWLEDGE_COLUMN_UNMAPPED"));
});
