import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createStore } from "./store.mjs";

// A separate SQLite transaction is an OS-backed process lock. It is released on
// process death, unlike a PID file (which is unreliable across Docker containers).
export function openRelationEvaluationWorkspace({directory,resume=false,fingerprint}){
  mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  let lock,store;
  try{
    lock=new Database(join(directory,"run-lock.sqlite"),{timeout:0});
    chmodSync(join(directory,"run-lock.sqlite"),0o600);
    lock.exec("BEGIN EXCLUSIVE");
    store=createStore(join(directory,"store.sqlite"));chmodSync(join(directory,"store.sqlite"),0o600);
    store.db.exec("CREATE TABLE IF NOT EXISTS evaluation_workspace(id INTEGER PRIMARY KEY CHECK(id=1),meta_json TEXT NOT NULL)");
    const row=store.db.prepare("SELECT meta_json FROM evaluation_workspace WHERE id=1").get();
    if(row&&!resume)throw new Error("评测工作目录已有记录；请使用 --resume，或指定新目录");
    if(!row&&resume)throw new Error("评测工作目录没有可恢复的记录");
    let meta=row?JSON.parse(row.meta_json):{fingerprint,runId:randomUUID(),sourceId:null,queryCount:0,elapsedMs:0};
    if(meta.fingerprint!==fingerprint)throw new Error("评测检查点的数据源、参考集、选表或已核验知识已变化，请使用新工作目录");
    const save=next=>{meta={...meta,...next};store.db.prepare("INSERT INTO evaluation_workspace(id,meta_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET meta_json=excluded.meta_json").run(JSON.stringify(meta));};
    save({});
    return {store,get meta(){return meta;},save,close(){store.close();lock.close();}};
  }catch(error){store?.close();lock?.close();if(error.code==="SQLITE_BUSY")throw new Error("此评测工作目录正在运行，不能并行续跑");throw error;}
}
