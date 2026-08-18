import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { guardSql } from "./sql-guard.mjs";

export function inspectEvaluationReadiness({dbPath,manifestPath,sourceId}) {
  const manifest=readManifest(manifestPath);
  const selectedSourceId=positiveInteger(sourceId??manifest.source?.id,"sourceId");
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try {
    const source=db.prepare(`SELECT id,name,kind,db_name AS dbName,is_demo AS isDemo,last_test_ok AS lastTestOk,last_test_at AS lastTestAt,last_discovery_at AS lastDiscoveryAt FROM ds_source WHERE id=?`).get(selectedSourceId);
    if(!source)return report({manifest,source:null,cases:[],catalog:{tableCount:0,columnCount:0},existing:[],errors:[`数据源 ${selectedSourceId} 不存在`]});
    const tables=db.prepare(`SELECT table_name AS tableName FROM ds_table WHERE source_id=? AND present=1 AND active=1 AND grade<>'C' ORDER BY table_name`).all(selectedSourceId);
    const columns=db.prepare(`SELECT table_name AS tableName,column_name AS columnName FROM ds_column WHERE source_id=? AND present=1 ORDER BY table_name,rowid`).all(selectedSourceId);
    const allowedTableSet=new Set(tables.map((item)=>item.tableName));
    const allowedColumns={};
    for(const column of columns)if(allowedTableSet.has(column.tableName))(allowedColumns[column.tableName]??=[]).push(column.columnName);
    const relations=db.prepare(`SELECT from_table AS fromTable,from_col AS fromCol,to_table AS toTable,to_col AS toCol FROM ds_relation WHERE source_id=? AND present=1 AND status IN ('accepted','confirmed')`).all(selectedSourceId);
    const policy={allowedTables:[...allowedTableSet],allowedColumns,allowedRelations:relations,enums:{},maxRows:10_000};
    const existing=db.prepare(`SELECT id,question,gold_sql AS goldSql,category,held_out AS heldOut FROM ds_eval WHERE source_id=? AND set_name=? AND active=1 ORDER BY id`).all(selectedSourceId,manifest.setName);
    const existingKeys=new Set(existing.map((item)=>caseKey(item.question,item.goldSql)));
    const cases=manifest.cases.map((item,index)=>inspectCase(item,index,policy,existingKeys));
    const errors=[];
    if(manifest.source?.name&&manifest.source.name!==source.name)errors.push(`清单目标源名称 ${manifest.source.name} 与实际源 ${source.name} 不一致`);
    if(source.isDemo)errors.push("Agent 门禁不能在 Demo 数据源运行");
    if(source.lastTestOk!==1)errors.push("数据源尚未通过最近一次只读连接测试");
    return report({manifest,source,cases,catalog:{tableCount:tables.length,columnCount:columns.length},existing,errors});
  } finally { db.close(); }
}

function inspectCase(item,index,policy,existingKeys) {
  const id=String(item.id||`case-${index+1}`);
  const question=String(item.question||"").trim();
  const goldSql=String(item.goldSql||"").trim();
  const errors=[];
  if(!question)errors.push("question 为空");
  if(!goldSql)errors.push("goldSql 为空");
  const verdict=goldSql?guardSql(goldSql,policy):{ok:false,code:"EMPTY_SQL",reason:"SQL 为空",tables:[]};
  if(!verdict.ok)errors.push(`Gold SQL 未通过护栏：${verdict.reason}`);
  const actualTables=new Set((verdict.tables||[]).map(normalize));
  for(const table of item.expectedTables||[])if(!actualTables.has(normalize(table)))errors.push(`Gold SQL 缺少预期表 ${table}`);
  const safeSql=String(verdict.sql||goldSql);
  for(const fragment of item.requiredSqlFragments||[])if(!safeSql.includes(String(fragment)))errors.push(`Gold SQL 缺少片段 ${fragment}`);
  for(const fragment of item.forbiddenSqlFragments||[])if(safeSql.includes(String(fragment)))errors.push(`Gold SQL 包含禁止片段 ${fragment}`);
  return {id,question,category:String(item.category||"未分类"),safe:errors.length===0,installed:existingKeys.has(caseKey(question,goldSql)),tables:[...actualTables].sort(),guardCode:verdict.code||null,guardReason:verdict.ok?null:verdict.reason,errors};
}

function report({manifest,source,cases,catalog,existing,errors}) {
  const safeCases=cases.filter((item)=>item.safe).length;
  const installedCases=cases.filter((item)=>item.installed).length;
  const minimumCases=Math.max(1,Number(manifest.minimumCases)||1);
  const reviewApproved=manifest.status==="approved";
  const blockers=[...errors];
  if(safeCases!==cases.length)blockers.push(`${cases.length-safeCases} 条 Gold SQL 未通过就绪校验`);
  if(cases.length<minimumCases)blockers.push(`正式门禁至少需要 ${minimumCases} 条用例，当前清单只有 ${cases.length} 条`);
  if(!reviewApproved)blockers.push(`清单状态为 ${manifest.status}，业务负责人审核后必须改为 approved`);
  if(installedCases!==cases.length)blockers.push(`${cases.length-installedCases} 条清单用例尚未导入评测集`);
  return {
    manifestVersion:manifest.version,
    setName:manifest.setName,
    manifestStatus:manifest.status,
    source,
    catalog,
    totals:{minimumCases,manifestCases:cases.length,safeCases,existingSetCases:existing.length,installedManifestCases:installedCases},
    cases,
    readyForReview:errors.length===0&&safeCases===cases.length,
    readyForGate:blockers.length===0,
    blockers,
  };
}

function readManifest(path) {
  const value=JSON.parse(readFileSync(path,"utf8"));
  if(!value||typeof value!=="object")throw new Error("Gold 清单必须是 JSON 对象");
  if(!String(value.version||"").trim())throw new Error("Gold 清单 version 必填");
  if(!String(value.setName||"").trim())throw new Error("Gold 清单 setName 必填");
  if(!["candidate","approved"].includes(value.status))throw new Error("Gold 清单 status 只允许 candidate 或 approved");
  if(!Array.isArray(value.cases)||!value.cases.length)throw new Error("Gold 清单 cases 必须是非空数组");
  return value;
}

function caseKey(question,goldSql) { return `${String(question||"").trim()}\u0000${normalizeSql(goldSql)}`; }
function normalizeSql(value) { return String(value||"").replace(/\s+/g," ").trim().replace(/;$/,"").toLowerCase(); }
function normalize(value) { return String(value||"").replace(/`/g,"").trim().toLowerCase(); }
function positiveInteger(value,name) { const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error(`${name} 必须是正整数`);return number; }
