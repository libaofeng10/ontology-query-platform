import { randomUUID } from "node:crypto";
import { redactTypedLiterals } from "./query-column-semantics.mjs";
import { normalizeQueryRow } from "./query-result-normalization.mjs";
import { createClaudeQuerySnapshot } from "./claude-query-snapshot.mjs";
import { createClaudeQueryMcpSession } from "./claude-query-mcp.mjs";
import { createQueryExecutionKernel } from "./query-execution-kernel.mjs";

const QUERY_PROMPT_VERSION="claude-query-v1";

// The platform no longer plans SQL.  `ask` is a thin orchestrator around the
// Claude Code branch: sessions, pending clarifications, audit and evidence are
// still owned by the platform; question understanding, table/column selection,
// SQL generation and the answer's wording are Claude Code's.
export function createQueryService({store,connector,config,claudeBridge,claudeSnapshotBuilder,claudeMcpFactory}) {
  const pendingLoops=new Map();const pendingBySession=new Map();
  const deps={claudeBridge:claudeBridge||null,claudeSnapshotBuilder:claudeSnapshotBuilder||createClaudeQuerySnapshot,claudeMcpFactory:claudeMcpFactory||createClaudeQueryMcpSession};

  async function ask({sourceId,question,userName="local-user",sessionId,pendingId,ontologySchemaVersionId,signal,onEvent}) {
    if(!pendingId)sweepExpiredPending();
    const source=store.getSource(sourceId);
    if(!source) throw httpError(404,"数据源不存在");
    if(!question?.trim()) throw httpError(400,"问题不能为空");
    let session=sessionId?store.getSession(sessionId):null;
    if(sessionId&&!session) throw httpError(404,"问数会话不存在");
    if(session&&(session.sourceId!==sourceId||session.userName!==userName)) throw httpError(403,"不能访问其他数据源或用户的问数会话");
    if(!session) session=store.createSession({id:randomUUID(),sourceId,userName,title:"问数会话"});
    if(pendingId)return resumePending({pendingId,source,session,userName,answer:question.trim(),signal,onEvent});
    invalidatePendingSession(session.id);
    const conversationHistory=store.getSessionPlanningHistory?.(session.id,10)||[];
    const started=Date.now();

    // Claude Code owns planning.  If the bridge is off, refuse rather than
    // falling back to a platform-side planner that no longer exists.
    if(!deps.claudeBridge||!hasClaudeRunner(deps.claudeBridge)) {
      const reason="问数依赖 Claude Code 桥接，但 Claude 查询未启用或不可用。请先配置 Claude Code 可执行文件与模型。";
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:reason,durationMs:Date.now()-started,rowCount:0,failureClass:"claude_unavailable"});
      return {refused:true,reason,failureClass:"claude_unavailable",sessionId:session.id};
    }
    throwIfAborted(signal);

    try {
      const context=buildClaudeContext(store,sourceId,ontologySchemaVersionId);
      const outcome=await runClaudeQueryBranch({store,connector,config,source,question,context,conversationHistory,deps,started,requestId:session.id,signal,onEvent});
      const terminal=finalizeClaudeOutcome({outcome,source,session,userName,question,context,started});
      return terminal||{refused:true,reason:"Claude 查询未返回可识别的结果",failureClass:"protocol_error",sessionId:session.id};
    } catch(error) {
      if(signal?.aborted) throw error;
      const failureClass=error?.code==="BRIDGE_CLOSED"?"bridge_closed":"protocol_error";
      const reason=`问数失败：${failureMessage(error)}`;
      store.addAudit({userName,sourceId:source.id,question:redactTypedLiterals(question),verdict:"failed",failReason:reason,durationMs:Date.now()-started,rowCount:0,planningMode:"claude",failureClass,promptVersion:QUERY_PROMPT_VERSION});
      return {refused:true,reason,failureClass,planningMode:"claude",...(error?.code?{errorCode:String(error.code)}:{}),sessionId:session.id};
    }
  }

  function finalizeClaudeOutcome({outcome,source,session,userName,question,context,started}) {
    const clarificationCount=Array.isArray(outcome.clarifications)?outcome.clarifications.length:0;
    if(outcome.status==="clarification") {
      invalidatePendingSession(session.id);
      const pendingId=randomUUID();const ttl=Number(config.queryPendingTtlMs)>0?Number(config.queryPendingTtlMs):10*60_000;const expiresAt=Date.now()+ttl;
      const auditId=store.addAudit({userName,sourceId:source.id,question,verdict:"clarified",durationMs:outcome.durationMs??Date.now()-started,rowCount:0,planningMode:"claude",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount:1,toolTraceJson:JSON.stringify(redactClaudeBoundaryValue(outcome.toolTrace||[]))});
      const response={clarification:{pendingId,question:outcome.clarification.question,options:outcome.clarification.options,allowFreeText:outcome.clarification.allowFreeText,expiresAt:new Date(expiresAt).toISOString()},sessionId:session.id,planningMode:"claude",planningAttempts:outcome.iterations,toolTrace:redactClaudeBoundaryValue(outcome.toolTrace||[]),tokenUsage:outcome.tokenUsage};
      pendingLoops.set(pendingId,{kind:"claude",id:pendingId,sourceId:source.id,sessionId:session.id,userName,question,context,started,resume:outcome.resume,expiresAt,publicState:{question,response}});pendingBySession.set(session.id,pendingId);
      return {...response,_auditId:auditId,_sessionQuestion:question};
    }
    if(outcome.status==="answered") {
      const runs=Array.isArray(outcome.runs)&&outcome.runs.length?outcome.runs:[outcome.run].filter(Boolean);
      const combined=combineQueryRuns(runs);
      const conclusion=redactTypedLiterals(outcome.conclusion||'查询已完成。');
      const delta=outcome.delta?redactTypedLiterals(outcome.delta):undefined;
      const answer={id:`query-${Date.now()}`,sessionId:session.id,question,conclusion,delta,columns:combined.columns,rows:combined.rows,resultSets:combined.resultSets,chart:runs.length===1?inferChart(runs[0].rows,runs[0].fields):null,evidence:{pages:outcome.readEvidence?.pages||[],rules:outcome.readEvidence?.rules||[],tables:combined.tables,joins:combined.joins,sql:combined.sql,sqls:combined.sqls,durationMs:outcome.durationMs??Date.now()-started,scannedRows:combined.scannedRows,coverage:'ontology',retrievalMode:'claude',planningMode:'claude',planningAttempts:outcome.iterations,iterations:outcome.iterations,ontologySchemaVersion:outcome.ontologySchemaVersion??undefined,promptVersion:outcome.promptVersion||undefined,toolTrace:redactClaudeBoundaryValue(outcome.toolTrace||[]),stateTransitions:outcome.stateTransitions,budgetFallback:outcome.budgetFallback||undefined,resultDelivery:runs.some((run)=>run.resultDelivery==='direct')?'direct':'preview',clarifications:outcome.clarifications||[],tokenUsage:outcome.tokenUsage,resultCompleteness:combined.completeness}};
      const auditId=store.addAudit({userName,sourceId:source.id,question:redactTypedLiterals(question),retrievedPages:JSON.stringify(answer.evidence.pages),sql:combined.sql,verdict:"passed",durationMs:answer.evidence.durationMs,rowCount:combined.rows.length,planningMode:"claude",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount,toolTraceJson:JSON.stringify(answer.evidence.toolTrace),promptVersion:outcome.promptVersion||null,ontologySchemaVersion:outcome.ontologySchemaVersion??null});
      store.updateSession(session.id,nextSessionContext(session.context,combined.tables,[...new Set(answer.evidence.pages)]));return {...answer,_auditId:auditId,_sessionQuestion:question};
    }
    if(["refused","failed","cancelled"].includes(outcome.status)) {
      const reason=redactTypedLiterals(outcome.reason||"Claude 查询未完成");
      const auditId=store.addAudit({userName,sourceId:source.id,question:redactTypedLiterals(question),verdict:outcome.status==="failed"?"failed":"refused",failReason:reason,durationMs:outcome.durationMs??Date.now()-started,rowCount:0,planningMode:"claude",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount,promptVersion:outcome.promptVersion||null,ontologySchemaVersion:outcome.ontologySchemaVersion??null,toolTraceJson:JSON.stringify(redactClaudeBoundaryValue(outcome.toolTrace||[])),failureClass:outcome.failureClass||"policy_block"});
      return {refused:true,reason,failureClass:outcome.failureClass||"policy_block",...(outcome.errorCode?{errorCode:outcome.errorCode}:{}),sessionId:session.id,planningMode:"claude",planningAttempts:outcome.iterations,toolTrace:redactClaudeBoundaryValue(outcome.toolTrace||[]),clarifications:outcome.clarifications||[],_auditId:auditId,_sessionQuestion:question};
    }
    return null;
  }

  async function resumePending({pendingId,source,session,userName,answer,signal,onEvent}) {
    const pending=pendingLoops.get(pendingId);
    if(!pending)throw httpError(404,"待澄清的问题 不存在或已失效");
    if(pending.expiresAt<=Date.now()){deletePending(pending);throw httpError(410,"待澄清的问题 已过期，请重新提问");}
    if(pending.sourceId!==source.id||pending.sessionId!==session.id||pending.userName!==userName)throw httpError(403,"不能恢复其他用户、会话或数据源的问题");
    deletePending(pending);
    let outcome;
    try { outcome=await pending.resume(answer,{signal,onEvent}); }
    catch(error) {
      if(signal?.aborted)throw error;
      outcome={status:"failed",reason:`Claude 续答失败：${safeError(error)}`,failureClass:"execution_error",errorCode:error?.code,toolTrace:[],clarifications:[],iterations:0};
    }
    return finalizeClaudeOutcome({outcome,source,session,userName,question:pending.question,context:pending.context,started:pending.started});
  }

  function sweepExpiredPending(){const now=Date.now();for(const pending of pendingLoops.values())if(pending.expiresAt<=now)deletePending(pending);}
  function invalidatePendingSession(sessionId){const id=pendingBySession.get(sessionId);if(id){const pending=pendingLoops.get(id);if(pending)deletePending(pending);else pendingBySession.delete(sessionId);}}
  function deletePending(pending){pendingLoops.delete(pending.id);if(pendingBySession.get(pending.sessionId)===pending.id)pendingBySession.delete(pending.sessionId);}
  function discardPending({pendingId,sourceId,sessionId,userName}){const pending=pendingLoops.get(pendingId);if(!pending)return false;if(pending.sourceId!==sourceId||pending.sessionId!==sessionId||pending.userName!==userName)return false;deletePending(pending);return true;}
  function getPendingClarification({sessionId,userName}){sweepExpiredPending();const id=pendingBySession.get(sessionId);if(!id)return null;const pending=pendingLoops.get(id);if(!pending||pending.userName!==userName)return null;return pending.publicState||null;}
  return {ask,discardPending,getPendingClarification};
}

