import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createDiscoveryService } from "../src/discovery-service.mjs";
import { createStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";

async function api(app,path,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;
  request.headers={authorization:"Bearer token-editor","content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}

// The schema two real tables would present. The migration staging copy is exactly the kind
// of table a user excludes before ever probing it.
const TABLES=[{tableName:"crm_customer",rowEstimate:5000,comment:"客户"},{tableName:"crm_customer_backfill",rowEstimate:4800,comment:"回填中间表"}];
const COLUMNS=["crm_customer","crm_customer_backfill"].flatMap((tableName)=>[
  {tableName,columnName:"id",dataType:"bigint",nullable:"NO",comment:"主键",isPrimary:1,isUnique:1,isIndexed:1},
  {tableName,columnName:"channel",dataType:"tinyint",nullable:"NO",comment:"来源渠道 1：百度 2：抖音",isPrimary:0,isUnique:0,isIndexed:0},
]);
function fakeConnector(probedTables=[]) {
  return {close:async()=>{},test:async()=>({ok:true}),explain:async()=>[],query:async(_source,sql)=>{
    if(sql.includes("information_schema.TABLES")) return [TABLES];
    if(sql.includes("information_schema.COLUMNS")) return [COLUMNS];
    if(sql.includes("information_schema.KEY_COLUMN_USAGE")) return [[]];
    const hit=[...TABLES].sort((a,b)=>b.tableName.length-a.tableName.length).find(({tableName})=>sql.includes(`\`${tableName}\``));
    if(hit) { probedTables.push(hit.tableName);return [[{value:1,count:80},{value:2,count:20}]]; }
    return [[]];
  }};
}

test("excluded tables are never probed and vanish from every downstream surface",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-table-selection-"));
  const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"encrypted",isDemo:false});
  const probedTables=[];
  const discovery=createDiscoveryService({store,connector:fakeConnector(probedTables),wikiDir:join(dir,"wiki"),config:{relationModel:{maxCandidates:20,minConfidence:0.55,sampleLimit:20}},relationModel:{judge:async()=>({status:"completed",modelName:"fake",error:null,decisions:[]})}});

  // Round 1: everything included by default — both tables are probed and registered.
  await discovery.discover(source);
  assert.ok(probedTables.includes("crm_customer_backfill"));
  assert.ok(store.listTables(source.id).some((table)=>table.tableName==="crm_customer_backfill"));
  assert.ok(store.listQuestions(source.id).some((item)=>item.tableName==="crm_customer_backfill"),"首轮为回填表播下了待确认项");
  const wikiTables=await readdir(join(dir,"wiki",`source-${source.id}`,"tables"));
  assert.ok(wikiTables.includes("crm_customer_backfill.md"),"首轮写出了本体页");

  // The screenshot regression: a JOIN question hangs off the SURVIVING table while its
  // relation's far end is the excluded one. table_name alone would never catch it.
  const crossRel=store.upsertRelation({sourceId:source.id,fromTable:"crm_customer",fromCol:"backfill_id",toTable:"crm_customer_backfill",toCol:"id",cardinality:"N:1",confidence:0.8,overlapRatio:0.5,status:"review",inferenceSource:"model"});
  const crossQuestion=store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"column",tableName:"crm_customer",columnName:"backfill_id",relationId:crossRel.id,question:"crm_customer.backfill_id 是否关联 crm_customer_backfill.id？",evidence:"模型判断",options:["确认该关联","不允许关联"]});

  // The user now excludes the staging copy. The next discovery must treat it as nonexistent
  // and purge what round 1 already registered.
  store.saveTableSelections(source.id,[{tableName:"crm_customer_backfill",included:false}],"data-editor");
  probedTables.length=0;
  await discovery.discover(source);

  assert.equal(probedTables.includes("crm_customer_backfill"),false,"排除的表不得被下探针");
  assert.ok(probedTables.includes("crm_customer"),"入选的表照常探查");
  assert.equal(store.listTables(source.id).some((table)=>table.tableName==="crm_customer_backfill"),false,"ds_table 中不再存在");
  assert.equal(store.listQuestions(source.id).some((item)=>item.tableName==="crm_customer_backfill"),false,"待确认项已随之关闭");
  assert.equal(store.listQuestions(source.id).some((item)=>item.id===crossQuestion),false,"挂在存活表上、JOIN 对端被排除的问题同样关闭");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM ds_enum WHERE source_id=? AND table_name='crm_customer_backfill'").get(source.id).c,0,"枚举登记已清除");
  const wikiAfter=await readdir(join(dir,"wiki",`source-${source.id}`,"tables"));
  assert.equal(wikiAfter.includes("crm_customer_backfill.md"),false,"本体页已删除");

  // The production shape this bug shipped in: the table was already purged by an earlier
  // call that predated the relation-end cleanup, leaving orphaned JOIN questions behind.
  // Re-running the purge (what a selection re-save does) must heal them.
  const orphanRel=store.upsertRelation({sourceId:source.id,fromTable:"crm_customer",fromCol:"legacy_id",toTable:"crm_customer_backfill",toCol:"id",cardinality:"N:1",confidence:0.7,overlapRatio:0.4,status:"review",inferenceSource:"model"});
  store.db.prepare("UPDATE ds_relation SET present=0 WHERE id=?").run(orphanRel.id);
  const orphanQuestion=store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"column",tableName:"crm_customer",columnName:"legacy_id",relationId:orphanRel.id,question:"crm_customer.legacy_id 是否关联 crm_customer_backfill.id？",evidence:"模型判断",options:["确认该关联","不允许关联"]});
  assert.equal(store.purgeExcludedTables(source.id),0,"表已删过，本轮无新删除");
  assert.equal(store.listQuestions(source.id).some((item)=>item.id===orphanQuestion),false,"重新保存选择即可补救历史遗留的孤儿 JOIN 问题");

  // Re-including brings it back through a normal probe on the following run.
  store.saveTableSelections(source.id,[{tableName:"crm_customer_backfill",included:true}],"data-editor");
  probedTables.length=0;
  await discovery.discover(source);
  assert.ok(probedTables.includes("crm_customer_backfill"),"重新入选后恢复探查");
  assert.ok(store.listTables(source.id).some((table)=>table.tableName==="crm_customer_backfill"));
  store.close();
});

