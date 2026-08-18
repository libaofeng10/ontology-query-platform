import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { createTaskService } from "../src/task-service.mjs";

test("discovery tasks persist progress and complete outside the request lifecycle",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-task-"));
  const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"test",kind:"mysql",host:"localhost",port:3306,dbName:"db",userName:"ro",credential:"encrypted",isDemo:false});
  const discovery={discover:async(_source,{onProgress})=>{onProgress({progress:40,total:100,currentStep:"探针表"});await Promise.resolve();return {sourceId:source.id,totalTables:2};}};
  const tasks=createTaskService({store,discovery});
  const created=tasks.createDiscoveryTask(source);
  assert.equal(created.status,"queued");
  const completed=await waitForTask(store,created.id);
  assert.equal(completed.status,"succeeded");
  assert.equal(completed.progress,100);
  assert.equal(completed.result.totalTables,2);
  await tasks.close();store.close();
});

test("interrupted tasks are requeued and safely recovered",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-task-"));
  const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"test",kind:"mysql",host:"localhost",port:3306,dbName:"db",userName:"ro",credential:"encrypted",isDemo:false});
  store.createTask({id:"recover-me",sourceId:source.id,taskType:"discovery"});store.startTask("recover-me");
  let executions=0;const tasks=createTaskService({store,discovery:{discover:async()=>{executions++;return {sourceId:source.id,totalTables:0};}}});
  tasks.recover();const completed=await waitForTask(store,"recover-me");
  assert.equal(completed.status,"succeeded");assert.equal(executions,1);
  await tasks.close();store.close();
});

test("schema refresh keeps removed metadata as inactive history",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-schema-"));const store=createStore(join(dir,"store.sqlite"));
  store.upsertTable({sourceId:1,tableName:"old_table",grade:"A",active:1});
  store.upsertColumn({sourceId:1,tableName:"old_table",columnName:"id",dataType:"bigint",isPrimary:1});
  store.upsertRelation({sourceId:1,fromTable:"old_table",fromCol:"id",toTable:"old_table",toCol:"id",status:"confirmed",confidence:1});
  store.addSchemaSnapshot(1,"v1",{tables:[{tableName:"old_table"}],columns:[{tableName:"old_table",columnName:"id"}],foreignKeys:[]});
  store.finishSchemaRefresh(1,{tables:[],columns:[],foreignKeys:[]},[]);
  assert.equal(store.listTables(1).length,0);
  assert.equal(store.db.prepare(`SELECT present FROM ds_table WHERE source_id=1 AND table_name='old_table'`).get().present,0);
  assert.equal(store.db.prepare(`SELECT present FROM ds_column WHERE source_id=1 AND table_name='old_table'`).get().present,0);
  assert.equal(store.db.prepare(`SELECT present FROM ds_relation WHERE source_id=1`).get().present,0);
  assert.equal(store.getLatestSchemaSnapshot(1).version,1);
  store.close();
});

async function waitForTask(store,id) {
  for(let index=0;index<100;index++) { const task=store.getTask(id);if(['succeeded','failed'].includes(task.status))return task;await new Promise((resolve)=>setTimeout(resolve,5)); }
  throw new Error("task did not finish");
}
