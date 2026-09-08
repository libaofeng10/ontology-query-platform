import assert from 'node:assert/strict';
import test from 'node:test';
import {createQueryExecutionKernel} from '../src/query-execution-kernel.mjs';
import {createClaudeQueryMcpSession} from '../src/claude-query-mcp.mjs';
import {createClaudeQuerySnapshot} from '../src/claude-query-snapshot.mjs';
import {createClaudeQueryBridge} from '../src/claude-query-bridge.mjs';

const schemaError=(code='ER_BAD_FIELD_ERROR')=>Object.assign(new Error("Unknown column 'office_name' in 'field list'"),{code});
function setup({maxSqlCalls=5,explain=async()=>[{rows:1}],query=async()=>[[],[]],schemaMode='database'}={}) {
  const columnsByTable={office:[{columnName:'id',dataType:'varchar',comment:'系统所属机构ID'},{columnName:'name',dataType:'varchar',comment:'机构名称'}],users:[{columnName:'id'},{columnName:'office_id',comment:'所属机构ID'},{columnName:'office_name',comment:'所属机构名称'},{columnName:'name'},{columnName:'phone'},{columnName:'activated_at'},{columnName:'expires_at'}]};
  const catalog={tables:Object.keys(columnsByTable).map(tableName=>({tableName})),columnsByTable};
  const snapshot=createClaudeQuerySnapshot({sourceId:1,published:{sourceId:1,version:14,status:'published',schema:{name:'accounts',objectTypes:[],linkTypes:[]}},catalog});
  const kernel=createQueryExecutionKernel({source:{id:1},schemaMode,catalog,disclosedTables:['office','users'],connector:{explain,query},config:{queryMaxRows:100,maxSqlCalls,queryAgentMaxSqlCalls:maxSqlCalls,explainMaxRows:100}});
  return {snapshot,kernel};
}

test('四次空定位后列名错误提供真实字段且保留最后的明细额度，结果仍由执行凭据交付',async()=>{
  const users=Array.from({length:16},(_,index)=>({name:`测试用户${index}`,phone:`1390000${String(index).padStart(4,'0')}`,activated_at:'2025-01-01',expires_at:'2027-01-01'}));
  const f=setup({explain:async(_source,sql)=>{if(sql.includes('`office_name`')&&sql.includes('FROM `office`'))throw schemaError();return [{rows:16}];},query:async(_source,sql)=>sql.includes('`office_id`')?[users,Object.keys(users[0]).map(name=>({name}))]:[[],[{name:'id'}]]});
  const session=await createClaudeQueryMcpSession({...f,listen:false,previewRows:0});
  try{
    for(let i=0;i<4;i++){const empty=await session.callTool('db_query',{sql:`SELECT id FROM users WHERE id = 'wrong-${i}'`});assert.equal(empty.ok,true);assert.equal(empty.rowCount,0);assert.equal(empty.queryBudget.remaining,4-i);if(i)assert.match(empty.nextStep,/不要继续把同一 ID/);}
    const bad=await session.callTool('db_query',{sql:"SELECT id, office_name FROM office WHERE id='system-42'"});
    assert.equal(bad.ok,false);assert.equal(bad.errorCode,'UNKNOWN_COLUMN');assert.equal(bad.failureClass,'schema_gap');assert.equal(bad.queryBudget.remaining,1);
    assert.equal(bad.recovery.allowanceUsed,true);assert.ok(bad.recovery.tables[0].columns.some(column=>column.columnName==='name'));assert.equal(bad.recovery.tables[0].columns.some(column=>column.columnName==='office_name'),false);
    const result=await session.callTool('db_query',{sql:"SELECT name, phone, activated_at, expires_at FROM users WHERE office_id='system-42' AND office_name LIKE '%示例事务所%'"});
    assert.equal(result.ok,true,result.error);assert.equal(result.rowCount,16);assert.equal(result.queryBudget.remaining,0);assert.deepEqual(result.previewRows,[]);assert.deepEqual(f.kernel.getRun(result.executionId).rows,users);
    const denied=await session.callTool('db_query',{sql:'SELECT id FROM users'});assert.equal(denied.errorCode,'SQL_CALL_BUDGET_EXCEEDED');assert.equal(denied.queryBudget.used,5);
  }finally{await session.close();}
});