test("preview and selection API round-trip, purge runs on save, and demo sources preview from the store",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ontoquery-selection-api-"));
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"selection-secret",apiIdentities:[{name:"data-editor",role:"editor",token:"token-editor",sourceIds:"*"}],connector:fakeConnector(),rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test"});
  try {
    const demo=app.store.listSources().find((item)=>item.isDemo);
    const demoPreview=await api(app,`/api/sources/${demo.id}/tables/preview`,null,"GET");
    assert.equal(demoPreview.status,200);
    assert.ok(demoPreview.body.tables.length>0,"演示源从已登记结构给出清单");
    assert.ok(demoPreview.body.tables.every((row)=>row.included===1||row.included===true));

    const real=app.store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"encrypted",isDemo:false});
    const blocked=await api(app,`/api/sources/${real.id}/tables/preview`,null,"GET");
    assert.equal(blocked.status,400,"未通过只读连接测试前不能预览");
    app.store.db.prepare("UPDATE ds_source SET last_test_ok=1 WHERE id=?").run(real.id);

    const preview=await api(app,`/api/sources/${real.id}/tables/preview`,null,"GET");
    assert.equal(preview.status,200);
    assert.deepEqual(preview.body.tables.map((row)=>row.tableName).sort(),["crm_customer","crm_customer_backfill"]);
    assert.ok(preview.body.tables.every((row)=>row.probed===false));

    const rejected=await api(app,`/api/sources/${real.id}/tables/selection`,{selections:[]},"PUT");
    assert.equal(rejected.status,400);
    const malformed=await api(app,`/api/sources/${real.id}/tables/selection`,{selections:[{included:false}]},"PUT");
    assert.equal(malformed.status,400);

    const saved=await api(app,`/api/sources/${real.id}/tables/selection`,{selections:[{tableName:"crm_customer",included:true},{tableName:"crm_customer_backfill",included:false}]},"PUT");
    assert.equal(saved.status,200);
    assert.equal(saved.body.excluded,1);
    const echo=await api(app,`/api/sources/${real.id}/tables/preview`,null,"GET");
    const backfill=echo.body.tables.find((row)=>row.tableName==="crm_customer_backfill");
    assert.equal(Boolean(backfill.included),false,"排除决定持久化并回显");
    assert.equal(backfill.decidedBy,"data-editor");
  } finally { await app.close(); }
});
