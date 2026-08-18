import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildColumnProfile, detectSensitiveValue } from "../src/column-profile.mjs";
import { createStore } from "../src/store.mjs";
import { ontologyCatalogChecksum } from "../src/ontology-candidate-service.mjs";

test("value profiling suppresses phone, identity, email and bank-card values",()=>{
  for(const value of ["13800138000","11010519491231002X","user@example.com","6222020202020202"])assert.equal(detectSensitiveValue(value).sensitive,true,value);
  const profiled=buildColumnProfile({values:["user@example.com","normal","normal",null],dataType:"varchar(255)"});
  assert.deepEqual(profiled.profile.sampleValues,[]);
  assert.equal(profiled.profile.minMax,null);
  assert.equal(profiled.profile.sensitiveValuesSuppressed,true);
  assert.match(profiled.profile.formatPattern,/<email>/);
  assert.doesNotMatch(JSON.stringify(profiled),/user@example\.com|normal/);
});

test("profiles infer bounded examples, format and numeric range",()=>{
  const profiled=buildColumnProfile({values:["CUS-000002","CUS-000001","CUS-000002",null],dataType:"varchar(20)"});
  assert.deepEqual(profiled.profile.sampleValues,["CUS-000002","CUS-000001"]);
  assert.equal(profiled.profile.formatPattern,"CUS-\\d{6}");
  assert.equal(profiled.profile.distinctCount,2);
  assert.equal(profiled.profile.nullRatio,.25);
  const numeric=buildColumnProfile({values:[3,1,2],dataType:"bigint"});
  assert.deepEqual(numeric.profile.minMax,{min:1,max:3});
});

test("catalog checksum ignores sampledAt but changes with profile content",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-profile-store-"));const store=createStore(join(root,"store.sqlite"));
  try{
    store.upsertTable({sourceId:1,tableName:"customer",grade:"A",active:1});
    store.upsertColumn({sourceId:1,tableName:"customer",columnName:"code",dataType:"varchar(20)"});
    store.upsertColumnProfile({sourceId:1,tableName:"customer",columnName:"code",profile:{sampleValues:["CUS-1"],formatPattern:"CUS-\\d{1}",distinctCount:1,nullRatio:0,minMax:null,sensitiveValuesSuppressed:false},sampleSize:1,profileVersion:"v1",sampledAt:"2026-08-14T00:00:00.000Z"});
    const catalog=()=>({sourceId:1,tables:store.listTables(1),columnsByTable:{customer:store.listColumns(1,"customer")},enumsByTable:{customer:[]},relations:[]});
    const first=ontologyCatalogChecksum(catalog());
    store.upsertColumnProfile({sourceId:1,tableName:"customer",columnName:"code",profile:{sampleValues:["CUS-1"],formatPattern:"CUS-\\d{1}",distinctCount:1,nullRatio:0,minMax:null,sensitiveValuesSuppressed:false},sampleSize:1,profileVersion:"v1",sampledAt:"2026-08-15T00:00:00.000Z"});
    assert.equal(ontologyCatalogChecksum(catalog()),first);
    store.upsertColumnProfile({sourceId:1,tableName:"customer",columnName:"code",profile:{sampleValues:["CUS-2"],formatPattern:"CUS-\\d{1}",distinctCount:1,nullRatio:0,minMax:null,sensitiveValuesSuppressed:false},sampleSize:1,profileVersion:"v1",sampledAt:"2026-08-15T00:00:00.000Z"});
    assert.notEqual(ontologyCatalogChecksum(catalog()),first);
  }finally{store.close();}
});
