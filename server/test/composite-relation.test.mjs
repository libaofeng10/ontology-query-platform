import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { guardSql } from "../src/sql-guard.mjs";
import { introspectSchema } from "../src/db-introspect.mjs";

const relation={id:1,fromTable:"orders",fromCol:"tenant_id",toTable:"customers",toCol:"tenant_id",status:"confirmed",columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"customer_code",toCol:"code"}]};
test("composite relations retain all predicates and do not collide on the first pair",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"composite-store-")),store=createStore(join(dir,"test.sqlite"));
  try{
    const a=store.upsertRelation({...relation,sourceId:1});
    const b=store.upsertRelation({...relation,sourceId:1,columnPairs:[relation.columnPairs[0],{fromCol:"billing_code",toCol:"code"}]});
    assert.notEqual(a.id,b.id);assert.deepEqual(store.listRelations(1)[0].columnPairs,relation.columnPairs);
    assert.equal(store.upsertRelation({...relation,sourceId:1}).id,a.id);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("foreign key metadata groups a composite constraint into one relation",async()=>{
  const sql=[];const schema=await introspectSchema({query:async(_source,query)=>{sql.push(query);return [query.includes("KEY_COLUMN_USAGE")?relation.columnPairs.map((pair,index)=>({...relation,...pair,constraintName:"fk_customer",ordinalPosition:index+1})):[]];}},{dbName:"sales"});
  assert.equal(schema.foreignKeys.length,1);assert.deepEqual(schema.foreignKeys[0].columnPairs,relation.columnPairs);
  assert.match(sql[1],/column_count=1/);
});
test("SQL guard requires the complete composite constraint within one AND and alias pair",()=>{
  const options={allowedTables:["orders","customers"],allowedColumns:{orders:["tenant_id","customer_code"],customers:["tenant_id","code"]},allowedRelations:[relation]};
  const valid="SELECT o.customer_code FROM orders o JOIN customers c ON o.tenant_id=c.tenant_id AND o.customer_code=c.code";
  assert.equal(guardSql(valid,options).ok,true);
  for(const sql of [
    "SELECT o.customer_code FROM orders o JOIN customers c ON o.customer_code=c.code",
    valid.replace(" AND "," OR "),
    "SELECT o.customer_code FROM orders o JOIN customers c ON o.tenant_id=c.tenant_id JOIN customers d ON o.customer_code=d.code",
    "SELECT o.customer_code FROM orders o WHERE o.customer_code IN (SELECT code FROM customers)",
  ])assert.equal(guardSql(sql,options).ok,false,sql);
});

test("联合主键及联合唯一的成员不能充当标量对象标识，单列唯一仍可用",async()=>{
  const members=[{column:"tenant_id",ordinal:1},{column:"code",ordinal:2}];
  const raw=members.map(member=>({tableName:"customers",columnName:member.column,dataType:"bigint",isPrimary:1,isUnique:1,keyConstraints:JSON.stringify([{name:"PRIMARY",unique:1,members}])}));
  raw.push({tableName:"customers",columnName:"id",isPrimary:0,isUnique:1,keyConstraints:[{name:"uq_id",unique:1,members:[{column:"id",ordinal:1}]}]});
  const catalog=await introspectSchema({query:async(_source,sql)=>[sql.includes("information_schema.COLUMNS")?raw:[]]},{dbName:"sales"});
  assert.deepEqual(catalog.columns.map(c=>[c.isPrimary,c.isUnique]),[[0,0],[0,0],[0,1]]);
});

test("联合关系快照、Schema 校验与护栏保留第二个等式，非首成员变更使目录失效",async()=>{
  const {validateSemanticSchema}=await import("../src/semantic-schema.mjs");
  const {ontologyCatalogChecksum}=await import("../src/ontology-candidate-service.mjs");
  const {createClaudeQuerySnapshot}=await import("../src/claude-query-snapshot.mjs");
  const columnsByTable={orders:["id","tenant_id","customer_code"],customers:["id","tenant_id","code"]};
  const catalog={sourceId:1,tables:Object.keys(columnsByTable).map(tableName=>({tableName,grade:"A",active:1})),columnsByTable:Object.fromEntries(Object.entries(columnsByTable).map(([table,columns])=>[table,columns.map(columnName=>({columnName,dataType:"bigint",nullable:0,isPrimary:Number(columnName==="id"),isUnique:Number(columnName==="id")}))])),relations:[relation]};
  const schema={name:"sales",objectTypes:Object.keys(columnsByTable).map(table=>({apiName:table,primaryKey:"id",properties:[{apiName:"id",type:"integer",required:true,mapping:{table,column:"id"}}]})),linkTypes:[{apiName:"order_customer",source:"orders",target:"customers",cardinality:"many_to_one",relationMappings:[{relationId:1}]}]};
  // The composite constraint must survive both snapshot serving and schema validation,
  // and a change to any member (not just the first) must invalidate the schema catalog.
  const snapshot=createClaudeQuerySnapshot({sourceId:1,published:{sourceId:1,id:1,status:"published",schema},catalog});
  assert.deepEqual(snapshot.relations[0].columnPairs,relation.columnPairs);
  assert.equal(validateSemanticSchema(schema,catalog).ok,true);
  const changed=structuredClone(catalog);changed.columnsByTable.orders=changed.columnsByTable.orders.filter(c=>c.columnName!=="customer_code");
  assert.notEqual(ontologyCatalogChecksum(catalog),ontologyCatalogChecksum(changed));
  assert.equal(validateSemanticSchema(schema,changed).ok,false);
});

test("联合自关联不能用单列、不同 JOIN 或子查询拼接条件绕过",()=>{
  const self={...relation,fromTable:"people",toTable:"people",columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"parent_id",toCol:"id"}]};
  const options={allowedTables:["people"],allowedColumns:{people:["tenant_id","parent_id","id"]},allowedRelations:[self]};
  assert.equal(guardSql("SELECT p.id FROM people p JOIN people q ON p.tenant_id=q.tenant_id AND p.parent_id=q.id",options).ok,true);
  for(const sql of [
    "SELECT p.id FROM people p JOIN people q ON p.tenant_id=q.tenant_id",
    "SELECT p.id FROM people p JOIN people q ON p.parent_id=q.id",
    "SELECT p.id FROM people p WHERE p.parent_id IN (SELECT q.id FROM people q)",
    "SELECT p.id FROM people p JOIN people q ON p.tenant_id=q.tenant_id WHERE EXISTS (SELECT r.id FROM people r WHERE p.parent_id=r.id)",
  ])assert.equal(guardSql(sql,options).ok,false,sql);
  const cross={allowedTables:["orders","customers"],allowedColumns:{orders:["tenant_id","customer_code"],customers:["tenant_id","code"]},allowedRelations:[relation]};
  const cte="WITH o AS (SELECT x.tenant_id,x.customer_code FROM orders x) SELECT o.customer_code FROM o JOIN customers c ON o.tenant_id=c.tenant_id AND o.customer_code=c.code";
  assert.equal(guardSql(cte,cross).ok,true);
  assert.equal(guardSql(cte.replace("x.customer_code FROM orders x","y.customer_code FROM orders x JOIN orders y ON x.customer_code=y.customer_code"),cross).ok,false);
});