function hasClaudeRunner(bridge){return bridge&&(typeof bridge.run==="function"||typeof bridge.execute==="function"||typeof bridge.invoke==="function");}

function buildClaudeContext(store,sourceId,ontologySchemaVersionId) {
  const ontologyRecord=ontologySchemaVersionId?store.getOntologySchemaVersion(Number(ontologySchemaVersionId)):store.getPublishedOntologySchema(sourceId);
  if(ontologySchemaVersionId&&(!ontologyRecord||ontologyRecord.sourceId!==sourceId))throw httpError(404,"指定的 Ontology Schema 版本不存在或不属于当前数据源");
  const tables=store.listTables(sourceId);
  return {
    tables,
    columns:Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)])),
    relations:store.listRelations(sourceId,true),
    knowledge:store.listKnowledge(sourceId).filter((page)=>page.verified),
    rules:store.listRules(sourceId).filter((rule)=>rule.verified),
    enums:Object.fromEntries(tables.map((table)=>[table.tableName,store.listEnums(sourceId,table.tableName)])),
    ontologyRecord,
    retrieval:null,
  };
}

async function runClaudeQueryBranch({store,connector,config,source,question,context,conversationHistory,deps,started,requestId,signal,onEvent,clarifications=[]}) {
  const sourceId=source.id;
  const claudeConfig=config.claudeQuery||{};
  const refusal=(reason,failureClass,errorCode)=>({status:"refused",reason,failureClass,errorCode,iterations:0,toolTrace:[],durationMs:Date.now()-started});
  if(claudeBudgetDisabled(claudeConfig.maxBudgetUsd)) return refusal("Claude 单请求预算为 0，已拒绝启动 Claude 查询","budget_disabled","BUDGET_DISABLED");
  if(!String(claudeConfig.model??"").trim()) return refusal("Claude 问数已启用，但未配置精确模型 ID，已拒绝启动","model_missing","MODEL_REQUIRED");
  const bridge=deps.claudeBridge;
  const runner=bridge&&(bridge.run||bridge.execute||bridge.invoke);
  if(typeof runner!=="function") return {status:"failed",reason:"Claude bridge 不可用",failureClass:"cli_unavailable",iterations:0,toolTrace:[],durationMs:Date.now()-started};

  const snapshot=await deps.claudeSnapshotBuilder({...context,context,sourceId,source:snapshotSource(source),store,allowUnpublished:context.ontologyRecord?.status==="draft"});
  if(!snapshot||typeof snapshot.read!=="function") throw new Error("Claude ontology snapshot 构造失败");
  const kernelCatalog=buildKernelCatalog(snapshot,config);
  const kernel=createQueryExecutionKernel({connector,source,config,question,catalog:kernelCatalog,schemaMode:"database",queryIntent:null,retrievalEvidence:[],signal,maxSqlCalls:claudeConfig.maxSqlCalls??config.queryMaxSqlCalls,maxScannedRows:claudeConfig.maxScannedRows??config.queryMaxScannedRows,preview:{maxRows:20,maxBytes:24*1024,maxCellChars:200}});
  const produced=await deps.claudeMcpFactory({snapshot,kernel,source,sourceId,requestId,signal,onEvent,listen:true,previewRows:20,previewBytes:24*1024,initialDisclosedTables:[]});
  const mcpSession=produced?.session||produced;
  if(!mcpSession) throw new Error("Claude MCP session 构造失败");
  try {
    const outcome=await runner.call(bridge,{
      requestId,question,context:{conversationHistory,clarifications,ontologySchemaVersion:snapshot.schemaVersion},conversationHistory,queryIntent:null,retrievalEvidence:[],snapshot,kernel,mcp:mcpSession,mcpSession,signal,onEvent,closeMcp:false,requireApiKey:claudeConfig.requireApiKey??true,requireModel:claudeConfig.requireModel??false,binary:claudeConfig.binary,promptVersion:claudeConfig.promptVersion,timeoutMs:claudeConfig.timeoutMs,maxTurns:claudeConfig.maxTurns,maxBudgetUsd:claudeConfig.maxBudgetUsd,model:claudeConfig.model,mcpFactory:null,
    });
    const settled=await settleClaudeBridgeOutcome({outcome,mcpSession,snapshot,claudeConfig,started});
    settled.readEvidence=mcpSession.getReadEvidence?.()||{pages:[],rules:[]};
    settled.clarifications=clarifications;
    if(settled.status==="clarification") {
      settled.resume=async(answer,{signal:resumeSignal,onEvent:resumeEvent}={})=>{
        if(settled.clarification.allowFreeText===false&&!settled.clarification.options?.includes(answer))throw httpError(400,"请选择提供的澄清选项");
        return runClaudeQueryBranch({store,connector,config,source,question,context,conversationHistory,deps,started,requestId,signal:resumeSignal,onEvent:resumeEvent,clarifications:[...clarifications,{question:settled.clarification.question,answer}]});
      };
    }
    return settled;
  } finally {
    try { await mcpSession.close?.(); } catch { /* best effort */ }
  }
}