test('数据库 schema 错误最多补偿两次，不能无限尝试错误 SQL',async()=>{
  let attempts=0;const f=setup({maxSqlCalls:1,explain:async()=>{attempts++;throw schemaError();}});
  for(let i=0;i<3;i++){const bad=await f.kernel.execute({sql:'SELECT office_name FROM office'});assert.equal(bad.code,'UNKNOWN_COLUMN');assert.equal(bad.schemaRecovery.allowanceUsed,i<2);}
  assert.equal((await f.kernel.execute({sql:'SELECT name FROM office'})).code,'SQL_CALL_BUDGET_EXCEEDED');assert.equal(attempts,3);assert.equal(f.kernel.stats().schemaRepairs,2);
});

test('只补偿数据库明确的表列错误，空结果、扫描超限、超时和策略拒绝仍消耗原额度',async t=>{
  for(const kind of ['empty','scan','timeout','policy'])await t.test(kind,async()=>{
    let touched=0;const f=setup({maxSqlCalls:1,explain:async()=>{touched++;if(kind==='timeout')throw Object.assign(new Error('query timed out'),{code:'QUERY_TIMEOUT'});return [{rows:kind==='scan'?101:1}];}});
    const first=await f.kernel.execute({sql:kind==='policy'?'DELETE FROM users':'SELECT id FROM users'});assert.equal(first.ok,kind==='empty');
    assert.equal(f.kernel.stats().schemaRepairs,0);assert.equal((await f.kernel.execute({sql:'SELECT id FROM users'})).code,'SQL_CALL_BUDGET_EXCEEDED');assert.equal(touched,kind==='policy'?0:1);
  });
});

test('query 阶段表列错误也可修正；错误表不在快照中时仍允许数据库证明修正后的查询',async()=>{
  let first=true;const f=setup({maxSqlCalls:1,query:async()=>{if(first){first=false;throw schemaError('ER_NO_SUCH_TABLE');}return [[{name:'示例'}],[{name:'name'}]];}});
  const session=await createClaudeQueryMcpSession({...f,listen:false});
  try{const bad=await session.callTool('db_query',{sql:'SELECT name FROM unlisted'});assert.equal(bad.errorCode,'UNKNOWN_TABLE');assert.deepEqual(bad.recovery.tables,[]);assert.equal(bad.queryBudget.remaining,1);
    const good=await session.callTool('db_query',{sql:'SELECT name FROM corrected_unlisted'});assert.equal(good.ok,true);assert.equal(good.rowCount,1);
  }finally{await session.close();}
});

test('SQL 修复不放宽只读、跨库或累计扫描约束，clear 重置请求额度',async()=>{
  const f=setup({explain:async()=>{throw schemaError();}});
  assert.equal((await f.kernel.execute({sql:'SELECT office_name FROM office'})).code,'UNKNOWN_COLUMN');
  assert.equal((await f.kernel.execute({sql:'SELECT name FROM other_db.office'})).code,'CROSS_DATABASE_FORBIDDEN');
  assert.equal((await f.kernel.execute({sql:'UPDATE office SET name = 1'})).code,'NON_SELECT');
  assert.equal(f.kernel.stats().schemaRepairs,1);f.kernel.clear();assert.equal(f.kernel.stats().schemaRepairs,0);assert.equal(f.kernel.stats().sqlCalls,0);
});

test('查询契约使用名称和 ID 联合定位，不把团队名称当成 ID 字段归属',async()=>{
  let prompt;const f=setup();const session=await createClaudeQueryMcpSession({...f,listen:false});
  const bridge=createClaudeQueryBridge({transport:async input=>{prompt=input.prompt;return {status:'clarification',question:'存在两个同名系统，请指定系统'};}});
  try{const outcome=await bridge.run({...f,mcp:session,question:'示例事务所 王某团队 system-42 查询该系统用户姓名、手机号、激活时间、到期时间'});
    assert.equal(outcome.status,'clarification');assert.match(prompt,/团队字样不等于该 ID 是 team_id/);assert.match(prompt,/不确定时用 get_tables/);assert.match(prompt,/最多 2 次修正机会/);assert.match(prompt,/queryBudget/);
  }finally{await bridge.close();await session.close();}
});
