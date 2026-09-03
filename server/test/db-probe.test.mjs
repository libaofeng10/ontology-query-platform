import test from "node:test";
import assert from "node:assert/strict";
import { probeTable } from "../src/db-probe.mjs";

test("a sample that cannot cover the whole table yields cardinality but no dictionary",async()=>{
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
  assert.equal(result.columns[0].cardinality,2);
  assert.deepEqual(result.columns[0].enums,[]);
});

test("a low-cardinality business dictionary covered by the sample is still registered",async()=>{
  const connector={query:async()=>[[{value:"paid",count:8},{value:"pending",count:2}]]};
  const result=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:800},
    [{columnName:"status",dataType:"varchar(32)"}],
  );

  assert.equal(result.columns[0].cardinality,2);
  assert.deepEqual(result.columns[0].enums.map(({value,count,ratio})=>({value,count,ratio})),[
    {value:"paid",count:8,ratio:0.8},
    {value:"pending",count:2,ratio:0.2},
  ]);
});

test("identifier-shaped columns never become dictionaries even with a single sampled value",async()=>{
  const connector={query:async()=>[[{value:"13774665233",count:1}]]};
  const result=await probeTable(connector,{},
    {tableName:"alpha",rowEstimate:5_000},
    [{columnName:"alp_cell",dataType:"varchar(32)"},{columnName:"contract_no",dataType:"varchar(64)"},{columnName:"biz_state",dataType:"varchar(16)"}],
  );

  const byName=Object.fromEntries(result.columns.map((column)=>[column.columnName,column]));
  assert.equal(byName.alp_cell.cardinality,1);
  assert.deepEqual(byName.alp_cell.enums,[]);
  assert.deepEqual(byName.contract_no.enums,[]);
  assert.equal(byName.biz_state.enums.length,1);
});

// T8: in a dictionary-sized dimension table the label column IS the business
// dictionary, and its distinct ratio is expected to be ~1.0 — the ratio gate and
// the old blanket name blacklist both got this wrong.
test("a dictionary-sized dimension table registers its label column despite the ratio",async()=>{
  const rows=Array.from({length:12},(_item,index)=>({value:`渠道${index}`,count:1}));
  const connector={query:async()=>[rows]};
  const dimension=await probeTable(connector,{},
    {tableName:"alpha_crm_channel",rowEstimate:12},
    [{columnName:"channel_name",dataType:"varchar(64)"}],
  );
  assert.equal(dimension.columns[0].enums.length,12);

  // The same label column on a table above the dimension cap keeps the old refusal.
  const large=await probeTable(connector,{},
    {tableName:"clue",rowEstimate:5_000},
    [{columnName:"channel_name",dataType:"varchar(64)"}],
  );
  assert.deepEqual(large.columns[0].enums,[]);

  // A bounded dictionary that outgrows the default cap (a 54-row channel list, say) still
  // registers when the source opts into a higher cap via discovery config. This is the
  // alpha_crm_channel.channel_name case — the label is the vocabulary, so it must enter the
  // dictionary even though estimatedRows(54) > DEFAULT(20).
  // The connector honors the SQL LIMIT the way MySQL does: it returns only the requested
  // number of rows. Without the fix the sampler LIMIT stays at 21, the 54-value dictionary
  // is truncated to 21, and the tail values (the ones a user types) never register.
  const channelRows=Array.from({length:54},(_item,index)=>({value:index===0?"抖音":`渠道${index}`,count:1}));
  const channelConnector={query:async(_source,sql)=>{
    const limit=Number(/LIMIT (\d+)/.exec(sql)?.[1]||0);
    return [channelRows.slice(0,limit)];
  }};
  const channel=await probeTable(channelConnector,{},
    {tableName:"alpha_crm_channel",rowEstimate:54},
    [{columnName:"channel_name",dataType:"varchar(64)"}],
    {labelDictionaryMaxRows:100},
  );
  assert.equal(channel.columns[0].enums.length,54,"配置上调上限后标签列恢复登记，L 采样 LIMIT 同步放大");
  assert.equal(channel.columns[0].enums[0].value,"抖音","文本标签值本身就是字典成员");

  // Without the config the same table stays refused (conservative default).
  const strict=await probeTable(channelConnector,{},
    {tableName:"alpha_crm_channel",rowEstimate:54},
    [{columnName:"channel_name",dataType:"varchar(64)"}],
  );
  assert.deepEqual(strict.columns[0].enums,[]);

  // Identifier suffixes stay rejected even inside a dictionary-sized table.
  const identifier=await probeTable(connector,{},
    {tableName:"alpha_crm_channel",rowEstimate:12},
    [{columnName:"channel_code",dataType:"varchar(32)"}],
  );
  assert.deepEqual(identifier.columns[0].enums,[]);

  // 2026-09-04 敏感列逻辑已移除：探测阶段不再推断 isSensitive，label 列（owner_name）
  // 在字典规模的表里正常登记枚举，不再因为"敏感"被跳过。
  const person=await probeTable(connector,{},
    {tableName:"tiny_owner",rowEstimate:12},
    [{columnName:"owner_name",dataType:"varchar(64)"}],
  );
  assert.equal(person.columns[0].isSensitive,0);
  assert.equal(person.columns[0].enums.length,12);
});

