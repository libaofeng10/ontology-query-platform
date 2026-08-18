import test from "node:test";
import assert from "node:assert/strict";
import { clusterTablesIntoDomains, fallbackDomainName, domainNamingMessages, createOntologyDomainPlanner, ontologyDomainPlanInternal } from "../src/ontology-domain-plan.mjs";

const t=(tableName,comment=null,grade="A")=>({tableName,comment,grade,active:1});
const rel=(fromTable,toTable)=>({fromTable,fromCol:"id",toTable,toCol:`${fromTable}_id`,status:"confirmed"});

test("按已确认关系连通分量聚类，孤表按前缀并入", () => {
  const tables=[t("crm_customer"),t("crm_contact"),t("crm_follow_up"),t("pay_order"),t("pay_refund"),t("crm_tag")];
  const relations=[rel("crm_customer","crm_contact"),rel("crm_customer","crm_follow_up"),rel("pay_order","pay_refund")];
  const domains=clusterTablesIntoDomains({tables,relations,maxTables:20});
  assert.equal(domains.length,2);
  const crm=domains.find((domain)=>domain.domainKey==="crm_customer"||domain.tableNames.includes("crm_customer"));
  // crm_tag 是孤表，应并入 crm 域（前缀多数一致）
  assert.ok(crm.tableNames.includes("crm_tag"));
  assert.equal(crm.signal,"mixed");
  const pay=domains.find((domain)=>domain.tableNames.includes("pay_order"));
  assert.deepEqual(pay.tableNames,["pay_order","pay_refund"]);
  assert.equal(pay.signal,"relations");
});

test("无关系的孤表按前缀聚成域", () => {
  const tables=[t("log_login"),t("log_click"),t("misc_a")];
  const domains=clusterTablesIntoDomains({tables,relations:[],maxTables:20});
  const log=domains.find((domain)=>domain.tableNames.includes("log_login"));
  assert.ok(log.tableNames.includes("log_click"));
  assert.equal(log.signal,"prefix");
});

test("聚类结果确定性：两次运行 deep-equal", () => {
  const tables=[t("a_one"),t("a_two"),t("b_one"),t("b_two"),t("c_solo")];
  const relations=[rel("a_one","a_two"),rel("b_one","b_two")];
  assert.deepEqual(
    clusterTablesIntoDomains({tables,relations,maxTables:20}),
    clusterTablesIntoDomains({tables,relations,maxTables:20}),
  );
});

test("超过 maxTables 的域拆批：共享 domainKey、批号连续、每批不超上限", () => {
  const tables=Array.from({length:25},(_,index)=>t(`ord_item_${String(index+1).padStart(2,"0")}`));
  const relations=tables.slice(1).map((item)=>rel("ord_item_01",item.tableName));
  const domains=clusterTablesIntoDomains({tables,relations,maxTables:20});
  assert.equal(domains.length,2);
  assert.equal(domains[0].domainKey,domains[1].domainKey);
  assert.equal(domains[0].batchCount,2);
  assert.deepEqual([domains[0].batchIndex,domains[1].batchIndex].sort(),[1,2]);
  for(const domain of domains)assert.ok(domain.tableCount<=20);
});

test("每张表恰好出现在一个域中", () => {
  const tables=[...Array.from({length:30},(_,index)=>t(`big_${index}`)),t("x_a"),t("x_b"),t("solo_only")];
  const relations=Array.from({length:29},(_,index)=>rel("big_0",`big_${index+1}`));
  const domains=clusterTablesIntoDomains({tables,relations,maxTables:20});
  const seen=domains.flatMap((domain)=>domain.tableNames);
  assert.equal(seen.length,tables.length);
  assert.equal(new Set(seen).size,tables.length);
});

test("fallback 命名与 prompt 内容", () => {
  const named=fallbackDomainName({domainKey:"crm",signal:"relations",tableCount:8,relationCount:6});
  assert.match(named.name,/业务域$/);
  assert.match(named.description,/8 张表/);
  const messages=domainNamingMessages({clusters:[{id:"domain-1",tables:[{tableName:"crm_customer",comment:"客户主表"}]}]});
  assert.equal(messages.length,2);
  assert.match(messages[1].content,/domain-1/);
  assert.doesNotMatch(messages[1].content,/columnName|is_sensitive/);
});