function claudeBudgetDisabled(value) { return value!==null&&value!==undefined&&value!==""&&Number(value)===0; }

async function settleClaudeBridgeOutcome({outcome,mcpSession,snapshot,claudeConfig,started}) {
  const settled={...(outcome||{})};
  if(settled.ontologySchemaVersion==null) settled.ontologySchemaVersion=snapshot?.schemaVersion??null;
  if(!settled.promptVersion) settled.promptVersion=outcome?.metadata?.promptVersion||outcome?.promptVersion||claudeConfig.promptVersion||null;
  if(settled.status!=="answered") return settled;
  const protocolRefusal=(reason,errorCode)=>({...settled,status:"refused",reason,failureClass:"protocol_error",errorCode,durationMs:settled.durationMs??Date.now()-started});
  const ids=Array.isArray(outcome.executionIds)?outcome.executionIds:[];
  if(!ids.length) return protocolRefusal("Claude 返回 answered 但没有提供任何 execution ID","EXECUTION_IDS_REQUIRED");
  let resolved;
  try { resolved=await resolveClaudeExecutions(mcpSession,ids); }
  catch(error) { resolved={ok:false,error:safeError(error),errorCode:"EXECUTION_RESOLVE_FAILED"}; }
  if(!resolved?.ok) return protocolRefusal(String(resolved?.error||"无法校验 Claude 返回的 execution ID"),resolved?.errorCode||"UNKNOWN_EXECUTION_ID");
  return {...settled,run:undefined,runs:resolved.runs.map((run)=>normalizeClaudeRun(run,snapshot))};
}

