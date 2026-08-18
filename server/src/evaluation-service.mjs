import { buildSemanticRepairHints } from "./evaluation-repair.mjs";
import { evalSetChecksum } from "./evaluation-evidence.mjs";
import { guardSql } from "./sql-guard.mjs";
import { buildQueryColumnSemantics } from "./query-column-semantics.mjs";
import { semanticSubtypeNames } from "./semantic-schema-diff.mjs";

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
    const queryAgentMode=normalizeEvalAgentMode(payload.queryAgentMode??config.queryAgentMode);
    const cases=store.listEvalCasesForRun(source.id,setName);if(!cases.length)throw new Error("评测集不存在或没有有效用例");
    const policy=buildGoldPolicy(store,source.id,config);
    const summary={batchId:task.id,setName,queryAgentMode,total:cases.length,passed:0,failed:0,failures:[]};
    for(const [index,item] of cases.entries()) {
      onProgress({progress:Math.round(index/cases.length*100),total:100,currentStep:`评测 ${index+1}/${cases.length}：${item.category}`});
      const started=Date.now();let generatedSql=null;let expectedRows=[];let actualRows=[];let queryMeta={requestedMode:evalRequestedMode(queryAgentMode)};let answer=null;
      try {
        if(!item.goldSql) throw classified("configuration","缺少 Gold SQL","为该用例补充经审核的 Gold SQL。");
        const gold=guardSql(item.goldSql,policy);if(!gold.ok)throw classified("gold_sql",`Gold SQL 未通过安全校验：${gold.reason}`,"修正 Gold SQL，使其仅使用当前本体中的表、字段和已确认 JOIN。");
        const [goldRows]=await connector.query(source,gold.sql);expectedRows=goldRows.map(normalizeRow);
        answer=await queries.ask({sourceId:source.id,question:item.question,userName:"eval-runner",queryAgentMode});
        if(answer.refused) throw classified(answer.missingTerm?"retrieval":"generation",answer.reason,answer.missingTerm?"补充命中该问题的术语、指标或别名，并加入失败问法作为反例。":"检查 LLM 配置、SQL 护栏反馈和本体约束。");
        generatedSql=answer.evidence.sql;actualRows=answer.rows;queryMeta={requestedMode:evalRequestedMode(queryAgentMode),...metadataFromAnswer(answer)};
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
    const policy=buildGoldPolicy(store,source.id,config);
    const baseline=createGateMetrics("off");const candidate=createGateMetrics("prefer");
    const subtypeNames=new Set(semanticSubtypeNames(published.schema));
    const failures=[];
    for(const [index,item] of cases.entries()) {
      onProgress({progress:Math.round(index/cases.length*100),total:100,currentStep:`对照 ${index+1}/${cases.length}：${item.category}`});
      let expectedRows=[];let goldFailure=null;
      try {
        if(!item.goldSql) throw classified("configuration","缺少 Gold SQL","为该用例补充经审核的 Gold SQL。");
        const gold=guardSql(item.goldSql,policy);if(!gold.ok)throw classified("gold_sql",`Gold SQL 未通过安全校验：${gold.reason}`,"修正 Gold SQL，使其仅使用当前本体中的表、字段和已确认 JOIN。");
        const [rows]=await connector.query(source,gold.sql);expectedRows=rows.map(normalizeRow);
      } catch(error) { goldFailure=outcomeFromError(error,expectedRows,"off"); }
      const baselineOutcome=goldFailure||await evaluateMode({source,item,expectedRows,requestedMode:"off",tolerance:Number(payload.tolerance||1e-6),userName:"eval-gate-baseline"});
      const candidateOutcome=goldFailure?{...goldFailure,requestedMode:"prefer"}:await evaluateMode({source,item,expectedRows,requestedMode:"prefer",tolerance:Number(payload.tolerance||1e-6),userName:"eval-gate-candidate",ontologySchemaVersionId:published.id});
      persistGateOutcome(store,task,source,item,baselineOutcome,"baseline",expectedRows);
      persistGateOutcome(store,task,source,item,candidateOutcome,"candidate",expectedRows);
      addGateOutcome(baseline,baselineOutcome);addGateOutcome(candidate,candidateOutcome,subtypeNames);
      if(!candidateOutcome.passed) failures.push({evalId:item.id,question:item.question,failureClass:candidateOutcome.failureClass,reason:candidateOutcome.failReason,suggestion:candidateOutcome.suggestion,repairHints:candidateOutcome.repairHints||[]});
    }
    finalizeGateMetrics(baseline);finalizeGateMetrics(candidate);
    const verdict=evaluateGate(baseline,candidate);
    const ontologySchemaPublishedAt=published.status==="published"?published.publishedAt:null;
    const summary={batchId:task.id,setName,total:cases.length,ontologySchemaVersion:published.version,ontologySchemaPublishedAt,baseline,candidate,passed:verdict.passed,decision:verdict.decision,reason:verdict.reason,failures};
    store.saveEvalGate({id:task.id,sourceId:source.id,setName,total:cases.length,ontologySchemaVersion:published.version,ontologySchemaPublishedAt,evaluationChecksum:evalSetChecksum(cases),baseline,candidate,passed:verdict.passed?1:0,decision:verdict.decision,reason:verdict.reason});
    onProgress({progress:100,total:100,currentStep:verdict.passed?"门禁通过":"门禁未通过"});return summary;
  }

  async function runAgentGate({task,source,payload,onProgress}) {
    if(source.isDemo) throw new Error("Agent 对照门禁需要真实只读 MySQL 数据源");
    const setName=String(payload.setName||"").trim();if(!setName)throw new Error("setName 必填");
    const cases=store.listEvalCasesForRun(source.id,setName);if(!cases.length)throw new Error("评测集不存在或没有有效用例");
    const policy=buildGoldPolicy(store,source.id,config);const baseline=createAgentGateMetrics("single");const candidate=createAgentGateMetrics("agent_required");const failures=[];
    for(const [index,item] of cases.entries()) {
      onProgress({progress:Math.round(index/cases.length*100),total:100,currentStep:`Agent 对照 ${index+1}/${cases.length}：${item.category}`});
      let expectedRows=[];let goldFailure=null;
      try {
        if(!item.goldSql)throw classified("configuration","缺少 Gold SQL","为该用例补充经审核的 Gold SQL。");
        const gold=guardSql(item.goldSql,policy);if(!gold.ok)throw classified("gold_sql",`Gold SQL 未通过安全校验：${gold.reason}`,"修正 Gold SQL，使其仅使用当前本体中的表、字段和已确认 JOIN。");
        const [rows]=await connector.query(source,gold.sql);expectedRows=rows.map(normalizeRow);
      } catch(error) { goldFailure=outcomeFromError(error,expectedRows,"single"); }
      const baselineOutcome=goldFailure||await evaluateAgentMode({source,item,expectedRows,requestedMode:"single",tolerance:Number(payload.tolerance||1e-6),userName:"eval-agent-baseline"});
      const candidateOutcome=goldFailure?{...goldFailure,requestedMode:"agent_required"}:await evaluateAgentMode({source,item,expectedRows,requestedMode:"agent_required",tolerance:Number(payload.tolerance||1e-6),userName:"eval-agent-candidate"});
      persistGateOutcome(store,task,source,item,baselineOutcome,"baseline",expectedRows);persistGateOutcome(store,task,source,item,candidateOutcome,"candidate",expectedRows);
      addAgentGateOutcome(baseline,baselineOutcome);addAgentGateOutcome(candidate,candidateOutcome);
      if(!candidateOutcome.passed)failures.push({evalId:item.id,question:item.question,failureClass:candidateOutcome.failureClass,reason:candidateOutcome.failReason,suggestion:candidateOutcome.suggestion,repairHints:candidateOutcome.repairHints||[]});
    }
    finalizeAgentGateMetrics(baseline);finalizeAgentGateMetrics(candidate);const verdict=evaluateAgentGate(baseline,candidate,payload);
    const summary={batchId:task.id,gateKind:"agent",setName,total:cases.length,ontologySchemaVersion:null,baseline,candidate,passed:verdict.passed,decision:verdict.decision,reason:verdict.reason,thresholds:verdict.thresholds,failures};
    store.saveEvalGate({id:task.id,sourceId:source.id,setName,total:cases.length,ontologySchemaVersion:null,evaluationChecksum:evalSetChecksum(cases),baseline,candidate,passed:verdict.passed?1:0,decision:verdict.decision,reason:verdict.reason});
    onProgress({progress:100,total:100,currentStep:verdict.passed?"Agent 门禁通过":"Agent 门禁未通过"});return summary;
  }

  async function evaluateMode({source,item,expectedRows,requestedMode,tolerance,userName,ontologySchemaVersionId}) {
    const started=Date.now();let answer;
    try {
      answer=await queries.ask({sourceId:source.id,question:item.question,userName,semanticQueryPlanMode:requestedMode,queryAgentMode:"off",ontologySchemaVersionId});
      if(answer.refused) {
        const failureClass=classifyRefusal(answer);
        throw classified(failureClass,answer.reason,failureClass==="join"?"检查 Object/Link 映射与已确认 JOIN 路径。":answer.missingTerm?"补充命中该问题的术语、指标或别名。":"检查规划、护栏反馈和本体约束。");
      }
      const verdict=equivalentResults(expectedRows,answer.rows,{tolerance});
      if(!verdict.equal) throw classified("result_mismatch",verdict.reason,"对照基线与语义计划的指标、过滤、粒度和 JOIN 路径，修正口径后重跑门禁。");
      return {passed:1,generatedSql:answer.evidence.sql,actualRows:answer.rows,durationMs:Date.now()-started,requestedMode,...metadataFromAnswer(answer)};
    } catch(error) {
      const outcome=outcomeFromError(error,answer&&!answer.refused?answer.rows:[],requestedMode);outcome.repairHints=repairHintsFor(store,source.id,{question:item.question,failureClass:outcome.failureClass,answer,ontologySchemaVersionId});
      return {...outcome,generatedSql:answer&&!answer.refused?answer.evidence.sql:null,durationMs:Date.now()-started,...(answer&&!answer.refused?metadataFromAnswer(answer):{planningMode:answer?.planningMode||null,planningAttempts:answer?.planningAttempts||null})};
    }
  }

  async function evaluateAgentMode({source,item,expectedRows,requestedMode,tolerance,userName}) {
    const started=Date.now();let answer;
    try {
      answer=await queries.ask({sourceId:source.id,question:item.question,userName,semanticQueryPlanMode:"off",queryAgentMode:requestedMode==="agent_required"?"required":"off"});
      if(answer.clarification){queries.discardPending?.({pendingId:answer.clarification.pendingId,sourceId:source.id,sessionId:answer.sessionId,userName});throw classified("clarification","Agent 需要人工澄清，自动评测无法继续","补充默认业务口径或将该用例标记为需澄清场景。");}
      if(answer.refused)throw classified(classifyRefusal(answer),answer.reason,"检查知识覆盖、SQL 护栏反馈与工具轨迹。");
      const verdict=equivalentResults(expectedRows,answer.rows,{tolerance});if(!verdict.equal)throw classified("result_mismatch",verdict.reason,"对照 Gold SQL 检查 Agent 的探索路径、最终 SQL 与业务口径。");
      return {passed:1,generatedSql:answer.evidence.sql,actualRows:answer.rows,durationMs:Date.now()-started,requestedMode,...metadataFromAnswer(answer),...agentMetricsFromAnswer(answer)};
    } catch(error) {
      const outcome=outcomeFromError(error,answer&&!answer.refused&&!answer.clarification?answer.rows:[],requestedMode);
      return {...outcome,generatedSql:answer&&!answer.refused&&!answer.clarification?answer.evidence.sql:null,durationMs:Date.now()-started,...(answer&&!answer.refused&&!answer.clarification?metadataFromAnswer(answer):{planningMode:answer?.planningMode||null,planningAttempts:answer?.planningAttempts||null}),...agentMetricsFromAnswer(answer)};
    }
  }

  return {create,update,archive,importCases,run,runGate,runAgentGate,listRuns:(sourceId)=>store.listEvalRuns(sourceId),listGates:(sourceId)=>store.listEvalGates(sourceId)};
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
function normalizeRow(row) { return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():typeof value==="bigint"?Number(value):Buffer.isBuffer(value)?"[BINARY]":value])); }
function metadataFromAnswer(answer) { const evidence=answer.evidence||{};return {planningMode:evidence.planningMode||null,ontologySchemaVersion:evidence.ontologySchemaVersion||null,semanticPathJson:evidence.semanticPath?JSON.stringify(evidence.semanticPath):null,tableCount:Array.isArray(evidence.tables)?evidence.tables.length:null,planningAttempts:evidence.planningAttempts||null}; }
function outcomeFromError(error,actualRows,requestedMode) { return {passed:0,generatedSql:null,actualRows,requestedMode,planningMode:null,ontologySchemaVersion:null,semanticPathJson:null,tableCount:null,planningAttempts:null,failReason:error.message||String(error),failureClass:error.failureClass||"execution",suggestion:error.suggestion||"检查数据源、SQL 执行错误及本体知识后重跑。",repairHints:[],durationMs:0}; }
function persistGateOutcome(store,task,source,item,outcome,comparisonRole,expectedRows) { const agentMetrics=outcome.requestedMode==="single"||outcome.requestedMode==="agent_required"?{agentExecution:Number(outcome.agentExecution||0),iterations:Number(outcome.iterations||0),toolCalls:Number(outcome.toolCalls||0),toolSuccesses:Number(outcome.toolSuccesses||0),clarificationCount:Number(outcome.clarificationCount||0),budgetFallback:Number(outcome.budgetFallback||0),repeatedActions:Number(outcome.repeatedActions||0),intentFailures:Number(outcome.intentFailures||0),incompleteFailures:Number(outcome.incompleteFailures||0),totalTokens:Number.isFinite(Number(outcome.totalTokens))?Number(outcome.totalTokens):null}:null;store.addEvalRun({evalId:item.id,sourceId:source.id,batchId:task.id,generatedSql:outcome.generatedSql,passed:outcome.passed,failReason:outcome.failReason||null,expectedJson:JSON.stringify(expectedRows),actualJson:JSON.stringify(outcome.actualRows||[]),durationMs:outcome.durationMs,failureClass:outcome.failureClass||null,suggestion:outcome.suggestion||null,repairHintsJson:JSON.stringify(outcome.repairHints||[]),requestedMode:outcome.requestedMode,planningMode:outcome.planningMode,comparisonRole,ontologySchemaVersion:outcome.ontologySchemaVersion,semanticPathJson:outcome.semanticPathJson,tableCount:outcome.tableCount,planningAttempts:outcome.planningAttempts,agentMetricsJson:agentMetrics?JSON.stringify(agentMetrics):null}); }
function createGateMetrics(requestedMode) { return {requestedMode,total:0,passed:0,failed:0,joinFailures:0,refused:0,semanticExecutions:0,subtypeRootObjects:[],contextTablesTotal:0,planningAttemptsTotal:0,durationMsTotal:0}; }
function addGateOutcome(metrics,outcome,subtypeNames=new Set()) { metrics.total++;if(outcome.passed)metrics.passed++;else metrics.failed++;if(outcome.failureClass==="join")metrics.joinFailures++;if(["join","retrieval","generation"].includes(outcome.failureClass))metrics.refused++;if(outcome.planningMode==="semantic")metrics.semanticExecutions++;const rootObject=parseSemanticPath(outcome.semanticPathJson)?.rootObject;if(rootObject&&subtypeNames.has(rootObject)&&!metrics.subtypeRootObjects.includes(rootObject))metrics.subtypeRootObjects.push(rootObject);metrics.contextTablesTotal+=Number(outcome.tableCount||0);metrics.planningAttemptsTotal+=Number(outcome.planningAttempts||0);metrics.durationMsTotal+=Number(outcome.durationMs||0); }
function finalizeGateMetrics(metrics) { const total=Math.max(1,metrics.total);metrics.subtypeRootObjects.sort();metrics.subtypeRootCoverage=metrics.subtypeRootObjects.length;metrics.passRate=metrics.passed/total;metrics.joinFailureRate=metrics.joinFailures/total;metrics.refusalRate=metrics.refused/total;metrics.semanticExecutionRate=metrics.semanticExecutions/total;metrics.averageContextTables=metrics.contextTablesTotal/total;metrics.averagePlanningAttempts=metrics.planningAttemptsTotal/total;metrics.averageDurationMs=metrics.durationMsTotal/total;delete metrics.contextTablesTotal;delete metrics.planningAttemptsTotal;delete metrics.durationMsTotal; }
function parseSemanticPath(value) { if(!value)return null;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return null;} }
function evaluateGate(baseline,candidate) { const accuracyOk=candidate.passRate>=baseline.passRate;const joinOk=baseline.joinFailures>0?candidate.joinFailures<baseline.joinFailures:candidate.joinFailures===0;const semanticOk=candidate.semanticExecutions>0;const passed=accuracyOk&&joinOk&&semanticOk;const reasons=[];if(!accuracyOk)reasons.push("语义结果等价率低于兼容链路");if(!joinOk)reasons.push(baseline.joinFailures?"JOIN 类失败没有下降":"语义链路引入了新的 JOIN 类失败");if(!semanticOk)reasons.push("候选组没有实际进入语义 Query Plan");return {passed,decision:passed?"enable_prefer":"keep_off",reason:passed?"结果等价率未下降、JOIN 类失败满足门禁，且候选组已实际进入语义计划。":reasons.join("；")}; }
function agentMetricsFromAnswer(answer) { const evidence=answer?.evidence||{};const trace=Array.isArray(evidence.toolTrace)?evidence.toolTrace:Array.isArray(answer?.toolTrace)?answer.toolTrace:[];const tokenUsage=evidence.tokenUsage||answer?.tokenUsage||null;return {agentExecution:evidence.planningMode==="agent"||answer?.planningMode==="agent"?1:0,iterations:Number(evidence.iterations||answer?.planningAttempts||0),toolCalls:trace.length,toolSuccesses:trace.filter((item)=>item.ok).length,clarificationCount:answer?.clarification?1:Array.isArray(evidence.clarifications)?evidence.clarifications.length:Array.isArray(answer?.clarifications)?answer.clarifications.length:0,budgetFallback:evidence.budgetFallback?1:0,repeatedActions:trace.filter((item)=>String(item.errorCode||"").startsWith("REPEATED_ACTION")).length,intentFailures:trace.filter((item)=>item.failureClass==="intent_error").length,incompleteFailures:trace.filter((item)=>item.failureClass==="result_incomplete").length,totalTokens:tokenUsage?.available&&Number(tokenUsage.totalTokens)>0?Number(tokenUsage.totalTokens):null}; }
function createAgentGateMetrics(requestedMode) { return {gateKind:"agent",requestedMode,total:0,passed:0,failed:0,refused:0,agentExecutions:0,iterationsTotal:0,toolCalls:0,toolSuccesses:0,clarifications:0,budgetFallbacks:0,repeatedActions:0,intentFailures:0,incompleteFailures:0,durations:[],tokenSamples:[]}; }
function addAgentGateOutcome(metrics,outcome) { metrics.total++;if(outcome.passed)metrics.passed++;else metrics.failed++;if(["join","retrieval","generation","retrieval_miss","schema_gap","policy_block","result_incomplete"].includes(outcome.failureClass))metrics.refused++;metrics.agentExecutions+=Number(outcome.agentExecution||0);metrics.iterationsTotal+=Number(outcome.iterations||0);metrics.toolCalls+=Number(outcome.toolCalls||0);metrics.toolSuccesses+=Number(outcome.toolSuccesses||0);metrics.clarifications+=Number(outcome.clarificationCount||0);metrics.budgetFallbacks+=Number(outcome.budgetFallback||0);metrics.repeatedActions+=Number(outcome.repeatedActions||0);metrics.intentFailures+=Number(outcome.intentFailures||0);metrics.incompleteFailures+=Number(outcome.incompleteFailures||0);metrics.durations.push(Number(outcome.durationMs||0));if(Number.isFinite(Number(outcome.totalTokens))&&Number(outcome.totalTokens)>0)metrics.tokenSamples.push(Number(outcome.totalTokens)); }
function finalizeAgentGateMetrics(metrics) { const total=Math.max(1,metrics.total);metrics.passRate=metrics.passed/total;metrics.refusalRate=metrics.refused/total;metrics.agentExecutionRate=metrics.agentExecutions/total;metrics.averageIterations=metrics.iterationsTotal/total;metrics.toolSuccessRate=metrics.toolCalls?metrics.toolSuccesses/metrics.toolCalls:metrics.requestedMode==="single"?1:0;metrics.clarificationRate=metrics.clarifications/total;metrics.budgetFallbackRate=metrics.budgetFallbacks/total;metrics.repeatedActionRate=metrics.toolCalls?metrics.repeatedActions/metrics.toolCalls:0;metrics.intentFailureRate=metrics.toolCalls?metrics.intentFailures/metrics.toolCalls:0;metrics.incompleteFailureRate=metrics.toolCalls?metrics.incompleteFailures/metrics.toolCalls:0;metrics.averageDurationMs=average(metrics.durations);metrics.p95DurationMs=percentile(metrics.durations,.95);metrics.tokenCoverage=metrics.tokenSamples.length/total;metrics.averageTokens=average(metrics.tokenSamples);metrics.p95Tokens=percentile(metrics.tokenSamples,.95);delete metrics.iterationsTotal;delete metrics.durations;delete metrics.tokenSamples; }
function evaluateAgentGate(baseline,candidate,payload={}) { const thresholds={maxP95LatencyRatio:positive(payload.maxP95LatencyRatio,3),maxAverageTokenRatio:positive(payload.maxAverageTokenRatio,4),maxClarificationRate:ratio(payload.maxClarificationRate,.2),maxBudgetFallbackRate:ratio(payload.maxBudgetFallbackRate,.1),maxRepeatedActionRate:ratio(payload.maxRepeatedActionRate,.1),minToolSuccessRate:ratio(payload.minToolSuccessRate,.8)};const latencyLimit=Math.max(baseline.p95DurationMs*thresholds.maxP95LatencyRatio,baseline.p95DurationMs+2_000);const tokenLimit=Math.max(baseline.averageTokens*thresholds.maxAverageTokenRatio,baseline.averageTokens+1_000);const checks={accuracy:candidate.passRate>=baseline.passRate,agentExecution:candidate.agentExecutionRate>0,latency:candidate.p95DurationMs<=latencyLimit,tokens:baseline.tokenCoverage===1&&candidate.tokenCoverage===1&&candidate.averageTokens<=tokenLimit,clarification:candidate.clarificationRate<=thresholds.maxClarificationRate,budget:candidate.budgetFallbackRate<=thresholds.maxBudgetFallbackRate,repetition:candidate.repeatedActionRate<=thresholds.maxRepeatedActionRate,tools:candidate.toolSuccessRate>=thresholds.minToolSuccessRate};const reasons=[];if(!checks.accuracy)reasons.push("Agent 结果等价率低于单发管道");if(!checks.agentExecution)reasons.push("候选组没有实际进入 Agent Loop");if(!checks.latency)reasons.push(`Agent P95 延迟 ${candidate.p95DurationMs}ms 超过门禁 ${Math.round(latencyLimit)}ms`);if(!checks.tokens)reasons.push(baseline.tokenCoverage<1||candidate.tokenCoverage<1?"模型 token usage 覆盖不完整":"Agent 平均 token 超过成本门禁");if(!checks.clarification)reasons.push("Agent 澄清率超过门禁");if(!checks.budget)reasons.push("Agent 超预算兜底率超过门禁");if(!checks.repetition)reasons.push("Agent 重复动作率超过门禁");if(!checks.tools)reasons.push("Agent 工具成功率低于门禁");const passed=Object.values(checks).every(Boolean);return {passed,decision:passed?"enable_agent_prefer":"keep_off",reason:passed?"Agent 结果等价率未下降，且延迟、token、澄清、预算、重复动作与工具成功率均满足门禁。":reasons.join("；"),checks,thresholds:{...thresholds,latencyLimitMs:latencyLimit,averageTokenLimit:tokenLimit}}; }
function percentile(values,quantile) { if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*quantile)-1))]; }
function average(values) { return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0; }
function positive(value,fallback) { const number=Number(value);return Number.isFinite(number)&&number>0?number:fallback; }
function ratio(value,fallback) { const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=1?number:fallback; }
function classifyRefusal(answer) { if(answer?.failureClass)return answer.failureClass;if(/\bjoin\b|关联|关系|路径/i.test(String(answer.reason||"")))return "join";return answer.missingTerm?"retrieval":"generation"; }
function repairHintsFor(store,sourceId,{question,failureClass,answer,ontologySchemaVersionId}) { const record=ontologySchemaVersionId?store.getOntologySchemaVersion(Number(ontologySchemaVersionId)):store.getPublishedOntologySchema(sourceId);if(!record?.schema)return [];return buildSemanticRepairHints({schema:record.schema,question,failureClass,queryPlan:answer?.evidence?.queryPlan,semanticPath:answer?.evidence?.semanticPath}); }
function normalizeCase(sourceId,input) { return {sourceId,setName:String(input.setName).trim(),question:String(input.question).trim(),goldSql:String(input.goldSql||"").trim()||null,category:String(input.category||"未分类").trim(),heldOut:input.heldOut?1:0}; }
function publicCase(item) { return {...item,goldSql:item.heldOut?null:item.goldSql,hasGoldSql:Boolean(item.goldSql)}; }
function validateCase(input) { if(!input||typeof input!=="object")throw httpError(400,"评测用例格式错误");if(!String(input.setName||"").trim())throw httpError(400,"setName 必填");if(!String(input.question||"").trim())throw httpError(400,"question 必填");if(!String(input.goldSql||"").trim())throw httpError(400,"goldSql 必填"); }
function evalCaseKey(item) { return `${String(item.setName||"").trim()}\u0000${String(item.question||"").trim()}`; }
function sameCaseDefinition(left,right) { return normalizeSql(left.goldSql)===normalizeSql(right.goldSql)&&String(left.category||"未分类").trim()===String(right.category||"未分类").trim()&&Boolean(left.heldOut)===Boolean(right.heldOut); }
function normalizeSql(value) { return String(value||"").replace(/\s+/g," ").trim().replace(/;$/,"").toLowerCase(); }
function buildGoldPolicy(store,sourceId,config) { const tables=store.listTables(sourceId).filter((table)=>table.active&&table.grade!=="C");const raw=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));const columns=buildQueryColumnSemantics(raw);return {allowedTables:tables.map((table)=>table.tableName),allowedColumns:columns.allowedColumns,columnKinds:columns.columnKinds,allowedRelations:store.listRelations(sourceId,true),maxRows:config.queryMaxRows,enums:{}}; }
function classified(failureClass,message,suggestion) { const error=new Error(message);error.failureClass=failureClass;error.suggestion=suggestion;return error; }
function httpError(status,message) { const error=new Error(message);error.status=status;return error; }
function normalizeEvalAgentMode(value) { const mode=String(value||"off").trim().toLowerCase();if(!["off","prefer","required"].includes(mode))throw new Error("queryAgentMode 必须是 off、prefer、required 之一");return mode; }
function evalRequestedMode(mode) { return mode==="off"?"single":mode==="required"?"agent_required":"agent_prefer"; }