test("旧关系表迁移保留 ID 和人工状态，外键碎片须重探，重复启动幂等",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"legacy-relation-")),path=join(dir,"store.sqlite");let store=createStore(path);
  try{
    store.db.exec("DROP TABLE ds_relation; CREATE TABLE ds_relation (id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,from_table TEXT NOT NULL,from_col TEXT NOT NULL,to_table TEXT NOT NULL,to_col TEXT NOT NULL,cardinality TEXT,confidence REAL NOT NULL,overlap_ratio REAL,status TEXT NOT NULL DEFAULT 'review',present INTEGER NOT NULL DEFAULT 1,UNIQUE(source_id,from_table,from_col,to_table,to_col)); INSERT INTO ds_relation(id,source_id,from_table,from_col,to_table,to_col,confidence,status) VALUES(42,1,'orders','customer_id','customers','id',1,'confirmed');");
    store.close();store=createStore(path);
    assert.equal(store.listRelations(1,true)[0].id,42);assert.deepEqual(store.listRelations(1,true)[0].columnPairs,[{fromCol:"customer_id",toCol:"id"}]);
    store.close();store=createStore(path);assert.equal(store.listRelations(1).length,1);
    const next=store.upsertRelation({...relation,sourceId:1});assert.ok(next.id>42);
    // Recreate a legacy FK to exercise the lack-of-grouping transition.
    store.db.exec("DROP TABLE ds_relation; CREATE TABLE ds_relation (id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,from_table TEXT NOT NULL,from_col TEXT NOT NULL,to_table TEXT NOT NULL,to_col TEXT NOT NULL,cardinality TEXT,confidence REAL NOT NULL,overlap_ratio REAL,status TEXT NOT NULL DEFAULT 'review',present INTEGER NOT NULL DEFAULT 1,inference_source TEXT,UNIQUE(source_id,from_table,from_col,to_table,to_col)); INSERT INTO ds_relation(id,source_id,from_table,from_col,to_table,to_col,confidence,status,inference_source) VALUES(42,1,'orders','customer_id','customers','id',1,'confirmed','foreign_key');");
    store.close();store=createStore(path);assert.equal(store.listRelations(1,true).length,0);
    const refreshed=store.upsertRelation({sourceId:1,fromTable:"orders",fromCol:"customer_id",toTable:"customers",toCol:"id",inferenceSource:"foreign_key",status:"confirmed"});
    assert.equal(refreshed.id,42);assert.equal(store.listRelations(1,true).length,1);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
