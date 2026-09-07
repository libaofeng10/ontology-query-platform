import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { config } from "../server/src/config.mjs";
import { createConnector } from "../server/src/db-connector.mjs";
import { tmpdir } from "node:os";
import { createStore } from "../server/src/store.mjs";
import { createSettingsService } from "../server/src/settings-service.mjs";
import { createDiscoveryService } from "../server/src/discovery-service.mjs";
import { createRelationModelService } from "../server/src/relation-model-service.mjs";
import { relationKey, relationPairs, reverseRelation } from "../server/src/physical-relation.mjs";
import { evaluateRelationDiscovery, validateRelationTruth } from "../server/src/relation-evaluation.mjs";

const args=argumentsFor(process.argv.slice(2));
if(args.help){console.log("离线：node scripts/eval-source-relations.mjs --truth truth.json --predictions predictions.json [--out report.json]\n实测：node scripts/eval-source-relations.mjs --truth truth.json --source-id 2 --execute [--db .data/platform.sqlite] [--out report.json]\n可选：--threshold 0.55 --input-usd-per-million <单价> --output-usd-per-million <单价>。实测只读测试数据源并调用配置模型，不保存目录、不确认关系、不发布本体。");}
else{
  try{
    if(!args.truth)throw new Error("缺少 --truth；使用 --help 查看格式");
    const truth=validateRelationTruth(JSON.parse(await readFile(resolve(args.truth),"utf8")));
    let observed;
    if(args.predictions){if(args.execute)throw new Error("离线文件和 --execute 不能同时指定");observed=JSON.parse(await readFile(resolve(args.predictions),"utf8"));}
    else{if(!args.execute||!Number.isSafeInteger(Number(args["source-id"])))throw new Error("实测需要明确的 --source-id 和 --execute；离线使用 --predictions");observed=await runLive(truth,Number(args["source-id"]));}
    const prices=args["input-usd-per-million"]!=null&&args["output-usd-per-million"]!=null?{inputUsdPerMillion:Number(args["input-usd-per-million"]),outputUsdPerMillion:Number(args["output-usd-per-million"])}:null;
    const threshold=Number(args.threshold??config.relationModel.minConfidence);
    const report={...evaluateRelationDiscovery({truth,...observed,threshold,prices}),mode:args.execute?"live_mysql_model":"offline_predictions",measuredAt:new Date().toISOString(),diagnostics:observed.diagnostics||null,
      thresholdSweep:[.4,.55,.7,.85,.95].map(value=>{const result=evaluateRelationDiscovery({truth,...observed,threshold:value});return {threshold:value,precision:result.precision,recall:result.recall,labelledPrecision:result.labelledPrecision,labelledRecall:result.labelledRecall};})};
    const fixed=new Set((observed.candidates||[]).filter(item=>item.inferenceSource==="foreign_key").flatMap(item=>[relationKey(item),relationKey(reverseRelation(item))]));
    if(fixed.size)report.logicalRelationsOnly=evaluateRelationDiscovery({truth:{...truth,relations:truth.relations.filter(item=>!fixed.has(relationKey(item)))},candidates:observed.candidates.filter(item=>!fixed.has(relationKey(item))),predictions:observed.predictions.filter(item=>!fixed.has(relationKey(item))),threshold});
    const output=JSON.stringify(report,null,2);
    if(args.out){await writeFile(resolve(args.out),`${output}\n`,{mode:0o600});if(args.execute)await writeFile(resolve(`${args.out}.predictions.json`),JSON.stringify(observed,null,2),{mode:0o600});}
    console.log(output);
    if(args.execute&&observed.status!=="completed")process.exitCode=2;
  }catch(error){console.error(`关系评测失败：${error.message||"未知错误"}`);process.exitCode=1;}
}

