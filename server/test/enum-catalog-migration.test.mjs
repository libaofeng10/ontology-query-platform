import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEnumCatalogMigration, ENUM_DICTIONARY_RULE_VERSION } from "../src/enum-catalog-migration.mjs";
import { createStore } from "../src/store.mjs";

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-enum-migration-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"enum-cleanup",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"alpha",grade:"A",active:1});
  store.upsertColumn({sourceId:source.id,tableName:"alpha",columnName:"alp_cell",dataType:"varchar",isSensitive:0});
  store.upsertColumn({sourceId:source.id,tableName:"alpha",columnName:"status",dataType:"varchar",isSensitive:0});
  store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"alp_cell",value:"13774665233",count:1,ratio:1});
  store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"contract_no",value:"C-001",count:1,ratio:0.5});
  store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"contract_no",value:"C-002",count:1,ratio:0.5});
  store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"status",value:"paid",count:8,ratio:0.8,meaning:"已支付",meaningSource:"human"});
  store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"status",value:"pending",count:2,ratio:0.2});
  return {store,source};
}

test("enum catalog migration removes blacklisted columns wholesale and is idempotent",async()=>{
  const {store,source}=await createFixture();
  try {
    store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"alp_cell",value:"13800000000",count:1,ratio:0.5,meaning:"测试号",meaningSource:"human"});
    const first=applyEnumCatalogMigration(store);
    assert.equal(first.skipped,false);
    assert.equal(first.scannedColumns,3);
    assert.equal(first.removedColumns,2);
    assert.equal(first.removedValues,4);
    assert.equal(first.removedHumanMeanings,1);
    assert.deepEqual(first.affectedSources,[source.id]);
    assert.equal(JSON.parse(store.getSetting("system.enumDictionaryRuleVersion").valueJson),ENUM_DICTIONARY_RULE_VERSION);

    const remaining=store.listEnums(source.id,"alpha");
    assert.deepEqual([...new Set(remaining.map((item)=>item.columnName))],["status"]);
    assert.equal(remaining.length,2);
    assert.equal(remaining.find((item)=>item.value==="paid").meaning,"已支付");

    const second=applyEnumCatalogMigration(store);
    assert.equal(second.skipped,true);
    assert.equal(second.removedColumns,0);
    assert.deepEqual(store.listEnums(source.id,"alpha"),remaining);
  } finally { store.close(); }
});

test("enum catalog migration leaves ds_column metadata untouched",async()=>{
  const {store,source}=await createFixture();
  try {
    const before=store.listColumns(source.id,"alpha");
    applyEnumCatalogMigration(store);
    assert.deepEqual(store.listColumns(source.id,"alpha"),before);
  } finally { store.close(); }
});

test("enum catalog migration keeps compliant dictionaries and never uses cardinality",async()=>{
  const {store,source}=await createFixture();
  try {
    // 12 distinct values on a small table would fail the S1 cardinality-ratio gate on a fresh
    // probe, but existing rows are deliberately kept: the migration only trusts the naming rule.
    for(let index=0;index<12;index++)store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"biz_state",value:`v${index}`,count:1,ratio:1/12});
    const result=applyEnumCatalogMigration(store);
    assert.equal(result.removedColumns,2);
    assert.equal(store.listEnums(source.id,"alpha").filter((item)=>item.columnName==="biz_state").length,12);
  } finally { store.close(); }
});

// T8: v2 deleted every …name column wholesale, including the label columns of small
// dimension tables that are the business dictionary itself. v3 spares exactly that class
// so a re-probe can re-register it without the next server start deleting it again.
test("label columns survive on dictionary-sized dimension tables and nowhere else",async()=>{
  const {store,source}=await createFixture();
  try {
    store.upsertTable({sourceId:source.id,tableName:"alpha_crm_channel",grade:"B",active:1,rowEstimate:12});
    store.upsertEnum({sourceId:source.id,tableName:"alpha_crm_channel",columnName:"channel_name",value:"抖音",count:1,ratio:0.08});
    store.upsertEnum({sourceId:source.id,tableName:"alpha_crm_channel",columnName:"channel_name",value:"百度",count:1,ratio:0.08});
    // The same suffix on a large table, and on a table with no row estimate, stays doomed.
    store.upsertTable({sourceId:source.id,tableName:"clue",grade:"A",active:1,rowEstimate:50_000});
    store.upsertEnum({sourceId:source.id,tableName:"clue",columnName:"channel_name",value:"抖音",count:9,ratio:0.9});
    store.upsertEnum({sourceId:source.id,tableName:"alpha",columnName:"channel_name",value:"抖音",count:9,ratio:0.9});

    const result=applyEnumCatalogMigration(store);
    assert.equal(result.removedColumns,4,"alp_cell、contract_no 与两个大表/无行数估计的 name 列");
    assert.deepEqual(store.listEnums(source.id,"alpha_crm_channel").map((item)=>item.value).sort(),["抖音","百度"].sort());
    assert.equal(store.listEnums(source.id,"clue").length,0);
    assert.equal(store.listEnums(source.id,"alpha").some((item)=>item.columnName==="channel_name"),false);

    const second=applyEnumCatalogMigration(store);
    assert.equal(second.skipped,true);
    assert.equal(store.listEnums(source.id,"alpha_crm_channel").length,2,"幂等：保留的维表字典不因重跑而消失");
  } finally { store.close(); }
});
