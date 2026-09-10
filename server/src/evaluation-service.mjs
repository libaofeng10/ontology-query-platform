import { buildSemanticRepairHints } from "./evaluation-repair.mjs";
import { evalSetChecksum } from "./evaluation-evidence.mjs";
import { createQueryExecutionKernel } from "./query-execution-kernel.mjs";

export function createEvaluationService({store,connector,queries,config}) {
  function create(sourceId,input) { validateCase(input);return publicCase(store.addEvalCase(normalizeCase(sourceId,input))); }
  function update(id,input) { const existing=store.getEvalCase(id);if(!existing||!existing.active)throw httpError(404,"评测用例不存在");validateCase(input);return publicCase(store.updateEvalCase(id,normalizeCase(existing.sourceId,input))); }
  function archive(id) { const existing=store.getEvalCase(id);if(!existing||!existing.active)throw httpError(404,"评测用例不存在");store.archiveEvalCase(id);return {ok:true,id}; }
  function importCases(sourceId,items,options={}) {
    if(!Array.isArray(items)||!items.length||items.length>500)throw httpError(400,"items 必须包含 1-500 条用例");
    if(options.manifestStatus!=null&&options.manifestStatus!=="approved")throw httpError(409,"正式 Gold 清单必须经业务审核并标记为 approved 后才能导入");
    const minimumCases=options.minimumCases==null?null:Number(options.minimumCases);
    if(minimumCases!=null&&(!Number.isInteger(minimumCases)||minimumCases<1||minimumCases>500))throw httpError(400,"minimumCases 必须是 1-500 的整数");
    if(minimumCases!=null&&items.length<minimumCases)throw httpError(409,`正式 Gold 清单至少需要 ${minimumCases} 条用例，当前只有 ${items.length} 条`);
    const normalized=items.map((item)=>{validateCase(item);return normalizeCase(sourceId,item);});
    const setNames=[...new Set(normalized.map((item)=>item.setName))];
    const existing=setNames.flatMap((setName)=>store.listEvalCasesForRun(sourceId,setName));
    const byQuestion=new Map(existing.map((item)=>[evalCaseKey(item),item]));
    const unique=[];
    for(const item of normalized) {
      const key=evalCaseKey(item);const previous=byQuestion.get(key);
      if(previous) {
        if(!sameCaseDefinition(previous,item))throw httpError(409,`评测集 ${item.setName} 中的问题“${item.question}”已存在但定义不同，请使用编辑接口显式更新`);
        continue;
      }
      byQuestion.set(key,item);unique.push(item);
    }
    const created=unique.map((item)=>publicCase(store.addEvalCase(item)));
    const createdByKey=new Map(created.map((item)=>[evalCaseKey(item),item]));
    return normalized.map((item)=>createdByKey.get(evalCaseKey(item))||publicCase(existing.find((candidate)=>evalCaseKey(candidate)===evalCaseKey(item))));
  }

  async function run({task,source,payload,onProgress}) {
    if(source.isDemo) throw new Error("评测执行需要真实只读 MySQL 数据源");
    const setName=String(payload.setName||"").trim();if(!setName)throw new Error("setName 必填");
    const cases=store.listEvalCasesForRun(source.id,setName);if(!cases.length)throw new Error("评测集不存在或没有有效用例");

    const summary={batchId:task.id,setName,total:cases.length,passed:0,failed:0,failures:[]};
    for(const [index,item] of cases.entries()) {
      onProgress({progress:Math.round(index/cases.length*100),total:100,currentStep:`评测 ${index+1}/${cases.length}：${item.category}`});
      const started=Date.now();let generatedSql=null;let expectedRows=[];let actualRows=[];let queryMeta={requestedMode:"claude"};let answer=null;
      try {
        if(!item.goldSql) throw classified("configuration","缺少 Gold SQL","为该用例补充经审核的 Gold SQL。");
        expectedRows=await executeGold(source,item.goldSql);
        // 平台只构建本体，问数统一交给 Claude Code。每个用例用 Claude Code 回答一次，
        // 与 Gold SQL 的真实结果做结果集等价判定，用来说明当前本体/知识是否足以让
        // Claude Code 答对——即「本体门禁」，而不比较平台内不同的规划引擎。
        answer=await queries.ask({sourceId:source.id,question:item.question,userName:"eval-runner"});
        assertCompletedAnswer(answer,source.id,"eval-runner");
        if(answer.refused) throw classified(answer.missingTerm?"retrieval":"generation",answer.reason,answer.missingTerm?"补充命中该问题的术语、指标或别名，并加入失败问法作为反例。":"检查本体、知识覆盖与 SQL 护栏反馈。");
        generatedSql=answer.evidence.sql;actualRows=answer.rows;queryMeta={requestedMode:"claude",...metadataFromAnswer(answer)};
        const verdict=equivalentResults(expectedRows,actualRows,{tolerance:Number(payload.tolerance||1e-6)});
        if(!verdict.equal) throw classified("result_mismatch",verdict.reason,"将该失败问法及差异写入相关术语/指标的反例，修正口径后重跑评测。");
        store.addEvalRun({evalId:item.id,sourceId:source.id,batchId:task.id,generatedSql,passed:1,expectedJson:JSON.stringify(expectedRows),actualJson:JSON.stringify(actualRows),durationMs:Date.now()-started,...queryMeta});summary.passed++;
      } catch(error) {
        const failureClass=error.failureClass||"execution";const suggestion=error.suggestion||"检查数据源、SQL 执行错误及本体知识后重跑。";const repairHints=repairHintsFor(store,source.id,{question:item.question,failureClass,answer});
        store.addEvalRun({evalId:item.id,sourceId:source.id,batchId:task.id,generatedSql,passed:0,failReason:error.message||String(error),expectedJson:JSON.stringify(expectedRows),actualJson:JSON.stringify(actualRows),durationMs:Date.now()-started,failureClass,suggestion,repairHintsJson:JSON.stringify(repairHints),...queryMeta});
        summary.failed++;summary.failures.push({evalId:item.id,question:item.question,failureClass,reason:error.message||String(error),suggestion,repairHints});
      }
    }
    onProgress({progress:100,total:100,currentStep:"评测完成"});return summary;
  }

  async function runGate({task,source,payload,onProgress}) {
    if(source.isDemo) throw new Error("对照门禁需要真实只读 MySQL 数据源");
    const setName=String(payload.setName||"").trim();if(!setName)throw new Error("setName 必填");
    const requestedVersionId=Number(payload.ontologySchemaVersionId||0);
    const published=requestedVersionId?store.getOntologySchemaVersion(requestedVersionId):store.getPublishedOntologySchema(source.id);
    if(!published)throw new Error(requestedVersionId?"待评测的 Ontology Schema 版本不存在":"运行语义门禁前必须先发布有效的 Ontology Schema");
    if(published.sourceId!==source.id)throw new Error("待评测的 Ontology Schema 版本不属于当前数据源");
    const cases=store.listEvalCasesForRun(source.id,setName);if(!cases.length)throw new Error("评测集不存在或没有有效用例");

    const candidate=createGateMetrics("claude");
    const baseline={requestedMode:"gold",total:cases.length,passed:0,failed:0,passRate:0};
    const failures=[];
    for(const [index,item] of cases.entries()) {
      onProgress({progress:Math.round(index/cases.length*100),total:100,currentStep:`对照 ${index+1}/${cases.length}：${item.category}`});
      let expectedRows=[];let goldFailure=null;
      try {
        if(!item.goldSql) throw classified("configuration","缺少 Gold SQL","为该用例补充经审核的 Gold SQL。");
        expectedRows=await executeGold(source,item.goldSql);baseline.passed++;
      } catch(error) { baseline.failed++;goldFailure=outcomeFromError(error,expectedRows,"claude"); }
      // 候选引擎只有 Claude Code；它直接对照 Gold SQL 的真实结果判等价，不再比较
      // legacy/semantic/agent 之间的优劣（那些引擎已随本体重构移除）。
      const candidateOutcome=goldFailure?{...goldFailure,requestedMode:"claude"}:await evaluateMode({source,item,expectedRows,requestedMode:"claude",tolerance:Number(payload.tolerance||1e-6),userName:"eval-gate-claude",ontologySchemaVersionId:published.id});
      persistGateOutcome(store,task,source,item,candidateOutcome,"candidate",expectedRows);
      addGateOutcome(candidate,candidateOutcome);
      if(!candidateOutcome.passed) failures.push({evalId:item.id,question:item.question,failureClass:candidateOutcome.failureClass,reason:candidateOutcome.failReason,suggestion:candidateOutcome.suggestion,repairHints:candidateOutcome.repairHints||[]});
    }
    finalizeGateMetrics(candidate);baseline.passRate=baseline.passed/cases.length;
    const ontologySchemaPublishedAt=published.status==="published"?published.publishedAt:null;
    const summary={batchId:task.id,setName,total:cases.length,ontologySchemaVersion:published.version,ontologySchemaPublishedAt,baseline,candidate,passed:candidate.failed===0,decision:candidate.failed===0?"enable_claude":"keep_off",reason:candidate.failed===0?"所有用例均由 Claude Code 对照 Gold SQL 等价通过。":"存在未通过用例，需补齐本体/知识口径后重跑。",failures};
    store.saveEvalGate({id:task.id,sourceId:source.id,setName,total:cases.length,ontologySchemaVersion:published.version,ontologySchemaPublishedAt,evaluationChecksum:evalSetChecksum(cases),baseline,candidate,passed:candidate.failed===0?1:0,decision:candidate.failed===0?"enable_claude":"keep_off",reason:summary.reason});
    onProgress({progress:100,total:100,currentStep:summary.passed?"门禁通过":"门禁未通过"});return summary;
  }

  async function evaluateMode({source,item,expectedRows,requestedMode,tolerance,userName,ontologySchemaVersionId}) {
    const started=Date.now();let answer;
    try {
      answer=await queries.ask({sourceId:source.id,question:item.question,userName,ontologySchemaVersionId});
      assertCompletedAnswer(answer,source.id,userName);
        if(answer.refused) {
        const failureClass=classifyRefusal(answer);
        throw classified(failureClass,answer.reason,failureClass==="join"?"检查 Object/Link 映射与已确认 JOIN 路径。":answer.missingTerm?"补充命中该问题的术语、指标或别名。":"检查本体、知识覆盖与 SQL 护栏反馈。");
      }
      const verdict=equivalentResults(expectedRows,answer.rows,{tolerance});
      if(!verdict.equal) throw classified("result_mismatch",verdict.reason,"对照 Gold SQL 与 Claude Code 的指标、过滤、粒度和 JOIN 路径，修正口径后重跑门禁。");
      return {passed:1,generatedSql:answer.evidence.sql,actualRows:answer.rows,durationMs:Date.now()-started,requestedMode,...metadataFromAnswer(answer)};
    } catch(error) {
      const outcome=outcomeFromError(error,answer&&!answer.refused&&!answer.clarification?answer.rows:[],requestedMode);outcome.repairHints=repairHintsFor(store,source.id,{question:item.question,failureClass:outcome.failureClass,answer,ontologySchemaVersionId});
      return {...outcome,generatedSql:answer&&!answer.refused&&!answer.clarification?answer.evidence.sql:null,durationMs:Date.now()-started,...(answer&&!answer.refused&&!answer.clarification?metadataFromAnswer(answer):{planningMode:answer?.planningMode||null,planningAttempts:answer?.planningAttempts||null})};
    }
  }


  async function executeGold(source,sql) {
    const kernel=createQueryExecutionKernel({connector,source,config,schemaMode:"database",maxSqlCalls:1});
    const receipt=await kernel.execute({sql});
    if(!receipt.ok)throw classified("gold_sql",`Gold SQL 执行未通过：${receipt.reason||receipt.error}`,"检查只读 SQL、扫描预算与数据源。");
    const run=kernel.getRun(receipt.executionId);
    if(run.mayBeTruncated)throw classified("result_incomplete","Gold SQL 结果可能被截断，不能用于等价判定","调整结果上限或评测问题后重跑。");
    return run.rows;
  }

  function assertCompletedAnswer(answer,sourceId,userName) {
    if(answer?.clarification) {
      queries.discardPending?.({pendingId:answer.clarification.pendingId,sourceId,sessionId:answer.sessionId,userName});
      throw classified("clarification","Claude 需要业务口径澄清，自动评测未完成","补充已审核的默认口径或将该问题列为澄清用例。");
    }
    if(answer?.evidence?.resultCompleteness?.truncated || answer?.evidence?.resultCompleteness?.complete===false) {
      throw classified("result_incomplete","查询结果不完整，不能判为等价通过","调整评测用例或结果交付上限后重跑。");
    }
  }

  return {create,update,archive,importCases,run,runGate,listRuns:(sourceId)=>store.listEvalRuns(sourceId),listGates:(sourceId)=>store.listEvalGates(sourceId)};
}

