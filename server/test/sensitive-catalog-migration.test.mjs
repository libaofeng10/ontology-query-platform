import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOntologyCandidateService } from "../src/ontology-candidate-service.mjs";
import { applySensitiveCatalogMigration, SENSITIVE_FIELD_RULE_VERSION } from "../src/sensitive-catalog-migration.mjs";
import { createStore } from "../src/store.mjs";

test("sensitive catalog migration is monotonic, versioned and idempotent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sensitive-migration-"));const store=createStore(join(root,"store.sqlite"));
  try {
    const source=store.createSource({name:"migration",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
    store.upsertTable({sourceId:source.id,tableName:"crm_contact",grade:"A",active:1});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"id",dataType:"bigint",isPrimary:1,isUnique:1,isSensitive:0});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"email",dataType:"varchar",isSensitive:0,comment:"联系邮箱"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"name",dataType:"varchar",isSensitive:0,comment:"客户姓名"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"mobile",dataType:"varchar",isSensitive:1,comment:"手机号"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"level",dataType:"varchar",isSensitive:0,comment:"客户等级"});
    const first=applySensitiveCatalogMigration(store);assert.equal(first.scannedColumns,5);assert.equal(first.promotedColumns,2);assert.deepEqual(first.affectedSources,[source.id]);
    const flags=Object.fromEntries(store.listColumns(source.id,"crm_contact").map((column)=>[column.columnName,column.isSensitive]));assert.deepEqual(flags,{id:0,email:1,name:1,mobile:1,level:0});
    assert.equal(JSON.parse(store.getSetting("system.sensitiveFieldRuleVersion").valueJson),SENSITIVE_FIELD_RULE_VERSION);
    const second=applySensitiveCatalogMigration(store);assert.equal(second.skipped,true);assert.equal(second.promotedColumns,0);assert.equal(second.scannedColumns,0);
  } finally { store.close(); }
});

test("sensitivity promotion changes the catalog checksum and blocks stale generation runs",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sensitive-drift-"));const store=createStore(join(root,"store.sqlite"));
  try {
    const source=store.createSource({name:"drift",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
    store.upsertTable({sourceId:source.id,tableName:"crm_contact",grade:"A",active:1});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"email",dataType:"varchar",nullable:1,isSensitive:0,comment:"联系邮箱"});
    const service=createOntologyCandidateService({store,config:{ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{model:"embedding"}},scorer:{score:async()=>{throw new Error("目录漂移应在评分前阻止");}}});
    const run=service.createRun({sourceId:source.id,tableNames:["crm_contact"],domainName:"contact"},"editor-a");
    const migrated=applySensitiveCatalogMigration(store);assert.equal(migrated.promotedColumns,1);
    await assert.rejects(service.evaluateAndStore(run.id,{candidateType:"object",payload:{apiName:"contact",displayName:"联系人",primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table:"crm_contact",column:"id"}}]}}),/物理目录自生成批次创建后已变化/);
  } finally { store.close(); }
});
