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

test("enum question answers atomically claim pending state before writing a structured meaning",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  const id=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"1",question:"状态 1？",evidence:"1 占 90%",options:[" 有效 ","无效","补充说明","有效"]});
  assert.deepEqual(store.getQuestion(id).options,["有效","无效","补充说明"]);
  assert.deepEqual(store.answerEnumQuestion(id,"有效","reviewer"),{ok:true,changes:1,wroteMeaning:true});
  assert.deepEqual(store.answerEnumQuestion(id,"无效","stale-reviewer"),{ok:false,reason:"not_pending"});
  const meaning=store.db.prepare(`SELECT meaning,meaning_source AS meaningSource FROM ds_enum WHERE source_id=1 AND table_name='customer' AND column_name='status' AND value='1'`).get();
  assert.deepEqual(meaning,{meaning:"有效",meaningSource:"human"});
  const answered=store.db.prepare(`SELECT answer,outruled_by AS outruledBy,status FROM ds_question WHERE id=?`).get(id);
  assert.deepEqual(answered,{answer:"有效",outruledBy:"reviewer",status:"answered"});

  const conflictingId=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"1",question:"再次确认状态 1？",evidence:"复核",options:["有效","无效"]});
  assert.deepEqual(store.answerEnumQuestion(conflictingId,"无效","reviewer"),{ok:false,reason:"meaning_conflict"});
  assert.equal(store.getQuestion(conflictingId).status,"pending");
  assert.equal(store.listEnums(1,"customer")[0].meaning,"有效");

  const supplementId=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"2",question:"状态 2？",evidence:"待说明",options:["有效","补充说明"]});
  assert.deepEqual(store.answerEnumQuestion(supplementId,"补充说明","reviewer"),{ok:true,changes:1,wroteMeaning:false});
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ds_enum WHERE source_id=1 AND table_name='customer' AND column_name='status' AND value='2'`).get().count,0);
  store.close();
});

test("enum question options fail closed when malformed and enum values are never inferred from question text",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  const malformedId=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"9",question:"状态 9？",evidence:"待确认",options:["有效","无效"]});
  store.db.prepare(`UPDATE ds_question SET options='{"answer":"有效"}' WHERE id=?`).run(malformedId);
  assert.deepEqual(store.getQuestion(malformedId).options,[]);
  assert.deepEqual(store.listQuestions(1).find((item)=>item.id===malformedId).options,[]);
  assert.deepEqual(store.answerEnumQuestion(malformedId,"有效","reviewer"),{ok:false,reason:"invalid_options"});
  assert.equal(store.getQuestion(malformedId).status,"pending");

  const unboundId=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",question:"状态 999 是否有效？",evidence:"问题文本包含值但没有结构化绑定",options:["有效","无效"]});
  assert.deepEqual(store.answerEnumQuestion(unboundId,"有效","reviewer"),{ok:false,reason:"invalid_binding"});
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ds_enum WHERE source_id=1 AND table_name='customer' AND column_name='status'`).get().count,0);
  assert.equal(store.getQuestion(unboundId).status,"pending");
  store.close();
});

test("enum meaning write failure rolls back the pending claim",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-store-"));
  const store=createStore(join(dir,"test.sqlite"));
  const id=store.addQuestion({sourceId:1,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"rollback",question:"回滚测试？",evidence:"事务测试",options:["有效"]});
  store.db.prepare(`CREATE TRIGGER reject_enum_meaning BEFORE INSERT ON ds_enum WHEN NEW.value='rollback' BEGIN SELECT RAISE(ABORT,'reject enum write'); END`).run();
  assert.throws(()=>store.answerEnumQuestion(id,"有效","reviewer"),/reject enum write/);
  assert.equal(store.getQuestion(id).status,"pending");
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ds_enum WHERE value='rollback'`).get().count,0);
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
