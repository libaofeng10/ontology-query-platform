import assert from "node:assert/strict";
import { mkdtemp,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectEvaluationReadiness } from "../src/evaluation-readiness.mjs";
import { createStore } from "../src/store.mjs";

test("Gold readiness is read-only and reports review, coverage and import blockers",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-eval-ready-"));
  const dbPath=join(root,"store.sqlite");const manifestPath=join(root,"gold.json");
  const store=createStore(dbPath);const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"unused",isDemo:false});store.markSourceTest(source.id,true);
  store.upsertTable({sourceId:source.id,tableName:"alpha_crm_clue",grade:"A",active:1});
  for(const columnName of ["clue_id","office_name","clue_create_time","is_deleted"])store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName,dataType:"varchar"});
  const manifest={version:"test-1",setName:"loop-v2",status:"candidate",minimumCases:2,source:{id:source.id,name:"real"},cases:[{id:"clue",category:"实体与时间",question:"统计北京大成本月线索",goldSql:"SELECT COUNT(*) AS clue_count FROM alpha_crm_clue WHERE office_name LIKE '%北京大成%' AND is_deleted = 0",expectedTables:["alpha_crm_clue"],requiredSqlFragments:["%北京大成%"]}]};
  await writeFile(manifestPath,JSON.stringify(manifest));store.close();
  const result=inspectEvaluationReadiness({dbPath,manifestPath});
  assert.equal(result.readyForReview,true);assert.equal(result.readyForGate,false);assert.equal(result.totals.safeCases,1);assert.equal(result.totals.existingSetCases,0);assert.match(result.blockers.join("\n"),/至少需要 2 条/);assert.match(result.blockers.join("\n"),/candidate/);assert.match(result.blockers.join("\n"),/尚未导入/);
});