async function runLive(truth,sourceId){
  const db=new Database(resolve(args.db||config.dbPath),{readonly:true,fileMustExist:true});let connector,temporary,working;
  try{
    const source=db.prepare("SELECT id,name,host,port,db_name AS dbName,user_name AS userName,cred_enc AS credential,is_demo AS isDemo FROM ds_source WHERE id=?").get(sourceId);
    if(!source||source.isDemo)throw new Error("指定数据源不存在或是演示数据源");
    const excluded=new Set(db.prepare("SELECT table_name FROM ds_table_selection WHERE source_id=? AND included=0").all(sourceId).map(row=>row.table_name));
    if(truth.tables.some(table=>excluded.has(table)))throw new Error("真值包含当前已排除的表；请先核对评测范围");
    // Reuse the application's settings contract without modifying its database.
    const ignored=new Set(),runtime=createSettingsService({baseConfig:config,appSecret:config.appSecret,store:{
      getSetting:key=>ignored.has(key)?null:db.prepare("SELECT value_json AS valueJson,encrypted FROM ds_setting WHERE key=?").get(key),
      deleteSetting:key=>ignored.add(key),
    }}).config;
    const model=createRelationModelService({llm:runtime.llm,batchSize:runtime.relationModel.batchSize,timeoutMs:runtime.relationModel.timeoutMs});
    if(!model.configured)throw new Error("模型配置不可用；请在项目设置中配置模型");
    connector=createConnector({appSecret:config.appSecret,timeoutMs:runtime.queryTimeoutMs});
    temporary=await mkdtemp(join(tmpdir(),"relation-evaluation-"));working=createStore(join(temporary,"store.sqlite"));
    const sampledSource=working.createSource({...source,kind:"mysql"});
    for(const table of db.prepare("SELECT table_name AS tableName,row_estimate AS rowEstimate,grade,grade_override AS gradeOverride,active,comment FROM ds_table WHERE source_id=? AND present=1").all(sourceId))if(truth.tables.includes(table.tableName))working.upsertTable({...table,sourceId:sampledSource.id});
    for(const page of db.prepare("SELECT page_type AS pageType,slug,title,aliases,tables_json AS tablesJson,content,sql_content AS sqlContent,verified FROM ds_knowledge_page WHERE source_id=? AND verified=1").all(sourceId))working.upsertKnowledge({...page,sourceId:sampledSource.id});
    let queryCount=0;const counted={query:async(...args)=>{queryCount++;return connector.query(...args);}};
    const discovery=createDiscoveryService({store:working,connector:counted,wikiDir:join(temporary,"wiki"),config:runtime,relationModel:model});
    const started=Date.now();
    await discovery.discover(sampledSource,{tableNames:truth.tables,onProgress:({currentStep})=>console.error(currentStep)});
    const found=new Set(working.listTables(sampledSource.id).map(table=>table.tableName));
    if(truth.tables.some(table=>!found.has(table)))throw new Error("真值中部分表在当前数据源已不存在");
    const relations=working.listRelations(sampledSource.id,false,true),stats=working.relationStats(sampledSource.id);
    const candidates=relations.map(relation=>({fromTable:relation.fromTable,toTable:relation.toTable,columnPairs:relationPairs(relation),candidateId:relation.id,inferenceSource:relation.inferenceSource}));
    return {status:stats.modelStatus,candidates,predictions:relations.map((relation,index)=>({...candidates[index],decision:relation.inferenceSource==="foreign_key"?"relation":relation.modelDecision,confidence:relation.inferenceSource==="foreign_key"?1:relation.modelConfidence,cardinality:relation.cardinality})),
      diagnostics:{...stats.diagnostics,elapsedMs:Date.now()-started,relationQueryCount:stats.diagnostics?.queryCount??null,queryCount,tableCount:found.size,explicitForeignKeyCount:relations.filter(relation=>relation.inferenceSource==="foreign_key").length,modelStatus:stats.modelStatus}};
  }finally{await connector?.close();working?.close();db.close();if(temporary)await rm(temporary,{recursive:true,force:true});}
}

function argumentsFor(values){
  const allowed=new Set(["truth","predictions","source-id","execute","db","out","threshold","input-usd-per-million","output-usd-per-million","help"]),result={};
  for(let i=0;i<values.length;i++){
    const key=values[i].replace(/^--/,"");if(!values[i].startsWith("--")||!allowed.has(key))throw new Error(`未知参数：${values[i]}`);
    if(["execute","help"].includes(key))result[key]=true;else{if(!values[i+1]||values[i+1].startsWith("--"))throw new Error(`参数 --${key} 缺少值`);result[key]=values[++i];}
  }
  return result;
}