function stubStore({tables,relations}){
  const savedPlans=new Map();
  return {
    getSource:(id)=>id===1?{id:1,name:"demo"}:null,
    listTables:()=>tables,
    listRelations:()=>relations,
    getOntologyDomainPlan:(sourceId)=>savedPlans.get(sourceId)||null,
    upsertOntologyDomainPlan({sourceId,planJson,catalogChecksum,createdBy}){savedPlans.set(sourceId,{sourceId,plan:JSON.parse(planJson),planJson,catalogChecksum,createdBy,createdAt:"2026-08-17 12:00:00"});},
  };
}

test("planner：LLM 未配置时回退前缀命名", async () => {
  const planner=createOntologyDomainPlanner({store:stubStore({tables:[t("crm_a"),t("crm_b")],relations:[rel("crm_a","crm_b")]}),config:{llm:{},ontologyAi:{maxTables:20}}});
  const result=await planner.plan(1,{refresh:true});
  assert.equal(result.namingSource,"fallback");
  assert.equal(result.llmError,null);
  assert.equal(result.domains.length,1);
  assert.match(result.domains[0].name,/业务域$/);
  assert.equal(result.domains[0].namingSource,"fallback");
});

test("planner：结果持久化，默认读取缓存并检测过期", async () => {
  const tables=[t("crm_a"),t("crm_b")];
  const store=stubStore({tables,relations:[rel("crm_a","crm_b")]});
  const planner=createOntologyDomainPlanner({store,config:{llm:{},ontologyAi:{maxTables:20}}});
  const beforeSave=await planner.plan(1);
  assert.equal(beforeSave.stored,false);
  assert.equal(beforeSave.domains,null);
  const generated=await planner.plan(1,{refresh:true,actor:"editor-a"});
  assert.equal(generated.stored,true);
  assert.equal(generated.stale,false);
  const cached=await planner.plan(1);
  assert.equal(cached.stored,true);
  assert.equal(cached.stale,false);
  assert.equal(cached.domains.length,generated.domains.length);
  tables.push(t("crm_c"));
  const afterChange=await planner.plan(1);
  assert.equal(afterChange.stale,true);
});

test("planner：LLM 成功时按 id 命名，失败时回退且记录错误", async () => {
  const llm={baseUrl:"http://llm.test/v1",apiKey:"key",model:"m"};
  const ok=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({domains:[{id:"domain-1",name:"客户管理域",description:"客户主数据"}]})}}],usage:{}})});
  const planner=createOntologyDomainPlanner({store:stubStore({tables:[t("crm_a"),t("crm_b")],relations:[rel("crm_a","crm_b")]}),config:{llm,ontologyAi:{maxTables:20}},fetchImpl:ok});
  const result=await planner.plan(1,{refresh:true});
  assert.equal(result.namingSource,"llm");
  assert.equal(result.domains[0].name,"客户管理域");

  const boom=async()=>{throw new Error("网络中断");};
  const failing=createOntologyDomainPlanner({store:stubStore({tables:[t("crm_a"),t("crm_b")],relations:[rel("crm_a","crm_b")]}),config:{llm,ontologyAi:{maxTables:20}},fetchImpl:boom});
  const fallback=await failing.plan(1,{refresh:true});
  assert.equal(fallback.namingSource,"fallback");
  assert.ok(fallback.llmError);
  assert.match(fallback.domains[0].name,/业务域$/);
});

test("planner：未知数据源 404、无有效表 400", async () => {
  const planner=createOntologyDomainPlanner({store:stubStore({tables:[],relations:[]}),config:{llm:{},ontologyAi:{maxTables:20}}});
  await assert.rejects(()=>planner.plan(99,{refresh:true}),(error)=>error.status===404);
  await assert.rejects(()=>planner.plan(1,{refresh:true}),(error)=>error.status===400);
});

test("拆批边界：单前缀组超过上限时按序切片", () => {
  const names=Array.from({length:45},(_,index)=>`ev_${String(index).padStart(2,"0")}`);
  const chunks=ontologyDomainPlanInternal.splitOversized({tables:names,prefix:"ev",signal:"prefix"},20);
  assert.equal(chunks.length,3);
  assert.deepEqual(chunks.map((chunk)=>chunk.tables.length),[20,20,5]);
  assert.deepEqual(chunks.map((chunk)=>chunk.batchIndex),[1,2,3]);
});
