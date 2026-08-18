import { resolve } from "node:path";
import { inspectEvaluationReadiness } from "../server/src/evaluation-readiness.mjs";

const args=parseArgs(process.argv.slice(2));
if(!args.manifest)usage();
args.db??=process.env.PLATFORM_DB_PATH||".data/platform.sqlite";

try {
  const result=inspectEvaluationReadiness({dbPath:resolve(args.db),manifestPath:resolve(args.manifest),sourceId:args.sourceId});
  if(args.json)console.log(JSON.stringify(result,null,2));
  else printReport(result);
  if(args.requireGateReady&&!result.readyForGate)process.exitCode=2;
} catch(error) {
  console.error(`就绪检查失败：${error.message||String(error)}`);
  process.exitCode=1;
}

function parseArgs(values) {
  const output={db:null,manifest:null,sourceId:null,json:false,requireGateReady:false};
  for(let index=0;index<values.length;index++) {
    const value=values[index];
    if(value==="--db")output.db=values[++index];
    else if(value==="--manifest")output.manifest=values[++index];
    else if(value==="--source-id")output.sourceId=values[++index];
    else if(value==="--json")output.json=true;
    else if(value==="--require-gate-ready")output.requireGateReady=true;
    else usage(`未知参数：${value}`);
  }
  return output;
}

function printReport(result) {
  console.log(`Gold 集：${result.setName} (${result.manifestStatus})`);
  console.log(`数据源：${result.source?`${result.source.name} #${result.source.id}`:"不存在"}`);
  console.log(`目录：${result.catalog.tableCount} 张可查询表 / ${result.catalog.columnCount} 个字段`);
  console.log(`用例：${result.totals.safeCases}/${result.totals.manifestCases} 条 SQL 安全，${result.totals.installedManifestCases}/${result.totals.manifestCases} 条已导入，正式门禁下限 ${result.totals.minimumCases} 条`);
  for(const item of result.cases)console.log(`- ${item.safe?"PASS":"FAIL"} ${item.id}${item.installed?" [已导入]":" [未导入]"}${item.errors.length?`：${item.errors.join("；")}`:""}`);
  console.log(`可提交业务审核：${result.readyForReview?"是":"否"}`);
  console.log(`可运行生产门禁：${result.readyForGate?"是":"否"}`);
  for(const blocker of result.blockers)console.log(`  阻塞：${blocker}`);
}

function usage(message) {
  if(message)console.error(message);
  console.error("用法：node scripts/eval-readiness.mjs --db <platform.sqlite> --manifest <gold.json> [--source-id 2] [--json] [--require-gate-ready]");
  process.exit(message?1:0);
}
