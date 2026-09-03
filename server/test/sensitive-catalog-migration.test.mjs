import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOntologyCandidateService } from "../src/ontology-candidate-service.mjs";
import { createObjectStableKey } from "../src/ontology-candidate-score.mjs";
import { applySensitiveCatalogMigration, SENSITIVE_FIELD_RULE_VERSION } from "../src/sensitive-catalog-migration.mjs";
import { createStore } from "../src/store.mjs";

test("sensitive catalog migration is a versioned no-op: it never promotes columns and is idempotent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sensitive-migration-"));const store=createStore(join(root,"store.sqlite"));
  try {
    const source=store.createSource({name:"migration",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
    store.upsertTable({sourceId:source.id,tableName:"crm_contact",grade:"A",active:1});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"id",dataType:"bigint",isPrimary:1,isUnique:1,isSensitive:0});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"email",dataType:"varchar",isSensitive:0,comment:"联系邮箱"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"name",dataType:"varchar",isSensitive:0,comment:"客户姓名"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"mobile",dataType:"varchar",isSensitive:1,comment:"手机号"});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"level",dataType:"varchar",isSensitive:0,comment:"客户等级"});
    // 2026-09-04 敏感列逻辑已移除：迁移变成 no-op，只写版本设置，不再扫描或
    // promote 任何列。已有的 isSensitive 标记（这里的 mobile=1）原样保留。
    const first=applySensitiveCatalogMigration(store);
    assert.deepEqual(first,{version:SENSITIVE_FIELD_RULE_VERSION,previousVersion:null,scannedColumns:0,promotedColumns:0,affectedSources:[],skipped:true});
    const flags=Object.fromEntries(store.listColumns(source.id,"crm_contact").map((column)=>[column.columnName,column.isSensitive]));
    assert.deepEqual(flags,{id:0,email:0,name:0,mobile:1,level:0});
    assert.equal(JSON.parse(store.getSetting("system.sensitiveFieldRuleVersion").valueJson),SENSITIVE_FIELD_RULE_VERSION);
    const second=applySensitiveCatalogMigration(store);
    assert.equal(second.skipped,true);
    assert.equal(second.promotedColumns,0);
    assert.equal(second.scannedColumns,0);
    assert.equal(second.previousVersion,SENSITIVE_FIELD_RULE_VERSION);
  } finally { store.close(); }
});

test("no-op migration never perturbs the catalog checksum, so a queued generation run is not blocked by it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sensitive-drift-"));const store=createStore(join(root,"store.sqlite"));
  try {
    const source=store.createSource({name:"drift",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
    store.upsertTable({sourceId:source.id,tableName:"crm_contact",grade:"A",active:1});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0});
    store.upsertColumn({sourceId:source.id,tableName:"crm_contact",columnName:"email",dataType:"varchar",nullable:1,isSensitive:0,comment:"联系邮箱"});
    let scored=false;
    const service=createOntologyCandidateService({store,config:{ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{model:"embedding"}},scorer:{score:async(candidate)=>{scored=true;return {score:90,status:"auto_confirmed",forcedReviewReasons:[],validation:{ok:true,errors:[],warnings:[]},scoreBreakdown:{},stableKey:createObjectStableKey({namespace:candidate.namespace,payload:candidate.payload})};}}});
    const run=service.createRun({sourceId:source.id,tableNames:["crm_contact"],domainName:"contact"},"editor-a");
    // 迁移不再 promote 任何列，因此不再改变目录 checksum；随后的评估不应因
    // "目录已变化" 被拒绝。
    const migrated=applySensitiveCatalogMigration(store);
    assert.equal(migrated.promotedColumns,0);
    await service.evaluateAndStore(run.id,{candidateType:"object",payload:{apiName:"contact",displayName:"联系人",primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table:"crm_contact",column:"id"}}]}});
    assert.equal(scored,true);
  } finally { store.close(); }
});