test("distinct values above the cardinality ratio are not a dictionary",async()=>{
  const rows=Array.from({length:12},(_item,index)=>({value:`v${index}`,count:1}));
  const connector={query:async()=>[rows]};
  const narrow=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:100},
    [{columnName:"status",dataType:"varchar(32)"}],
  );
  assert.equal(narrow.columns[0].cardinality,12);
  assert.deepEqual(narrow.columns[0].enums,[]);

  const wide=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:4_000},
    [{columnName:"status",dataType:"varchar(32)"}],
  );
  assert.equal(wide.columns[0].enums.length,12);
});

test("the cardinality ratio threshold is configurable",async()=>{
  const connector={query:async()=>[[{value:"a",count:1},{value:"b",count:1}]]};
  const strict=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:100},
    [{columnName:"status",dataType:"varchar(32)"}],
    {enumMaxDistinctRatio:0.01},
  );
  assert.deepEqual(strict.columns[0].enums,[]);

  const relaxed=await probeTable(connector,{},
    {tableName:"orders",rowEstimate:100},
    [{columnName:"status",dataType:"varchar(32)"}],
    {enumMaxDistinctRatio:0.5},
  );
  assert.equal(relaxed.columns[0].enums.length,2);
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

test("db-probe no longer infers isSensitive for email/name-comment columns",async()=>{
  const queries=[];const connector={query:async(_source,sql)=>{queries.push(sql);return [[]];}};
  const result=await probeTable(connector,{},
    {tableName:"crm_contact",rowEstimate:20_000},
    [{columnName:"email",dataType:"varchar(255)",comment:"联系邮箱"},{columnName:"name",dataType:"varchar(50)",comment:"客户姓名"},{columnName:"level",dataType:"varchar(20)",comment:"客户等级"}],
  );
  // 2026-09-04 敏感列逻辑已移除：isSensitive 恒为 0，所有列都参与常规枚举采样查询。
  assert.deepEqual(result.columns.map((column)=>column.isSensitive),[0,0,0]);
  assert.equal(queries.length,3);
});

test("profiling samples a table once and now also profiles previously-sensitive columns",async()=>{
  const queries=[];const connector={query:async(_source,sql)=>{queries.push(sql);if(sql.includes("GROUP BY"))return [[{value:"active",count:2}]];return [[{id:2,status:"active",customer_code:"CUS-000002",email:null},{id:1,status:"active",customer_code:"CUS-000001",email:null}]];}};
  const result=await probeTable(connector,{},
    {tableName:"customer",rowEstimate:500},
    [{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"status",dataType:"varchar(20)"},{columnName:"customer_code",dataType:"text"},{columnName:"email",dataType:"varchar(255)"}],
    {profiling:{enabled:true,sampleLimit:100,timeoutMs:1000}},
  );
  // 2026-09-04 敏感列逻辑已移除：email 不再被跳过，正常参与采样和画像
  // （连接器桩返回的 email 值全部为 null，因此 profile 的 nullRatio 为 1）。
  assert.equal(result.columns.find((column)=>column.columnName==="email").profile.profile.nullRatio,1);
  assert.deepEqual(result.columns.find((column)=>column.columnName==="status").profile.profile.sampleValues,["active"]);
  assert.deepEqual(result.columns.find((column)=>column.columnName==="customer_code").profile.profile.sampleValues,["CUS-000001","CUS-000002"]);
  assert.ok(queries.some((sql)=>/SELECT `id`, `customer_code`, `email` FROM `customer` ORDER BY `id` DESC LIMIT 100/.test(sql)));
});