async function resolveClaudeExecutions(mcpSession,ids) {
  const resolve=mcpSession?.resolveExecutions||mcpSession?.resolveExecutionIds||mcpSession?.registry?.resolve;
  if(typeof resolve!=="function") return {ok:false,error:"无法校验 execution ID：请求级执行注册表不可用",errorCode:"EXECUTION_REGISTRY_UNAVAILABLE"};
  const result=await resolve.call(mcpSession,ids);
  if(Array.isArray(result)) return {ok:true,runs:result};
  if(result?.ok===false) return {ok:false,error:result.error||result.reason,errorCode:result.errorCode};
  const runs=Array.isArray(result?.runs)?result.runs:[];
  if(runs.length!==ids.length) return {ok:false,error:"execution ID 与已执行结果数量不一致",errorCode:"EXECUTION_COUNT_MISMATCH"};
  return {ok:true,runs};
}

function normalizeClaudeRun(run,snapshot) {
  void snapshot;
  const tables=(Array.isArray(run?.tables)&&run.tables.length?run.tables:run?.verdict?.tables)||[];
  const fields=claudeRunFields(run);
  const allowed=new Set(fields.map((field)=>field.name));
  const rows=(Array.isArray(run?.rows)?run.rows:[]).map((row)=>Object.fromEntries(Object.entries(row||{}).filter(([name])=>allowed.has(name))));
  const verdict=run?.verdict&&typeof run.verdict==="object"?{...run.verdict,tables:run.verdict.tables||tables}:{tables};
  return {...run,tables,verdict,fields,columns:fields,rows};
}

