import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";

test("store preserves manual table grade overrides across probe upserts", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  store.db.prepare(`INSERT INTO ds_table(source_id,table_name,grade,grade_override) VALUES(1,'legacy_table','B','A')`).run();
  store.upsertTable({sourceId:1,tableName:"legacy_table",rowEstimate:0,grade:"C",gradeOverride:null,active:0,comment:"",daysSinceWrite:800,inboundRelations:0});
  assert.equal(store.listTables(1)[0].grade,"A");
  assert.equal(store.listTables(1)[0].gradeOverride,"A");
  store.close();
});

test("question answers remain auditable", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  const id=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",question:"状态 1？",evidence:"1 占 90%",options:["有效","无效"]});
  assert.equal(store.listQuestions(1).length,1);
  assert.equal(store.answerQuestion(id,"有效"),1);
  assert.equal(store.listQuestions(1).length,0);
  const row=store.db.prepare("SELECT answer,answered_at,status FROM ds_question WHERE id=?").get(id);
  assert.equal(row.answer,"有效");assert.equal(row.status,"answered");assert.ok(row.answered_at);
  store.close();
});

test("term anchors upsert stable vocabulary ids and preserve aliases",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));const store=createStore(join(dir,"test.sqlite"));
  store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUST",prefLabelZh:"客户",altLabels:["客群","客户"],kind:"object"});
  store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUST",prefLabelZh:"客户主体",altLabels:["客群"],kind:"object"});
  assert.equal(store.listTermAnchors().length,1);
  assert.equal(store.getTermAnchor("corp","CUST").prefLabelZh,"客户主体");
  assert.deepEqual(store.getTermAnchor("corp","CUST").altLabels,["客群"]);
  store.close();
});

test("manual grade API state and source health timestamps are persisted", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  store.upsertTable({sourceId:3,tableName:"sales_order",rowEstimate:100,grade:"B",active:1});
  assert.equal(store.setTableGrade(3,"sales_order","A"),1);
  assert.equal(store.listTables(3)[0].gradeOverride,"A");
  const source=store.createSource({name:"test",kind:"mysql",host:"localhost",port:3306,dbName:"db",userName:"ro",credential:"encrypted",isDemo:false});
  store.markSourceTest(source.id,false,"access denied");
  const updated=store.listSources().find((item)=>item.id===source.id);
  assert.equal(updated.lastTestOk,0);assert.equal(updated.lastTestError,"access denied");assert.ok(updated.lastTestAt);
  assert.equal(store.updateSourceCredential(source.id,"new-encrypted-value"),1);
  assert.equal(store.getSource(source.id).credential,"new-encrypted-value");assert.equal(store.getSource(source.id).lastTestOk,null);
  store.close();
});

test("query sessions persist structured context, ordered turns and automatic titles",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));const store=createStore(join(dir,"test.sqlite"));
  store.createSession({id:"session-1",sourceId:1,userName:"u",title:"问数会话"});
  store.updateSession("session-1",{tableNames:["sales_order"],pageSlugs:["复购率"]});
  store.appendSessionTurn("session-1","查询本月订单",{id:"query-1",sessionId:"session-1",question:"查询本月订单",conclusion:"本月共 8 单",columns:[],rows:[],chart:null,evidence:{pages:[],rules:[],tables:["sales_order"],sql:"SELECT COUNT(*) FROM sales_order",durationMs:3,scannedRows:10}});
  const session=store.getSessionDetail("session-1");assert.deepEqual(session.context.tableNames,["sales_order"]);assert.equal(session.title,"查询本月订单");assert.deepEqual(session.messages.map((item)=>item.role),["user","assistant"]);assert.equal(session.messages[1].content.conclusion,"本月共 8 单");
  assert.equal(store.listSessions(1,"u")[0].messageCount,2);assert.deepEqual(store.getSessionPlanningHistory("session-1"),[{role:"user",content:"查询本月订单"},{role:"assistant",content:"查询范围：sales_order\n本月共 8 单"}]);
  assert.equal(store.listSessions(1,"other").length,0);assert.equal(store.deleteSession("session-1"),1);assert.equal(store.getSession("session-1"),null);assert.equal(store.listSessionMessages("session-1").length,0);
  store.close();
});
