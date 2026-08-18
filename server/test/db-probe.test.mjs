import test from "node:test";
import assert from "node:assert/strict";
import { probeTable } from "../src/db-probe.mjs";

test("large-table enum probes aggregate a bounded input sample",async()=>{
  const queries=[];
  const connector={query:async(_source,sql)=>{
    queries.push(sql);
    return [[{value:"paid",count:8},{value:"pending",count:2}]];
  }};
  const updateTime="2026-08-12T10:00:00.000Z";
  const result=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:40_000_000,updateTime},
    [{columnName:"status",dataType:"varchar(32)"},{columnName:"updated_at",dataType:"datetime"}],
  );

  assert.equal(queries.length,1);
  assert.match(queries[0],/FROM \(SELECT `status` FROM `orders` WHERE `status` IS NOT NULL LIMIT 10000\) AS ontoquery_sample GROUP BY `status`/);
  assert.equal(result.lastWrite,updateTime);
  assert.deepEqual(result.columns[0].enums.map(({value,count,ratio})=>({value,count,ratio})),[
    {value:"paid",count:8,ratio:0.8},
    {value:"pending",count:2,ratio:0.2},
  ]);
});

test("small tables may still use an exact last-write probe",async()=>{
  const queries=[];
  const connector={query:async(_source,sql)=>{
    queries.push(sql);
    return sql.startsWith("SELECT MAX")?[[{lastWrite:"2026-08-12T11:00:00.000Z"}]]:[[]];
  }};
  const result=await probeTable(connector,{},
    {tableName:"small_orders",rowEstimate:200,updateTime:null},
    [{columnName:"updated_at",dataType:"datetime"}],
  );

  assert.equal(queries.length,1);
  assert.match(queries[0],/^SELECT MAX\(`updated_at`\)/);
  assert.equal(result.lastWrite,"2026-08-12T11:00:00.000Z");
});

test("schema-derived identifiers with hyphens are safely quoted",async()=>{
  const queries=[];
  const connector={query:async(_source,sql)=>{queries.push(sql);return [[{value:"active",count:1}]];}};
  await probeTable(connector,{},
    {tableName:"invitation--20190218",rowEstimate:20_000},
    [{columnName:"invite-status",dataType:"varchar(20)"}],
  );

  assert.match(queries[0],/SELECT `invite-status` FROM `invitation--20190218` WHERE `invite-status` IS NOT NULL LIMIT 10000/);
});

test("email and name-comment fields are marked sensitive before enum sampling",async()=>{
  const queries=[];const connector={query:async(_source,sql)=>{queries.push(sql);return [[]];}};
  const result=await probeTable(connector,{},
    {tableName:"crm_contact",rowEstimate:20_000},
    [{columnName:"email",dataType:"varchar(255)",comment:"联系邮箱"},{columnName:"name",dataType:"varchar(50)",comment:"客户姓名"},{columnName:"level",dataType:"varchar(20)",comment:"客户等级"}],
  );
  assert.deepEqual(result.columns.map((column)=>column.isSensitive),[1,1,0]);
  assert.equal(queries.length,1);assert.match(queries[0],/SELECT `level`/);assert.doesNotMatch(queries[0],/`email`|`name`/);
});

test("profiling samples a table once and never profiles sensitive columns",async()=>{
  const queries=[];const connector={query:async(_source,sql)=>{queries.push(sql);if(sql.includes("GROUP BY"))return [[{value:"active",count:2}]];return [[{id:2,status:"active",customer_code:"CUS-000002"},{id:1,status:"active",customer_code:"CUS-000001"}]];}};
  const result=await probeTable(connector,{},
    {tableName:"customer",rowEstimate:2},
    [{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"status",dataType:"varchar(20)"},{columnName:"customer_code",dataType:"text"},{columnName:"email",dataType:"varchar(255)"}],
    {profiling:{enabled:true,sampleLimit:100,timeoutMs:1000}},
  );
  assert.equal(result.columns.find((column)=>column.columnName==="email").profile,null);
  assert.deepEqual(result.columns.find((column)=>column.columnName==="status").profile.profile.sampleValues,["active"]);
  assert.deepEqual(result.columns.find((column)=>column.columnName==="customer_code").profile.profile.sampleValues,["CUS-000001","CUS-000002"]);
  assert.ok(queries.some((sql)=>/SELECT `id`, `customer_code` FROM `customer` ORDER BY `id` DESC LIMIT 100/.test(sql)));
  assert.ok(queries.every((sql)=>!sql.includes("`email`")));
});