function claudeRunFields(run) {
  const raw=Array.isArray(run?.fields)&&run.fields.length?run.fields
    :Array.isArray(run?.columns)&&run.columns.length?run.columns
    :Object.keys((Array.isArray(run?.rows)?run.rows:[])[0]||{});
  const names=raw.map((item)=>typeof item==="string"?item:item?.name??item?.columnName).filter(Boolean).map((item)=>String(item));
  return [...new Set(names)].map((name)=>({name}));
}

function safeError(error) { return String(error?.message||error).replace(/(password|token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]").slice(0,1_000); }

function snapshotSource(source) { return {id:source.id}; }
function buildKernelCatalog(snapshot,config) {
  return {tables:snapshot.tables,columnsByTable:snapshot.columnsByTable,relations:snapshot.relations,policy:{valueKinds:[],maxRows:config.queryMaxRows||500,enums:{}}};
}
function redactClaudeBoundaryValue(value,depth=0,seen=new WeakSet()) {
  if(value==null)return value;
  if(typeof value==="string")return redactTypedLiterals(value);
  if(typeof value!=="object")return value;
  if(seen.has(value))return "[Circular]";seen.add(value);
  if(Array.isArray(value))return value.slice(0,200).map((item)=>redactClaudeBoundaryValue(item,depth+1,seen));
  const result={};for(const [key,item] of Object.entries(value)){result[key]=redactClaudeBoundaryValue(item,depth+1,seen);}return result;
}

function combineQueryRuns(inputRuns=[]) {
  const runs=inputRuns.filter(Boolean).map((run,index)=>{
    const rows=(run.rows||[]).map(normalizeQueryRow);
    const fields=(Array.isArray(run.fields)&&run.fields.length?run.fields:Object.keys(rows[0]||{}).map((name)=>({name}))).filter((field)=>field?.name);
    const name=queryRunName(run.name,index);
    const columns=fields.map((field)=>queryColumn(field.name,rows));
    return {...run,name,rows,fields,columns};
  });
  const sqls=runs.map((run)=>({name:run.name,sql:run.sql,tables:run.verdict?.tables||[],joins:run.verdict?.joins||[],scannedRows:Number(run.scannedRows||0),durationMs:Number(run.durationMs||0),rowCount:run.rows.length}));
  const sql=sqls.length===1?sqls[0].sql:sqls.map((item,index)=>`-- [${index+1}] ${item.name}\n${item.sql}`).join("\n\n");
  const tables=[...new Set(sqls.flatMap((item)=>item.tables))];
  const joins=[...new Set(sqls.flatMap((item)=>item.joins))];
  const resultSets=runs.map((run)=>({name:run.name,columns:run.columns,rows:run.rows,rowCount:run.rows.length,mayBeTruncated:runMayBeTruncated(run)}));
  const incomplete=resultSets.filter((item)=>item.mayBeTruncated).map((item)=>item.name);
  const completeness={complete:incomplete.length===0,mayBeTruncated:incomplete.length>0,incompleteResultSets:incomplete,reason:incomplete.length?`结果行数达到安全 LIMIT，${incomplete.join("、")} 可能未完整返回`:undefined};
  if(runs.length<=1) return {columns:runs[0]?.columns||[],rows:runs[0]?.rows||[],resultSets,sql,sqls,tables,joins,scannedRows:sqls.reduce((sum,item)=>sum+item.scannedRows,0),completeness};
  const physicalKeys=[...new Set(runs.flatMap((run)=>run.columns.map((column)=>column.key)))];
  let scopeKey="_query_scope";while(physicalKeys.includes(scopeKey))scopeKey=`_${scopeKey}`;
  const rows=runs.flatMap((run)=>run.rows.map((row)=>({[scopeKey]:run.name,...row})));
  const columns=[{key:scopeKey,label:"查询范围",type:"text"},...physicalKeys.map((key)=>queryColumn(key,rows))];
  return {columns,rows,resultSets,sql,sqls,tables,joins,scannedRows:sqls.reduce((sum,item)=>sum+item.scannedRows,0),completeness};
}
function runMayBeTruncated(run){const limit=Number(run?.verdict?.limit?.effective);return Number.isFinite(limit)&&limit>0&&(run?.rows||[]).length>=limit;}
function queryColumn(key,rows) { return {key,label:key,type:rows.some((row)=>typeof row?.[key]==="number")?"number":"text"}; }
function queryRunName(value,index) { return String(value||`查询 ${index+1}`).replace(/\s+/g," ").trim().slice(0,100)||`查询 ${index+1}`; }
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
function throwIfAborted(signal){if(signal?.aborted){const error=new Error("查询已取消");error.name="AbortError";error.code="ABORT_ERR";throw error;}}
function failureMessage(error) { return String(error?.message||error).replace(/(password|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]").slice(0,1000); }
function inferChart(rows,fields) { if(!rows.length)return null;const keys=fields.map((field)=>field.name);const isIdentifier=(key)=>/(^id$|_id$|^id_|identifier|编号|编码|code$)/i.test(key);if(keys.some(isIdentifier))return null;const numeric=keys.filter((key)=>typeof rows[0]?.[key]==='number');const yKey=numeric.find((key)=>/count|amount|total|rate|ratio|percent|qty|quantity|sum|avg|value|score|price|revenue|cost|duration|number|balance/i.test(key));if(!yKey)return null;const xKey=keys.find((key)=>key!==yKey&&/date|time|month|day|year|name|type|channel|category/i.test(key))||keys.find((key)=>key!==yKey);if(!xKey)return null;const type=/date|time|month|day|year/i.test(xKey)?'line':'bar';if(type==='bar'&&rows.length>24)return null;return {type,xKey,yKey}; }

function nextSessionContext(previous={},tableNames=[],pageSlugs=[]) {
  const tables=[...new Set(tableNames.map(String))],pages=[...new Set(pageSlugs.map(String))];
  return {tableNames:tables,pageSlugs:pages,recentTableNames:[...new Set([...tables,...(previous.recentTableNames||[]),...(previous.tableNames||[])])].slice(0,12),recentPageSlugs:[...new Set([...pages,...(previous.recentPageSlugs||[]),...(previous.pageSlugs||[])])].slice(0,20)};
}