export function equivalentResults(expected,actual,{tolerance=1e-6}={}) {
  if(!Array.isArray(expected)||!Array.isArray(actual))return {equal:false,reason:"结果不是行数组"};
  if(expected.length!==actual.length)return {equal:false,reason:`结果行数不同：期望 ${expected.length}，实际 ${actual.length}`};
  if(!expected.length)return {equal:true,reason:null};
  const expectedKeys=Object.keys(expected[0]);const actualKeys=Object.keys(actual[0]);
  if(expectedKeys.length!==actualKeys.length)return {equal:false,reason:`结果列数不同：期望 ${expectedKeys.length}，实际 ${actualKeys.length}`};
  const sameKeys=expectedKeys.length===actualKeys.length&&expectedKeys.every((key)=>actualKeys.includes(key));
  const left=canonicalRows(expected,sameKeys?[...expectedKeys].sort():expectedKeys,tolerance);
  const right=canonicalRows(actual,sameKeys?[...expectedKeys].sort():actualKeys,tolerance);
  for(let index=0;index<left.length;index++)if(left[index]!==right[index])return {equal:false,reason:`结果值不等价，首个差异位于规范化结果第 ${index+1} 行`};
  return {equal:true,reason:null};
}

function canonicalRows(rows,keys,tolerance) { return rows.map((row)=>JSON.stringify(keys.map((key)=>canonicalValue(row[key],tolerance)))).sort(); }
function canonicalValue(value,tolerance) { if(value==null)return null;if(typeof value==="number"&&Number.isFinite(value)){const digits=Math.min(12,Math.max(0,Math.ceil(-Math.log10(Math.max(tolerance,1e-12)))));return Number(value.toFixed(digits));}if(value instanceof Date)return value.toISOString();if(Buffer.isBuffer(value))return "[BINARY]";return String(value); }
function metadataFromAnswer(answer) { const evidence=answer.evidence||{};return {planningMode:evidence.planningMode||null,ontologySchemaVersion:evidence.ontologySchemaVersion||null,semanticPathJson:evidence.semanticPath?JSON.stringify(evidence.semanticPath):null,tableCount:Array.isArray(evidence.tables)?evidence.tables.length:null,planningAttempts:evidence.planningAttempts||null}; }
function outcomeFromError(error,actualRows,requestedMode) { return {passed:0,generatedSql:null,actualRows,requestedMode,planningMode:null,ontologySchemaVersion:null,semanticPathJson:null,tableCount:null,planningAttempts:null,failReason:error.message||String(error),failureClass:error.failureClass||"execution",suggestion:error.suggestion||"检查数据源、SQL 执行错误及本体知识后重跑。",repairHints:[],durationMs:0}; }
function persistGateOutcome(store,task,source,item,outcome,comparisonRole,expectedRows) { const agentMetrics=outcome.requestedMode==="single"||outcome.requestedMode==="agent_required"?{agentExecution:Number(outcome.agentExecution||0),iterations:Number(outcome.iterations||0),toolCalls:Number(outcome.toolCalls||0),toolSuccesses:Number(outcome.toolSuccesses||0),clarificationCount:Number(outcome.clarificationCount||0),budgetFallback:Number(outcome.budgetFallback||0),repeatedActions:Number(outcome.repeatedActions||0),intentFailures:Number(outcome.intentFailures||0),incompleteFailures:Number(outcome.incompleteFailures||0),totalTokens:Number.isFinite(Number(outcome.totalTokens))?Number(outcome.totalTokens):null}:null;store.addEvalRun({evalId:item.id,sourceId:source.id,batchId:task.id,generatedSql:outcome.generatedSql,passed:outcome.passed,failReason:outcome.failReason||null,expectedJson:JSON.stringify(expectedRows),actualJson:JSON.stringify(outcome.actualRows||[]),durationMs:outcome.durationMs,failureClass:outcome.failureClass||null,suggestion:outcome.suggestion||null,repairHintsJson:JSON.stringify(outcome.repairHints||[]),requestedMode:outcome.requestedMode,planningMode:outcome.planningMode,comparisonRole,ontologySchemaVersion:outcome.ontologySchemaVersion,semanticPathJson:outcome.semanticPathJson,tableCount:outcome.tableCount,planningAttempts:outcome.planningAttempts,agentMetricsJson:agentMetrics?JSON.stringify(agentMetrics):null}); }
function createGateMetrics(requestedMode) { return {requestedMode,total:0,passed:0,failed:0,joinFailures:0,refused:0,claudeExecutions:0,subtypeRootObjects:[],contextTablesTotal:0,planningAttemptsTotal:0,durationMsTotal:0}; }
function addGateOutcome(metrics,outcome,subtypeNames=new Set()) { metrics.total++;if(outcome.passed)metrics.passed++;else metrics.failed++;if(outcome.failureClass==="join")metrics.joinFailures++;if(["join","retrieval","generation"].includes(outcome.failureClass))metrics.refused++;if(outcome.planningMode==="claude")metrics.claudeExecutions++;const rootObject=parseSemanticPath(outcome.semanticPathJson)?.rootObject;if(rootObject&&subtypeNames.has(rootObject)&&!metrics.subtypeRootObjects.includes(rootObject))metrics.subtypeRootObjects.push(rootObject);metrics.contextTablesTotal+=Number(outcome.tableCount||0);metrics.planningAttemptsTotal+=Number(outcome.planningAttempts||0);metrics.durationMsTotal+=Number(outcome.durationMs||0); }
function finalizeGateMetrics(metrics) { const total=Math.max(1,metrics.total);metrics.subtypeRootObjects.sort();metrics.subtypeRootCoverage=metrics.subtypeRootObjects.length;metrics.passRate=metrics.passed/total;metrics.joinFailureRate=metrics.joinFailures/total;metrics.refusalRate=metrics.refused/total;metrics.claudeExecutionRate=metrics.claudeExecutions/total;metrics.averageContextTables=metrics.contextTablesTotal/total;metrics.averagePlanningAttempts=metrics.planningAttemptsTotal/total;metrics.averageDurationMs=metrics.durationMsTotal/total;delete metrics.contextTablesTotal;delete metrics.planningAttemptsTotal;delete metrics.durationMsTotal; }
function parseSemanticPath(value) { if(!value)return null;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return null;} }
function classifyRefusal(answer) { if(answer?.failureClass)return answer.failureClass;if(/\bjoin\b|关联|关系|路径/i.test(String(answer.reason||"")))return "join";return answer.missingTerm?"retrieval":"generation"; }
function repairHintsFor(store,sourceId,{question,failureClass,answer,ontologySchemaVersionId}) { const record=ontologySchemaVersionId?store.getOntologySchemaVersion(Number(ontologySchemaVersionId)):store.getPublishedOntologySchema(sourceId);if(!record?.schema)return [];return buildSemanticRepairHints({schema:record.schema,question,failureClass,queryPlan:answer?.evidence?.queryPlan,semanticPath:answer?.evidence?.semanticPath}); }
function normalizeCase(sourceId,input) { return {sourceId,setName:String(input.setName).trim(),question:String(input.question).trim(),goldSql:String(input.goldSql||"").trim()||null,category:String(input.category||"未分类").trim(),heldOut:input.heldOut?1:0}; }
function publicCase(item) { return {...item,goldSql:item.heldOut?null:item.goldSql,hasGoldSql:Boolean(item.goldSql)}; }
function validateCase(input) { if(!input||typeof input!=="object")throw httpError(400,"评测用例格式错误");if(!String(input.setName||"").trim())throw httpError(400,"setName 必填");if(!String(input.question||"").trim())throw httpError(400,"question 必填");if(!String(input.goldSql||"").trim())throw httpError(400,"goldSql 必填"); }
function evalCaseKey(item) { return `${String(item.setName||"").trim()}\u0000${String(item.question||"").trim()}`; }
function sameCaseDefinition(left,right) { return normalizeSql(left.goldSql)===normalizeSql(right.goldSql)&&String(left.category||"未分类").trim()===String(right.category||"未分类").trim()&&Boolean(left.heldOut)===Boolean(right.heldOut); }
function normalizeSql(value) { return String(value||"").replace(/\s+/g," ").trim().replace(/;$/,"").toLowerCase(); }
function classified(failureClass,message,suggestion) { const error=new Error(message);error.failureClass=failureClass;error.suggestion=suggestion;return error; }
function httpError(status,message) { const error=new Error(message);error.status=status;return error; }
