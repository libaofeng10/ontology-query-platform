import { createHash, randomUUID } from "node:crypto";
import { demoQuery } from "./demo-query.mjs";
import { guardSql } from "./sql-guard.mjs";
import { retrieveKnowledge } from "./knowledge-retrieval.mjs";
import { callLlmJson, isLlmConfigured, llmConfigurationIssues } from "./llm-client.mjs";
import { validateSemanticSchema } from "./semantic-schema.mjs";
import { compileSemanticQueryPlan, semanticPlanningView, SemanticQueryPlanError } from "./semantic-query-plan.mjs";
import { runQueryAgent } from "./query-agent-loop.mjs";
import { buildQueryColumnSemantics, detectQuestionValueKinds, redactTypedLiterals } from "./query-column-semantics.mjs";
import { findKnowledgeOntologyMappingConflicts } from "./knowledge-column-refs.mjs";
import { probeZeroResult } from "./query-result-probe.mjs";
import { normalizeQueryRow } from "./query-result-normalization.mjs";
import { missingExhaustiveAccountProductColumns, missingExhaustiveAccountTables, missingIntentSubjectFacets, missingRequiredRetrievalFacets, queryIntentFilterError, queryResultContractValidation } from "./query-scope-coverage.mjs";
import { applyGlobalRowDomainRules, buildIntentRetrievalQuestion, catalogFilterConcepts, knowledgeIntentConcepts, knowledgeIntentRowDomains, mergeContextualQueryIntent, parseQueryIntent } from "./query-intent.mjs";
import { buildQueryResultContract, validateQueryRunSet } from "./query-result-contract.mjs";
import { failureClassFor } from "./query-errors.mjs";
import { QUERY_PROMPT_DEFAULTS, QUERY_PROMPT_VERSION, renderQueryPrompt } from "./query-prompts.mjs";

export function createQueryService({store,connector,config,embeddingIndex}) {
  const pendingLoops=new Map();const pendingBySession=new Map();
  async function ask({sourceId,question,userName="local-user",sessionId,pendingId,semanticQueryPlanMode,queryAgentMode,ontologySchemaVersionId,signal,onEvent}) {
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
    const tokenUsage={promptTokens:0,completionTokens:0,totalTokens:0,available:false};
    let plannerCalls=0;
    if(source.isDemo) {
      const rawAnswer=demoQuery(question.trim());
      const answer=rawAnswer.refused?rawAnswer:{...rawAnswer,evidence:{...rawAnswer.evidence,planningMode:"demo"}};
      store.addAudit({userName,sourceId,question,retrievedPages:JSON.stringify(answer.evidence?.pages||[]),sql:answer.evidence?.sql||null,verdict:answer.refused?"refused":"passed",failReason:answer.reason||null,durationMs:Date.now()-started,rowCount:answer.rows?.length||0,planningMode:"demo",planningAttempts:0});
      return {...answer,sessionId:session.id};
    }
    if(!isLlmConfigured(config.llm)) {
      const issues=llmConfigurationIssues(config.llm);
      const reason=`真实数据源已连接，但 LLM 配置不可用：${issues.join("；")}。为避免猜测或伪造结果，系统拒绝生成 SQL。`;
      // buildContext has not run yet, so there is no intent to persist — failureClass alone
      // lets the gap board bucket these rows without the degraded fingerprint path.
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:reason,durationMs:Date.now()-started,rowCount:0,failureClass:"llm_unconfigured"});
      return {refused:true,reason,missingConfiguration:issues,failureClass:"llm_unconfigured",sessionId:session.id};
    }

    const context=await buildContext(store,sourceId,question,session.context,{embeddingIndex,retrieval:config.retrieval,conversationHistory,ontologySchemaVersionId});
    const configuredAgentMode=normalizeAgentMode(queryAgentMode??config.queryAgentMode);
    const agentRollout=selectQueryAgentRollout({mode:configuredAgentMode,trafficPercent:config.queryAgentTrafficPercent,cohortKey:`${sourceId}:${session.id}`,explicit:queryAgentMode!=null});
    const agentMode=agentRollout.effectiveMode;
    const auditContext=auditContextFields(context,agentRollout);
    throwIfAborted(signal);
    const rankingLimitFailure=rankingLimitPreflight(context.queryIntent,config.queryMaxRows||500);
    if(rankingLimitFailure) {
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:rankingLimitFailure.reason,durationMs:Date.now()-started,rowCount:0,planningMode:agentMode==="required"?"agent":"legacy",failureClass:"policy_block",...auditContext});
      return {refused:true,reason:rankingLimitFailure.reason,errorCode:rankingLimitFailure.code,failureClass:"policy_block",sessionId:session.id};
    }
    const semanticMode=normalizeSemanticMode(semanticQueryPlanMode??config.semanticQueryPlanMode);
    const semanticRuntime=semanticMode==="off"?{ok:false,reason:"语义 Query Plan 已关闭"}:buildSemanticRuntime(store,sourceId,ontologySchemaVersionId);
    if(semanticMode==="required"&&!semanticRuntime.ok) {
      const reason=`语义 Query Plan 为强制模式，但当前不可用：${semanticRuntime.reason}`;
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:reason,durationMs:Date.now()-started,rowCount:0,planningMode:"semantic",semanticFallbackReason:semanticRuntime.reason,failureClass:"ontology_missing",...auditContext});
      return {refused:true,reason,failureClass:"ontology_missing",sessionId:session.id};
    }
    if(context.retrieval.coverage==="none"&&semanticRuntime.ok&&semanticQuestionMatches(question,semanticRuntime.published.schema)) context.retrieval.coverage="semantic";
    if(context.retrieval.coverage==="none") {
      const reason="问题未命中已定义的术语、指标、表或字段。请先补充业务术语，系统不会在覆盖域外猜测 SQL。";
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:reason,durationMs:Date.now()-started,rowCount:0,planningMode:semanticRuntime.ok?"semantic":"legacy",semanticFallbackReason:semanticRuntime.ok?null:semanticRuntime.reason,failureClass:"retrieval_miss",...auditContext});
      return {refused:true,reason,failureClass:"retrieval_miss",missingTerm:question,missingAssets:refusalMissingAssets(context.queryIntent),sessionId:session.id};
    }
    const missingRetrievalFacets=missingRequiredRetrievalFacets(context.retrieval);
    if(missingRetrievalFacets.length) {
      const reason=`当前检索预算或已登记的表字段无法覆盖查询所需分面：${missingRetrievalFacets.join("、")}。系统不会用其他业务对象的表代替。`;
      store.addAudit({userName,sourceId,question,verdict:"refused",failReason:reason,durationMs:Date.now()-started,rowCount:0,planningMode:semanticRuntime.ok?"semantic":"legacy",semanticFallbackReason:semanticRuntime.ok?null:semanticRuntime.reason,failureClass:"schema_gap",...auditContext});
      return {refused:true,reason,failureClass:"schema_gap",missingFacets:missingRetrievalFacets,missingAssets:refusalMissingAssets(context.queryIntent,missingRetrievalFacets),sessionId:session.id};
    }
    // 已验证知识与已发布本体是两个受信任契约。二者对同一张已建模表给出
    // 不同物理字段时，没有任何一方可以被 legacy/Agent 隐式降级为“更可信”。
    // 在调用规划模型或数据库前阻断，等待治理侧统一映射。
    if(semanticRuntime.ok) {
      const conflicts=scopedKnowledgeOntologyConflicts(context,semanticRuntime);
      if(conflicts.length) {
        const conflictSummary=conflicts.slice(0,3).map((item)=>`${item.page} → ${item.table}.${item.column}（本体属性 ${item.mappedProperty} 已映射 ${item.table}.${item.mappedColumn}）`).join("；");
        const reason=`已验证知识页与已发布本体的物理字段映射冲突：${conflictSummary}。请先统一知识定义与本体映射，系统不会猜测采用其中一列。`;
        store.addAudit({userName,sourceId,question,retrievedPages:JSON.stringify(context.knowledge.map((page)=>page.title)),verdict:"refused",failReason:`[KNOWLEDGE_ONTOLOGY_CONFLICT] ${reason}`,durationMs:Date.now()-started,rowCount:0,planningMode:"semantic",semanticFallbackReason:reason,planningAttempts:0,failureClass:"schema_gap",...auditContext});
        return {refused:true,reason,errorCode:"KNOWLEDGE_ONTOLOGY_CONFLICT",failureClass:"schema_gap",conflicts,sessionId:session.id,planningMode:"semantic",planningAttempts:0};
      }
    }
    let agentFallbackReason=null;
    let agentTried=false;
    if(agentMode==="required"||(agentMode==="prefer"&&(context.queryIntent?.ambiguities||[]).some((item)=>item.blocking))) { const terminal=await tryAgent();if(terminal)return terminal; }
    async function tryAgent() {
      agentTried=true;
      let outcome;
      try {
        outcome=await runQueryAgent({store,connector,config,source,question,context,conversationHistory,embeddingIndex,semanticRuntime,signal,onEvent});
      } catch(error) {
        if(signal?.aborted) throw error;
        const protocolFailure=error?.code==="LLM_PROTOCOL_FORMAT"||error?.code==="LLM_TOOL_UNAUTHORIZED";
        outcome={status:"failed",reason:`Agent Loop 失败：${failureMessage(error)}`,...(protocolFailure?{failureClass:"protocol_error"}:{}),iterations:0,toolTrace:[],durationMs:Date.now()-started};
      }
      const terminal=finalizeAgentOutcome({outcome,source,session,userName,question,context,started,agentMode,agentRollout});if(terminal)return terminal;
      agentFallbackReason=outcome.reason||"Agent Loop 未在预算内收敛";
      const retrievalSnapshot=agentRetrievalSnapshot(outcome,context);
      const failedAuditContext=auditContextFields({...context,queryIntent:outcome.queryIntent||context.queryIntent},agentRollout,retrievalSnapshot);
      const evidenceSelection=agentEvidenceSelection(store,sourceId,outcome,context);
      store.addAudit({userName,sourceId,question,retrievedPages:JSON.stringify(evidenceSelection.pages.map((page)=>page.title)),verdict:"failed",failReason:agentFallbackReason,durationMs:Date.now()-started,rowCount:0,planningMode:"agent",planningAttempts:outcome.iterations||0,iterations:outcome.iterations||0,clarificationCount:0,toolTraceJson:JSON.stringify(outcome.toolTrace||[]),failureClass:outcome.failureClass||"execution_error",...failedAuditContext});
      if(agentMode==="required") return {refused:true,reason:`系统没有执行不可靠 SQL：${agentFallbackReason}`,failureClass:outcome.failureClass||"execution_error",sessionId:session.id,planningMode:"agent",planningAttempts:outcome.iterations||0,toolTrace:outcome.toolTrace||[]};
      return null;
    }
    let errorFeedback="";
    let semanticCorrectionRetried=false;
    let planningMode=semanticRuntime.ok?"semantic":"legacy";
    let semanticFallbackReason=semanticRuntime.ok?null:semanticMode==="prefer"?semanticRuntime.reason:null;
    let zeroResultProbe=null;
    let lastPlanned=null;
    for(let attempt=0;attempt<3;attempt++) {
      let planned;
      try {
        if(planningMode==="semantic") {
          plannerCalls++;
          const response=await planSemanticQuery(config.llm,question,semanticRuntime.published.schema,semanticRuntime.catalog,context,conversationHistory,errorFeedback,config.queryLlmTimeoutMs||90_000,signal,config.prompts?.semanticPlanner);mergeTokenUsage(tokenUsage,response.__usage);delete response.__usage;
          if(response.unsupportedReason) throw new SemanticQueryPlanError("QUERY_PLAN_UNSUPPORTED",String(response.unsupportedReason));
          planned={...compileSemanticQueryPlan(response,{schema:semanticRuntime.published.schema,catalog:semanticRuntime.catalog,maxRows:config.queryMaxRows,ontologySchemaVersion:semanticRuntime.published.version}),planningMode:"semantic",ontologySchemaVersion:semanticRuntime.published.version};
        } else { plannerCalls++;const canExplore=agentMode==="prefer"&&!agentTried;const response=await planSql(config.llm,question,context,conversationHistory,errorFeedback,config.queryLlmTimeoutMs||90_000,signal,canExplore,config.prompts?.legacySqlPlanner);mergeTokenUsage(tokenUsage,response.__usage);delete response.__usage;planned={...response,planningMode:"legacy"}; }
        lastPlanned=planned;
      } catch(error) {
        if(signal?.aborted) throw error;
        errorFeedback=planningMode==="semantic"?semanticFailureFeedback(error):`SQL 规划模型失败：${failureMessage(error)}`;
        if(planningMode==="semantic"&&semanticMode==="prefer"&&!semanticCorrectionRetried&&isCorrectableSemanticPlanError(error)&&attempt<2) {
          semanticCorrectionRetried=true;
          continue;
        }
        if(planningMode==="semantic"&&semanticMode==="prefer") {
          semanticFallbackReason=failureMessage(error);planningMode="legacy";errorFeedback="";
          if(!context.tables.length) return refusedAfterFailure(`语义 Query Plan 失败，且没有足够的结构上下文可安全回退：${semanticFallbackReason}`,null);
          attempt-=1;continue;
        }
        if(attempt<1)continue;
        return refusedAfterFailure(errorFeedback,null);
      }
      if(planningMode==="legacy"&&planned.needsExploration) {
        if(agentMode==="prefer"&&!agentTried) {
          const terminal=await tryAgent();if(terminal)return terminal;
          errorFeedback=`Agent 探索未收敛：${agentFallbackReason||planned.needsExploration}`;continue;
        }
        errorFeedback="当前没有可用的探索通道，请基于已提供的本体、结构和关系直接生成 SQL；确实无法可靠回答时说明原因";
        if(attempt<2) continue;
        return refusedAfterFailure(`模型认为需要进一步探索（${clipReason(planned.needsExploration)}），但当前模式不支持 Agent 探索`,null);
      }
      const policy={...(planned.policy||{allowedTables:context.tables.map((table)=>table.tableName),allowedColumns:context.allowedColumns,columnKinds:context.columnKinds,allowedRelations:context.relations,maxRows:config.queryMaxRows,enums:context.enums}),valueKinds:context.valueKinds};
      const querySpecs=plannedQuerySpecs(planned);
      const guarded=querySpecs.length>5
        ?[{name:"查询集合",sql:plannedSqlText(planned),verdict:{ok:false,reason:"一次最多允许 5 个独立查询"}}]
        :querySpecs.map((item)=>{
          const verdict=guardSql(item.sql,policy);
          const contractExecution={usedTables:verdict.tables||[],retrieval:context.retrieval,verdict,columnsByTable:context.columns,semanticContract:planned.semanticContract||null};
          const intentError=verdict.ok?queryIntentFilterError(question,verdict.sql,context.queryIntent,contractExecution):null;
          const contractValidation=verdict.ok&&!intentError?queryResultContractValidation(context.queryIntent,verdict.sql,contractExecution):null;
          const contractError=contractValidation&&!contractValidation.ok?contractValidation.errors?.[0]:null;
          const rejectedVerdict=intentError
            ?{...verdict,ok:false,code:intentError.code,reason:intentError.message,details:intentError.details}
            :contractError
              ?{...verdict,ok:false,code:contractError.code||"INTENT_RESULT_CONTRACT_MISMATCH",reason:contractError.message||"SQL 未满足查询结果契约",details:contractError.details}
              :verdict;
          return {...item,contractValidation,verdict:rejectedVerdict};
        });
      const rejected=guarded.find((item)=>!item.verdict.ok);
      const usedTables=guarded.flatMap((item)=>item.verdict.tables||[]);
      const missingSubjectFacets=rejected?[]:missingIntentSubjectFacets(context.queryIntent,context.retrieval,usedTables);
      const missingAccountScopes=rejected||missingSubjectFacets.length?[]:missingExhaustiveAccountTables(question,context,usedTables);
      const missingProductColumns=rejected||missingSubjectFacets.length||missingAccountScopes.length?[]:missingExhaustiveAccountProductColumns(question,context,guarded.map((item)=>({sql:item.verdict.sql,tables:item.verdict.tables||[]})));
      if(rejected||missingSubjectFacets.length||missingAccountScopes.length||missingProductColumns.length) {
        const guardReason=missingSubjectFacets.length
          ?`当前查询集合没有覆盖用户要求的业务对象分面：${missingSubjectFacets.join("、")}。必须补齐对应对象查询后再执行`
          :missingAccountScopes.length
          ?`问题要求查询所有账号，但当前查询遗漏账号主表：${missingAccountScopes.join("、")}。必须覆盖全部账号体系后再执行`
          :missingProductColumns.length?`问题要求查询所有账号，但当前结果没有返回产品维度：${missingProductColumns.join("、")}。必须保留产品标识且不能缩小为单一产品`
          :querySpecs.length>1?`${rejected.name}：${rejected.verdict.reason}`:rejected.verdict.reason;
        errorFeedback=planningMode==="semantic"?"确定性 SQL 未通过安全护栏，请重新检查语义属性、过滤和聚合定义":guardReason;
        if(agentMode==="prefer"&&!agentTried) {
          const terminal=await tryAgent();if(terminal)return terminal;
          errorFeedback=`${guardReason}；Agent 探索未收敛：${agentFallbackReason||"未知原因"}`;continue;
        }
        if(planningMode==="semantic"&&semanticMode==="prefer") {
          semanticFallbackReason=`确定性 SQL 未通过安全护栏：${guardReason}`;planningMode="legacy";errorFeedback="";
          if(!context.tables.length) return refusedAfterFailure(`语义 Query Plan 失败，且没有足够的结构上下文可安全回退：${semanticFallbackReason}`,plannedSqlText(planned));
          attempt-=1;continue;
        }
        if(attempt<2) continue;
        return refusedAfterFailure(guardReason,plannedSqlText(planned));
      }
      try {
        const runs=[];
        for(const item of guarded) {
          const queryStarted=Date.now();
          const explain=await connector.explain(source,item.verdict.sql,signal);
          const scannedRows=explain.reduce((sum,row)=>sum+Number(row.rows||0),0);
          if(scannedRows>config.explainMaxRows) throw new Error(`${item.name}：EXPLAIN 预计扫描 ${scannedRows} 行，超过阈值 ${config.explainMaxRows}`);
          const [rows,fields]=await connector.query(source,item.verdict.sql,[],signal);
          runs.push({name:item.name,sql:item.verdict.sql,rows:rows.map(normalizeQueryRow),fields,verdict:item.verdict,contractValidation:item.contractValidation,scannedRows,durationMs:Date.now()-queryStarted});
        }
        const runSetValidation=validateQueryRunSet(buildQueryResultContract(context.queryIntent,context.retrieval,planned.semanticContract||null),runs);
        if(!runSetValidation.ok)throw new Error(runSetValidation.errors[0]?.message||"查询集合未覆盖完整业务范围");
        const combined=combineQueryRuns(runs);
        if(context.queryIntent?.scope?.exhaustive&&!combined.completeness.complete)return refusedAfterFailure(combined.completeness.reason,combined.sql);
        if(!combined.rows.length&&runs.length===1&&planned.planningMode==="semantic"&&planned.plan) {
          // 零行反思探针只形成诊断证据。COUNT 命中不能证明兄弟字段与已发布
          // 属性语义等价，因此绝不能据此改列或转入 legacy 再执行明细查询。
          const findings=await probeZeroResult({plan:planned.plan,schema:semanticRuntime.published.schema,catalog:semanticRuntime.catalog,connector,source,signal,explainMaxRows:config.explainMaxRows});
          throwIfAborted(signal);
          if(findings.length) {
            zeroResultProbe={findings,probedAt:"semantic",purpose:"diagnostic_only",authorizesRebinding:false};
          }
        }
        let conclusion;
        const analyticalConclusion=deterministicAnalyticalConclusion(context.queryIntent,combined.rows.length,combined.resultSets.length);
        if(!combined.rows.length) conclusion={conclusion:zeroResultProbe?`未查询到符合条件的数据。注意：${zeroResultProbe.findings.map((item)=>`同表字段 ${item.siblingColumn} 中有 ${item.matchCount} 行包含“${item.value}”`).join("；")}，当前过滤字段可能与业务口径不符。`:'未查询到符合条件的数据。'};
        else if(analyticalConclusion) conclusion={conclusion:analyticalConclusion};
        else {
          try { const summary=await summarize(config.llm,question,combined.sql,combined.rows,config.queryLlmTimeoutMs||90_000,signal,config.prompts?.resultSummary);mergeTokenUsage(tokenUsage,summary.__usage);delete summary.__usage;conclusion=ensureSummaryConsistency(summary,combined.rows.length); }
          catch(error) { if(signal?.aborted)throw error;conclusion={conclusion:`查询已完成，共返回 ${combined.rows.length} 行符合条件的结果。`}; }
        }
        const answer={id:`query-${Date.now()}`,sessionId:session.id,question,conclusion:conclusion.conclusion||"查询已完成。",delta:conclusion.delta||undefined,columns:combined.columns,rows:combined.rows,resultSets:combined.resultSets,chart:runs.length===1?inferChart(runs[0].rows,runs[0].fields):null,evidence:{pages:context.knowledge.map((page)=>page.title),rules:context.rules.map((rule)=>rule.name),tables:combined.tables,joins:combined.joins,sql:combined.sql,sqls:combined.sqls,durationMs:Date.now()-started,scannedRows:combined.scannedRows,coverage:planned.planningMode==="semantic"?"semantic":context.retrieval.coverage,retrievalMode:context.retrieval.retrievalMode||"lexical",planningMode:planned.planningMode,ontologySchemaVersion:planned.ontologySchemaVersion,queryPlan:planned.plan,semanticPath:planned.semanticPath,semanticFallbackReason:planned.planningMode==="legacy"?semanticFallbackReason||undefined:undefined,agentFallbackReason:agentFallbackReason||undefined,zeroResultProbe:zeroResultProbe||undefined,planningAttempts:plannerCalls,tokenUsage:{...tokenUsage},queryIntent:context.queryIntent,resultContract:{...buildQueryResultContract(context.queryIntent,context.retrieval,planned.semanticContract||null),validations:runs.map((run)=>run.contractValidation)},agentRollout,resultCompleteness:combined.completeness}};
        store.addAudit({userName,sourceId,question,retrievedPages:JSON.stringify(answer.evidence.pages),promptHash:hash(JSON.stringify(planned.plan||context)),sql:combined.sql,verdict:"passed",durationMs:answer.evidence.durationMs,rowCount:combined.rows.length,planningAttempts:plannerCalls,...auditContext,...auditPlanningFields(planned,semanticFallbackReason)});
        store.updateSession(session.id,nextSessionContext(session.context,combined.tables,context.knowledge.map((page)=>page.slug),context.queryIntent));
        return answer;
      } catch(error) {
        if(signal?.aborted) throw error;
        const executionFailure=failureMessage(error);
        errorFeedback=planningMode==="semantic"?"确定性 SQL 未通过执行前检查，请在不改变业务口径的前提下简化语义计划":executionFailure;
        if(agentMode==="prefer"&&!agentTried) {
          const terminal=await tryAgent();if(terminal)return terminal;
          errorFeedback=`${executionFailure}；Agent 探索未收敛：${agentFallbackReason||"未知原因"}`;continue;
        }
        if(planningMode==="semantic"&&semanticMode==="prefer"&&attempt<2) {
          semanticFallbackReason=`语义 SQL 执行前校验或查询失败：${executionFailure}`;planningMode="legacy";errorFeedback="";
          if(!context.tables.length) return refusedAfterFailure(`语义 Query Plan 失败，且没有足够的结构上下文可安全回退：${semanticFallbackReason}`,plannedSqlText(planned));
          continue;
        }
        if(attempt<2) continue;
        return refusedAfterFailure(executionFailure,plannedSqlText(planned));
      }
    }

    async function refusedAfterFailure(reason,sql) { if(agentMode==="prefer"&&!agentTried){const terminal=await tryAgent();if(terminal)return terminal;}const safeSql=sql?redactTypedLiterals(sql):null;const failureClass=failureClassFor({stage:"guard",message:reason,code:/LIMIT/.test(reason)?"RESULT_INCOMPLETE":undefined});store.addAudit({userName,sourceId,question,retrievedPages:JSON.stringify(context.knowledge.map((page)=>page.title)),sql:safeSql,verdict:"failed",failReason:reason,durationMs:Date.now()-started,rowCount:0,planningAttempts:plannerCalls,failureClass,...auditContext,...auditPlanningFields(lastPlanned||{planningMode},semanticFallbackReason)}); return {refused:true,reason:`系统没有执行不可靠 SQL：${reason}`,failureClass,attemptedSql:safeSql||undefined,sessionId:session.id,planningMode,planningAttempts:plannerCalls}; }
  }

  function finalizeAgentOutcome({outcome,source,session,userName,question,context,started,agentMode,agentRollout}) {
    const clarificationCount=Array.isArray(outcome.clarifications)?outcome.clarifications.length:0;
    const resolvedIntent=outcome.queryIntent||context.queryIntent;
    const retrievalSnapshot=agentRetrievalSnapshot(outcome,context);
    const evidenceSelection=agentEvidenceSelection(store,source.id,outcome,context);
    const auditContext=auditContextFields({...context,queryIntent:resolvedIntent},agentRollout,retrievalSnapshot);
    if(outcome.status==="clarification") {
      invalidatePendingSession(session.id);
      const pendingId=randomUUID();const ttl=Number(config.queryAgentPendingTtlMs)>0?Number(config.queryAgentPendingTtlMs):10*60_000;const expiresAt=Date.now()+ttl;
      const auditId=store.addAudit({userName,sourceId:source.id,question,retrievedPages:JSON.stringify(evidenceSelection.pages.map((page)=>page.title)),verdict:"clarified",durationMs:outcome.durationMs??Date.now()-started,rowCount:0,planningMode:"agent",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount:1,toolTraceJson:JSON.stringify(outcome.toolTrace||[]),...auditContext});
      const response={clarification:{pendingId,question:outcome.clarification.question,options:outcome.clarification.options,allowFreeText:outcome.clarification.allowFreeText,expiresAt:new Date(expiresAt).toISOString()},sessionId:session.id,planningMode:"agent",planningAttempts:outcome.iterations,toolTrace:outcome.toolTrace,tokenUsage:outcome.tokenUsage};
      pendingLoops.set(pendingId,{id:pendingId,sourceId:source.id,sessionId:session.id,userName,question,context,started,agentMode,agentRollout,resume:outcome.resume,expiresAt,publicState:{question,response}});pendingBySession.set(session.id,pendingId);
      return {...response,_auditId:auditId,_sessionQuestion:question};
    }
    if(outcome.status==="answered") {
      const runs=Array.isArray(outcome.runs)&&outcome.runs.length?outcome.runs:[outcome.run].filter(Boolean);
      const combined=combineQueryRuns(runs);
      if(resolvedIntent?.scope?.exhaustive&&!combined.completeness.complete) {
        const reason=combined.completeness.reason||"结果未完整返回";
        const auditId=store.addAudit({userName,sourceId:source.id,question,retrievedPages:JSON.stringify(evidenceSelection.pages.map((page)=>page.title)),sql:combined.sql,verdict:"failed",failReason:reason,durationMs:outcome.durationMs??Date.now()-started,rowCount:combined.rows.length,planningMode:"agent",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount,toolTraceJson:JSON.stringify(outcome.toolTrace),failureClass:"result_incomplete",...auditContext});
        return {refused:true,reason:`系统没有把可能被 LIMIT 截断的结果当作完整答案：${reason}`,failureClass:"result_incomplete",sessionId:session.id,planningMode:"agent",planningAttempts:outcome.iterations,toolTrace:outcome.toolTrace,_auditId:auditId,_sessionQuestion:question};
      }
      const semanticRuns=runs.filter((run)=>run.semanticPlan);
      const semanticPlan=semanticRuns.length===runs.length&&semanticRuns.every((run)=>run.semanticPlan?.ontologySchemaVersion===semanticRuns[0]?.semanticPlan?.ontologySchemaVersion)?semanticRuns[0]?.semanticPlan:null;
      const pageSlugs=new Set(evidenceSelection.pages.map((page)=>page.slug));const pages=evidenceSelection.pages;
      const rules=evidenceSelection.rules;
      const resultContract=outcome.resultContract||buildQueryResultContract(resolvedIntent,retrievalSnapshot.retrievalEvidence,semanticPlan?.semanticContract||null);
      const validatedResultContract={...resultContract,validations:runs.map((run)=>run.contractValidation)};
      const resultContractFingerprint=hash(JSON.stringify(validatedResultContract));
      const answeredAuditContext=auditContextFields({...context,queryIntent:resolvedIntent},agentRollout,{...retrievalSnapshot,resultContract:validatedResultContract,resultContractFingerprint});
      const analyticalConclusion=deterministicAnalyticalConclusion(resolvedIntent,combined.rows.length,combined.resultSets.length);
      const answer={id:`query-${Date.now()}`,sessionId:session.id,question,conclusion:analyticalConclusion||outcome.conclusion||'查询已完成。',delta:analyticalConclusion?undefined:outcome.delta||undefined,columns:combined.columns,rows:combined.rows,resultSets:combined.resultSets,chart:runs.length===1?inferChart(runs[0].rows,runs[0].fields):null,evidence:{pages:pages.map((page)=>page.title),rules:rules.map((rule)=>rule.name),tables:combined.tables,joins:combined.joins,sql:combined.sql,sqls:combined.sqls,durationMs:outcome.durationMs??Date.now()-started,scannedRows:combined.scannedRows,coverage:semanticPlan?'semantic':retrievalSnapshot.latestRetrieval?.coverage||'none',retrievalMode:retrievalSnapshot.latestRetrieval?.retrievalMode||'lexical',planningMode:'agent',planningAttempts:outcome.iterations,iterations:outcome.iterations,toolTrace:outcome.toolTrace,stateTransitions:outcome.stateTransitions,budgetFallback:outcome.budgetFallback||undefined,resultDelivery:runs.some((run)=>run.resultDelivery==='direct')?'direct':'preview',clarifications:outcome.clarifications||[],tokenUsage:outcome.tokenUsage,queryPlan:runs.length===1?semanticPlan?.plan:undefined,semanticPath:runs.length===1?semanticPlan?.semanticPath:undefined,ontologySchemaVersion:semanticPlan?.ontologySchemaVersion,queryIntent:resolvedIntent,resultContract:validatedResultContract,resultContractFingerprint,agentRollout,resultCompleteness:combined.completeness}};
      const auditId=store.addAudit({userName,sourceId:source.id,question,retrievedPages:JSON.stringify(answer.evidence.pages),promptHash:hash(JSON.stringify(context)),sql:combined.sql,verdict:"passed",durationMs:answer.evidence.durationMs,rowCount:combined.rows.length,planningMode:"agent",queryPlanJson:runs.length===1&&semanticPlan?.plan?JSON.stringify(semanticPlan.plan):null,ontologySchemaVersion:semanticPlan?.ontologySchemaVersion||null,semanticPathJson:runs.length===1&&semanticPlan?.semanticPath?JSON.stringify(semanticPlan.semanticPath):null,planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount,toolTraceJson:JSON.stringify(outcome.toolTrace),...answeredAuditContext});
      store.updateSession(session.id,nextSessionContext(session.context,combined.tables,[...pageSlugs],resolvedIntent));return {...answer,_auditId:auditId,_sessionQuestion:question};
    }
    if(outcome.status==="refused") {
      const auditId=store.addAudit({userName,sourceId:source.id,question,retrievedPages:JSON.stringify(evidenceSelection.pages.map((page)=>page.title)),verdict:"refused",failReason:outcome.reason,durationMs:outcome.durationMs??Date.now()-started,rowCount:0,planningMode:"agent",planningAttempts:outcome.iterations,iterations:outcome.iterations,clarificationCount,toolTraceJson:JSON.stringify(outcome.toolTrace),failureClass:outcome.failureClass||"policy_block",...auditContext});
      return {refused:true,reason:outcome.reason,failureClass:outcome.failureClass||"policy_block",...(outcome.errorCode?{errorCode:outcome.errorCode}:{}),...(outcome.missingFacets?.length?{missingFacets:[...outcome.missingFacets]}:{}),sessionId:session.id,planningMode:"agent",planningAttempts:outcome.iterations,toolTrace:outcome.toolTrace,clarifications:outcome.clarifications||[],_auditId:auditId,_sessionQuestion:question};
    }
    return null;
  }

  async function resumePending({pendingId,source,session,userName,answer,signal,onEvent}) {
    const pending=pendingLoops.get(pendingId);
    if(!pending)throw httpError(404,"待澄清的 Agent Loop 不存在或已失效");
    if(pending.expiresAt<=Date.now()){deletePending(pending);throw httpError(410,"待澄清的 Agent Loop 已过期，请重新提问");}
    if(pending.sourceId!==source.id||pending.sessionId!==session.id||pending.userName!==userName)throw httpError(403,"不能恢复其他用户、会话或数据源的 Agent Loop");
    deletePending(pending);
    let outcome;
    try{outcome=await pending.resume(answer,{signal,onEvent});}catch(error){if(signal?.aborted)throw error;const snapshot=error?.queryAgentSnapshot&&typeof error.queryAgentSnapshot==="object"?error.queryAgentSnapshot:{};outcome={...snapshot,status:"failed",reason:`Agent Loop 恢复失败：${failureMessage(error)}`,iterations:snapshot.iterations||0,toolTrace:snapshot.toolTrace||[],clarifications:snapshot.clarifications||[],durationMs:snapshot.durationMs??Date.now()-pending.started};}
    const terminal=finalizeAgentOutcome({outcome,source,session,userName,question:pending.question,context:pending.context,started:pending.started,agentMode:pending.agentMode,agentRollout:pending.agentRollout});if(terminal)return terminal;
    const reason=outcome.reason||"Agent Loop 恢复后未在剩余预算内收敛";
    const retrievalSnapshot=agentRetrievalSnapshot(outcome,pending.context);
    const evidenceSelection=agentEvidenceSelection(store,source.id,outcome,pending.context);
    const auditId=store.addAudit({userName,sourceId:source.id,question:pending.question,retrievedPages:JSON.stringify(evidenceSelection.pages.map((page)=>page.title)),verdict:"failed",failReason:reason,durationMs:outcome.durationMs??Date.now()-pending.started,rowCount:0,planningMode:"agent",planningAttempts:outcome.iterations||0,iterations:outcome.iterations||0,clarificationCount:1,toolTraceJson:JSON.stringify(outcome.toolTrace||[]),failureClass:outcome.failureClass||"execution_error",...auditContextFields({...pending.context,queryIntent:outcome.queryIntent||pending.context.queryIntent},pending.agentRollout,retrievalSnapshot)});
    return {refused:true,reason:`系统没有执行不可靠 SQL：${reason}`,failureClass:outcome.failureClass||"execution_error",sessionId:session.id,planningMode:"agent",planningAttempts:outcome.iterations||0,toolTrace:outcome.toolTrace||[],_auditId:auditId,_sessionQuestion:pending.question};
  }

  function sweepExpiredPending(){const now=Date.now();for(const pending of pendingLoops.values())if(pending.expiresAt<=now)deletePending(pending);}
  function invalidatePendingSession(sessionId){const id=pendingBySession.get(sessionId);if(id){const pending=pendingLoops.get(id);if(pending)deletePending(pending);else pendingBySession.delete(sessionId);}}
  function deletePending(pending){pendingLoops.delete(pending.id);if(pendingBySession.get(pending.sessionId)===pending.id)pendingBySession.delete(pending.sessionId);}
  function discardPending({pendingId,sourceId,sessionId,userName}){const pending=pendingLoops.get(pendingId);if(!pending)return false;if(pending.sourceId!==sourceId||pending.sessionId!==sessionId||pending.userName!==userName)return false;deletePending(pending);return true;}
  function getPendingClarification({sessionId,userName}){sweepExpiredPending();const id=pendingBySession.get(sessionId);if(!id)return null;const pending=pendingLoops.get(id);if(!pending||pending.userName!==userName)return null;return pending.publicState||null;}
  return {ask,discardPending,getPendingClarification};
}

function buildSemanticRuntime(store,sourceId,ontologySchemaVersionId) {
  const published=ontologySchemaVersionId?store.getOntologySchemaVersion(Number(ontologySchemaVersionId)):store.getPublishedOntologySchema(sourceId);
  if(!published?.schema) return {ok:false,reason:ontologySchemaVersionId?"指定的 Ontology Schema 版本不存在":"当前数据源没有已发布的 Ontology Schema"};
  if(published.sourceId!==sourceId) return {ok:false,reason:"指定的 Ontology Schema 版本不属于当前数据源"};
  const tables=store.listTables(sourceId);
  const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));
  const relations=store.listRelations(sourceId,false,true);
  const enums={};
  for(const table of tables) for(const item of store.listEnums(sourceId,table.tableName)) {if(item.value==="null")continue;(enums[`${table.tableName}.${item.columnName}`]??=[]).push(item.value);}
  const termAnchors=store.listTermAnchors?.()||[];
  const catalog={tables,columnsByTable,relations,enums,termAnchors};
  const validation=validateSemanticSchema(published.schema,catalog);
  if(!validation.ok) return {ok:false,reason:`已发布 Ontology Schema v${published.version} 与当前物理结构不兼容：${validation.errors[0]?.message||"校验失败"}`,published,catalog,validation};
  return {ok:true,published:{...published,schema:validation.schema},catalog,validation};
}

async function buildContext(store,sourceId,question,priorContext={},deps={}) {
  const allTables=store.listTables(sourceId).filter((table)=>table.grade!=="C"&&table.active);
  const rawColumns=Object.fromEntries(allTables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));
  const columnSemantics=buildQueryColumnSemantics(rawColumns);
  const allColumns=rawColumns;
  const allRelations=store.listRelations(sourceId,true);
  const storedKnowledge=store.listKnowledge(sourceId);
  const allRules=store.listRules(sourceId);
  const generatedRulePages=allRules.filter((rule)=>rule.verified).map((rule)=>({pageType:"rule",slug:`global-rule-${rule.id}`,title:rule.name,aliases:[],tables:String(rule.appliesTo||"").split(/[,，]/).map((item)=>item.trim()).filter(Boolean),content:"已验证的全局表级业务规则",sqlContent:rule.content,antiExamples:"",verified:true,owner:"verified_rule",ruleId:rule.id,activationPolicy:"global_table"}));
  const knowledgePages=[...new Map([...storedKnowledge,...generatedRulePages].map((page)=>[`${page.pageType}:${page.slug}`,page])).values()];
  const intentConcepts=knowledgeIntentConcepts(knowledgePages,allColumns);
  const contextualQuestion=contextualRetrievalQuestion(question,deps.conversationHistory||[]);
  const followUp=contextualQuestion!==String(question||"").trim();
  const trustedPriorTables=[...new Set([...(priorContext.tableNames||[]),...(priorContext.recentTableNames||[])])].filter((tableName)=>allTables.some((table)=>table.tableName===tableName));
  const termAliases=boundTermAliases(store,sourceId);
  const termAnchors=store.listTermAnchors?.()||[];
  const ontologyRecord=deps.ontologySchemaVersionId?store.getOntologySchemaVersion(Number(deps.ontologySchemaVersionId)):store.getPublishedOntologySchema(sourceId);
  const ontologySchema=ontologyRecord?.sourceId===sourceId?ontologyRecord.schema:null;
  const enumItemsByColumn={};
  for(const table of allTables)for(const item of store.listEnums(sourceId,table.tableName))if(item.value!=="null")(enumItemsByColumn[`${table.tableName}.${item.columnName}`]??=[]).push(item);
  let filterConcepts=catalogFilterConcepts(allTables,allColumns,ontologySchema,termAnchors);
  if(followUp&&trustedPriorTables.length)filterConcepts=contextualizeFilterConcepts(filterConcepts,trustedPriorTables);
  const rowDomainConcepts=knowledgeIntentRowDomains(knowledgePages,allColumns);
  const parseOptions={concepts:intentConcepts,filterConcepts,rowDomainConcepts:rowDomainConcepts.filter((item)=>item.activationPolicy!=="global_table"),protectedTermAliases:knowledgePages.filter((page)=>page.verified&&new Set(["term","rule"]).has(page.pageType)&&page.activationPolicy!=="global_table").flatMap((page)=>[page.title,...(page.aliases||[])]).filter(Boolean)};
  // Conversation history broadens retrieval recall, but it must not silently
  // become a hard constraint in the current turn's immutable intent contract.
  const currentIntent=parseQueryIntent(question,parseOptions);
  // Only a previously persisted, successfully audited intent may become a hard
  // contract. Free-form legacy conversation text remains retrieval recall and
  // must never be promoted into immutable subjects/products/filters.
  const historicalIntent=priorContext.queryIntent||null;
  let queryIntent=followUp&&historicalIntent?mergeContextualQueryIntent(currentIntent,historicalIntent):currentIntent;
  let retrievalQuestion=buildIntentRetrievalQuestion(queryIntent,contextualQuestion);
  let vector=await buildRetrievalVector(sourceId,retrievalQuestion,deps);
  let retrieval=retrieveKnowledge({question:retrievalQuestion,pages:knowledgePages,tables:allTables,columnsByTable:allColumns,relations:allRelations,vector,conceptAliases:deps.retrieval?.conceptAliases||[],termAliases,intent:queryIntent,ontologySchema,enumItemsByColumn});
  const globalConceptCount=rowDomainConcepts.filter((item)=>item.activationPolicy==="global_table").length;
  let globalRulesStable=globalConceptCount===0;
  for(let iteration=0;iteration<=globalConceptCount;iteration++) {
    const withGlobalRules=applyGlobalRowDomainRules(queryIntent,rowDomainConcepts,requiredExecutionTables(retrieval),{subjectExecutionTables:requiredSubjectExecutionTables(retrieval)});
    if(intentContractFingerprint(withGlobalRules)===intentContractFingerprint(queryIntent)) {globalRulesStable=true;break;}
    queryIntent=withGlobalRules;retrievalQuestion=buildIntentRetrievalQuestion(queryIntent,contextualQuestion);vector=await buildRetrievalVector(sourceId,retrievalQuestion,deps);
    retrieval=retrieveKnowledge({question:retrievalQuestion,pages:knowledgePages,tables:allTables,columnsByTable:allColumns,relations:allRelations,vector,conceptAliases:deps.retrieval?.conceptAliases||[],termAliases,intent:queryIntent,ontologySchema,enumItemsByColumn});
  }
  if(!globalRulesStable) {
    queryIntent=structuredClone(queryIntent);
    queryIntent.ambiguities=[...(queryIntent.ambiguities||[]),{code:"GLOBAL_RULE_SET_UNSTABLE",message:"全局表级规则在执行闭包中未达到稳定集合，系统不会在规则可能遗漏时执行查询",blocking:true,options:["检查规则 appliesTo 与已确认关系路径"]}];
  }
  queryIntent=withRetrievalBindingAmbiguities(queryIntent,retrieval);
  const priorTables=trustedPriorTables;
  if(followUp&&priorTables.length)retrieval={...retrieval,tableNames:[...new Set([...priorTables,...retrieval.tableNames])].slice(0,12),contextual:true};
  if(retrieval.coverage==="none"&&priorTables.length) retrieval={version:retrieval.version,pages:knowledgePages.filter((page)=>(priorContext.pageSlugs||priorContext.recentPageSlugs||[]).includes(page.slug)),tableNames:priorTables.slice(0,12),coverage:"session",retrievalMode:retrieval.retrievalMode,contextual:followUp};
  const selected=new Set(retrieval.tableNames);
  const tables=allTables.filter((table)=>selected.has(table.tableName));
  const columns=Object.fromEntries(tables.map((table)=>[table.tableName,allColumns[table.tableName]]));
  const enums={};
  for(const [key,items] of Object.entries(enumItemsByColumn))if(selected.has(key.split(".")[0]))enums[key]={mode:"observed",values:items.map((item)=>item.value),items:items.map((item)=>({value:item.value,meaning:item.meaning??null,meaningSource:item.meaningSource??null}))};
  const relations=allRelations.filter((relation)=>selected.has(relation.fromTable)&&selected.has(relation.toTable));
  const rules=allRules.filter((rule)=>!rule.appliesTo||String(rule.appliesTo).split(/[,，]/).some((table)=>selected.has(table.trim())));
  const allowedColumns=Object.fromEntries(tables.map((table)=>[table.tableName,columns[table.tableName].map((column)=>column.columnName)]));
  const scopedKeys=new Set(tables.map((table)=>table.tableName));
  const columnKinds=Object.fromEntries(Object.entries(columnSemantics.columnKinds).filter(([key])=>scopedKeys.has(key.split(".")[0])));
  return {tables,columns,allowedColumns,columnKinds,valueKinds:detectQuestionValueKinds(contextualQuestion),enums,enumItemsByColumn,relations,rules,knowledge:retrieval.pages,retrieval,termAliases,queryIntent,retrievalQuestion,ontologySchema};
}

function requiredExecutionTables(retrieval) {
  return [...new Set((retrieval?.diagnostics?.facets||[]).filter((facet)=>facet.required).flatMap((facet)=>[
    ...(facet.executionTables||[]),...(facet.bindingTables||[]),...(facet.paths||[]).flat(),
  ]).map((item)=>String(item).toLowerCase()).filter(Boolean))];
}

// Conflict detection follows the same closed-world boundary as execution.
// Retrieval recall pages are deliberately broader than the current query and
// must not veto it merely because vector/lexical recall selected them. A page
// becomes conflict-authoritative only when a required facet actually used it
// as authoritative evidence (or the immutable intent explicitly activated it),
// and the referenced physical table belongs to that query's required closure.
function scopedKnowledgeOntologyConflicts(context,semanticRuntime) {
  if(!semanticRuntime?.ok)return [];
  const facets=(context?.retrieval?.diagnostics?.facets||[]).filter((facet)=>facet.required);
  const executionClosure=new Set(requiredExecutionTables(context?.retrieval));
  if(!executionClosure.size)return [];
  const pages=context?.knowledge||[];
  const pagesByKey=new Map(pages.map((page)=>[knowledgePageKey(page),page]));
  const activePageKeys=new Set();
  for(const requirement of context?.queryIntent?.requirements||[]) {
    if(requirement?.required===false)continue;
    const key=requirement?.evidence?.page||requirement?.provenance?.page;
    if(key)activePageKeys.add(String(key));
  }
  for(const facet of facets) {
    const facetClosure=new Set([...(facet.executionTables||[]),...(facet.bindingTables||[]),...(facet.paths||[]).flat()].map((item)=>String(item).toLowerCase()));
    for(const key of facet.authoritativePageKeys||[]) {
      const page=pagesByKey.get(String(key));
      if(page&&(page.tables||[]).some((table)=>facetClosure.has(String(table).toLowerCase())))activePageKeys.add(String(key));
    }
  }
  const activePages=pages.filter((page)=>activePageKeys.has(knowledgePageKey(page))&&(page.tables||[]).some((table)=>executionClosure.has(String(table).toLowerCase())));
  const conflicts=findKnowledgeOntologyMappingConflicts(activePages,semanticRuntime.catalog?.columnsByTable||{},semanticRuntime.published.schema);
  return conflicts.filter((item)=>executionClosure.has(String(item.table).toLowerCase()));
}

function knowledgePageKey(page) {return `${page?.pageType||"asset"}:${page?.slug||""}`;}

function requiredSubjectExecutionTables(retrieval) {return [...new Set((retrieval?.diagnostics?.facets||[]).filter((facet)=>facet.required&&facet.kind==="subject").flatMap((facet)=>facet.executionTables||[]).map((item)=>String(item).toLowerCase()).filter(Boolean))];}

function contextualizeFilterConcepts(concepts,priorTables) {
  const allowed=new Set((priorTables||[]).map((item)=>String(item).toLowerCase()));
  return (concepts||[]).map((concept)=>{const scoped=(concept.physicalColumns||[]).filter((column)=>allowed.has(String(column).toLowerCase().split(".")[0]));return scoped.length?{...concept,physicalColumns:scoped,provenance:[...new Set([...(concept.provenance||[]),"audited_session_table"])]}:concept;});
}

function intentContractFingerprint(intent) {
  return JSON.stringify({filters:(intent?.filters||[]).map((item)=>[item.id,item.field,item.operator,item.valueType,item.value,item.attachesTo,item.physicalColumns]),ambiguities:(intent?.ambiguities||[]).map((item)=>[item.code,item.field,item.sourceText])});
}

function withRetrievalBindingAmbiguities(intent,retrieval) {
  const next=structuredClone(intent);const facets=retrieval?.diagnostics?.facets||[];const bindings=[];
  for(const requirement of (next.requirements||[]).filter((item)=>item.kind==="filter")) {
    const facet=facets.find((item)=>item.key===requirement.id);
    if(!facet?.covered||!(facet.filterBindings||[]).length)next.ambiguities.push({
      code:"FILTER_VALUE_BINDING_UNKNOWN",field:requirement.field||null,sourceText:requirement.surfaceText,
      message:`筛选“${requirement.surfaceText||requirement.value}”无法在当前业务对象上同时证明唯一物理字段与值映射`,blocking:true,
      options:["发布该属性的物理映射","确认并登记枚举值含义","改用数据库中已存在的精确值"],
    });
    else for(const binding of facet.filterBindings)bindings.push({...binding,requirementId:requirement.id,surfaceText:requirement.surfaceText});
  }
  const byColumn=new Map();for(const binding of bindings){const list=byColumn.get(binding.column)||[];list.push(binding);byColumn.set(binding.column,list);}
  for(const [column,items] of byColumn) {
    if(!filterConstraintsSatisfiable(items))next.ambiguities.push({code:"FILTER_CONTRACT_CONFLICT",field:column,sourceText:items.map((item)=>item.surfaceText).join("、"),message:`多个已声明筛选在 ${column} 上互相冲突，继续执行只会得到恒假或口径不明的结果`,blocking:true,options:["统一业务术语与显式筛选","修订冲突的全局规则"],details:{constraints:items.map((item)=>({operator:item.operator,valueType:item.valueType,value:item.value,evidence:item.evidence||null}))}});
  }
  next.ambiguities=[...new Map(next.ambiguities.map((item)=>[`${item.code}|${item.field||""}|${item.sourceText||""}`,item])).values()];
  return next;
}

function filterConstraintsSatisfiable(items=[]) {
  const constraints=items.map((item)=>({...item,operator:normalizeConstraintOperator(item.operator),valueType:String(item.valueType||"").toLowerCase(),normalizedValue:normalizedConstraintValue(item)}));
  const nulls=constraints.filter((item)=>item.operator==="is_null");const nonNulls=constraints.filter((item)=>item.operator!=="is_null");
  if(nulls.length&&nonNulls.length)return false;
  if(constraints.some((item)=>item.operator==="is_null")&&constraints.some((item)=>item.operator==="not_null"))return false;
  const equals=constraints.filter((item)=>item.operator==="eq");
  if(new Set(equals.map((item)=>`${item.valueType}|${item.normalizedValue}`)).size>1)return false;
  const equal=equals[0];
  if(equal)for(const item of constraints) {
    if(item.operator==="neq"&&constraintValuesEqual(equal,item))return false;
    if(equal.valueType==="number"&&new Set(["gt","gte","lt","lte"]).has(item.operator)) {
      const comparison=compareCanonicalDecimals(equal.normalizedValue,item.normalizedValue);if(comparison==null)return false;
      if(item.operator==="gt"&&comparison<=0||item.operator==="gte"&&comparison<0||item.operator==="lt"&&comparison>=0||item.operator==="lte"&&comparison>0)return false;
    }
    if(item.operator==="contains"&&(equal.valueType!=="string"||!String(equal.normalizedValue).includes(String(item.normalizedValue))))return false;
  }
  const numeric=constraints.filter((item)=>item.valueType==="number"&&new Set(["gt","gte","lt","lte"]).has(item.operator));
  let lower=null;let upper=null;
  for(const item of numeric) {
    if(new Set(["gt","gte"]).has(item.operator)) {
      const comparison=lower?compareCanonicalDecimals(item.normalizedValue,lower.normalizedValue):1;
      if(!lower||comparison>0||comparison===0&&item.operator==="gt")lower=item;
    } else {
      const comparison=upper?compareCanonicalDecimals(item.normalizedValue,upper.normalizedValue):-1;
      if(!upper||comparison<0||comparison===0&&item.operator==="lt")upper=item;
    }
  }
  if(lower&&upper) {const comparison=compareCanonicalDecimals(lower.normalizedValue,upper.normalizedValue);if(comparison>0||comparison===0&&(lower.operator==="gt"||upper.operator==="lt"))return false;}
  return true;
}

function normalizeConstraintOperator(value) {return ({"=":"eq","==":"eq","!=":"neq","<>":"neq",">":"gt",">=":"gte","<":"lt","<=":"lte","is":"is_null","is not":"not_null"})[String(value||"").toLowerCase()]||String(value||"").toLowerCase();}
function normalizedConstraintValue(item) {return String(item?.valueType||"").toLowerCase()==="number"?(canonicalDecimal(item?.value)??String(item?.value)):String(item?.value??"");}
function constraintValuesEqual(left,right) {return left.valueType===right.valueType&&left.normalizedValue===right.normalizedValue;}
function canonicalDecimal(value) {
  const match=String(value??"").trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);if(!match)return null;
  const integer=String(match[2]||"0").replace(/^0+(?=\d)/,"")||"0";const fraction=String(match[3]??match[4]??"").replace(/0+$/,"");const sign=match[1]==="-"&&!(integer==="0"&&!fraction)?"-":"";
  return `${sign}${integer}${fraction?`.${fraction}`:""}`;
}
function compareCanonicalDecimals(left,right) {
  const a=canonicalDecimal(left);const b=canonicalDecimal(right);if(a==null||b==null)return null;if(a===b)return 0;
  const negativeA=a.startsWith("-");const negativeB=b.startsWith("-");if(negativeA!==negativeB)return negativeA?-1:1;
  const parts=(value)=>value.replace(/^-/,"").split(".");const [ai,af=""]=parts(a);const [bi,bf=""]=parts(b);let comparison=ai.length-bi.length||ai.localeCompare(bi);if(!comparison){const width=Math.max(af.length,bf.length);comparison=af.padEnd(width,"0").localeCompare(bf.padEnd(width,"0"));}return negativeA?-Math.sign(comparison):Math.sign(comparison);
}

function boundTermAliases(store,sourceId) {
  const schema=store.getPublishedOntologySchema(sourceId)?.schema;
  const anchors=store.listTermAnchors?.()||[];
  if(!schema||!anchors.length)return [];
  const byKey=new Map(anchors.map((anchor)=>[`${anchor.vocabulary}\u0000${anchor.canonicalId}`,anchor]));
  const result=[];
  const add=(entity)=>{
    const binding=entity?.termBinding;if(!binding)return;
    const anchor=byKey.get(`${binding.vocabulary}\u0000${binding.canonicalId}`);if(!anchor)return;
    result.push({aliases:[anchor.prefLabelZh,anchor.prefLabelEn,...(anchor.altLabels||[])].filter(Boolean),terms:[entity.displayName,entity.apiName].filter(Boolean)});
  };
  for(const object of schema.objectTypes||[]){add(object);for(const property of object.properties||[])add(property);}
  return result;
}

async function buildRetrievalVector(sourceId,question,{embeddingIndex,retrieval}={}) {
  if(!embeddingIndex?.enabled?.()) return null;
  try {
    const vectors=embeddingIndex.loadVectors(sourceId);
    if(!vectors) return null;
    const queryVector=await embeddingIndex.embedQuestion(question);
    if(!queryVector) return null;
    return {queryVector,pageVectors:vectors.pageVectors,tableVectors:vectors.tableVectors,vectorWeight:retrieval?.vectorWeight,minSimilarity:retrieval?.minSimilarity,semanticThreshold:retrieval?.semanticThreshold};
  } catch { return null; }
}

async function planSql(llm,question,context,conversationHistory,errorFeedback,timeoutMs,signal,canExplore=false,template=QUERY_PROMPT_DEFAULTS.legacySqlPlanner) {
  const schema=context.tables.map((table)=>`TABLE ${table.tableName} (${context.columns[table.tableName].map((column)=>{const key=`${table.tableName}.${column.columnName}`;const note=[column.comment,context.columnKinds?.[key]?`字段语义 ${context.columnKinds[key]}`:null].filter(Boolean).join("；");return `${column.columnName} ${column.dataType}${note?` /* ${note} */`:""}`;}).join(", ")})`).join("\n");
  const relations=context.relations.map((r)=>`${r.fromTable}.${r.fromCol} = ${r.toTable}.${r.toCol}`).join("\n");
  const rules=context.rules.map((r)=>`${r.name}: ${r.content}`).join("\n");
  const knowledge=context.knowledge.map((page)=>`[${page.pageType}] ${page.title}\n定义: ${page.content||""}\nSQL: ${page.sqlContent||""}\n反例: ${page.antiExamples||""}`).join("\n\n");
  const contract=canExplore
    ?`能可靠直接回答时返回 JSON：单个结果集用 {"sql":"单条 SELECT"}；需要分别覆盖多个独立产品、账号体系或业务范围时用 {"queries":[{"name":"业务范围","sql":"单条 SELECT"}]}，最多 5 个查询。如果必须继续检索口径、查看更多结构或采样取值才能避免猜测，返回 {"needsExploration":"具体原因"}，不得给出猜测 SQL。`
    :`只返回 JSON：单个结果集用 {"sql":"单条 SELECT"}；需要分别覆盖多个独立产品、账号体系或业务范围时用 {"queries":[{"name":"业务范围","sql":"单条 SELECT"}]}，最多 5 个查询。`;
  const prompt=renderQueryPrompt(template||QUERY_PROMPT_DEFAULTS.legacySqlPlanner,{
    contract,
    conversationHistory:formatConversationHistory(conversationHistory),
    knowledge:knowledge||"仅命中结构信息",
    schema,
    relations:relations||"无",
    rules:rules||"无",
    question,
    queryIntent:JSON.stringify(context.queryIntent||parseQueryIntent(question)),
    errorFeedback:errorFeedback?`上一次失败:${errorFeedback}\n修复查询集合，覆盖范围和业务口径不得缩小。`:"",
  });
  return callLlmJson(llm,[{role:"system",content:"输出严格 JSON，不要 Markdown。"},{role:"user",content:prompt}],llmOptions(llm,timeoutMs,1800,signal));
}

function semanticIntentView(intent) {
  return {
    version:intent?.version||null,
    subjects:[...(intent?.subjects||[])],
    entities:(intent?.entities||[]).map(({type,text,sourceText,immutable})=>({type,text,sourceText,immutable})),
    filters:(intent?.filters||[]).map(({kind,operator,value,immutable,sourceText})=>({kind,operator,value,immutable,sourceText})),
    timeRange:intent?.timeRange||null,
    comparisonRange:intent?.comparisonRange||null,
    timeRole:intent?.timeRole?{value:intent.timeRole.value,sourceText:intent.timeRole.sourceText,attachesTo:intent.timeRole.attachesTo}:null,
    shape:intent?.shape||null,
    dimensions:(intent?.dimensions||[]).map(({id,value,sourceText,role,attribution,presentation})=>({id,value,sourceText,role,attribution,presentation})),
    measures:(intent?.measures||[]).map(({id,value,sourceText,role,aggregation,grain,timeRole})=>({id,value,sourceText,role,aggregation,grain,timeRole})),
    scope:intent?.scope||null,
    ambiguities:intent?.ambiguities||[],
    requirements:(intent?.requirements||[]).map(({id,kind,value,role,surfaceText,required,aggregation,grain,presentation,range,attachesTo,attribution})=>({id,kind,value,role,surfaceText,required,aggregation,grain,presentation,range,attachesTo,attribution})),
  };
}

async function planSemanticQuery(llm,question,schema,catalog,context,conversationHistory,errorFeedback,timeoutMs,signal,template=QUERY_PROMPT_DEFAULTS.semanticPlanner) {
  const ontology=semanticPlanningView(schema,catalog);
  const knowledge=context.knowledge.map((page)=>({type:page.pageType,title:page.title,definition:page.content||"",antiExamples:page.antiExamples||""}));
  const ruleNames=context.rules.map((rule)=>rule.name);
  const prompt=renderQueryPrompt(template||QUERY_PROMPT_DEFAULTS.semanticPlanner,{
    conversationHistory:formatConversationHistory(conversationHistory),
    ontology:JSON.stringify(ontology),
    knowledge:JSON.stringify(knowledge),
    ruleNames:JSON.stringify(ruleNames),
    question,
    queryIntent:JSON.stringify(semanticIntentView(context.queryIntent||parseQueryIntent(question))),
    errorFeedback:errorFeedback?`上一次计划未通过：${errorFeedback}\n请只修正语义计划。`:"",
  });
  return callLlmJson(llm,[{role:"system",content:"只输出严格 JSON。不要输出 SQL、Markdown 或解释。"},{role:"user",content:prompt}],llmOptions(llm,timeoutMs,2200,signal));
}

async function summarize(llm,question,sql,rows,timeoutMs,signal,template=QUERY_PROMPT_DEFAULTS.resultSummary) {
  const prompt=renderQueryPrompt(template||QUERY_PROMPT_DEFAULTS.resultSummary,{
    question,
    sql,
    rowCount:rows.length,
    rows:JSON.stringify(rows.slice(0,100).map(normalizeQueryRow)),
  });
  return callLlmJson(llm,[{role:"system",content:"输出严格 JSON，不要 Markdown。"},{role:"user",content:prompt}],llmOptions(llm,timeoutMs,800,signal));
}

function llmOptions(llm,timeoutMs,maxTokens,signal) { const extraBody={max_tokens:maxTokens};if(/dashscope|\.maas\.aliyuncs\.com/i.test(llm.baseUrl))extraBody.enable_thinking=false;return {timeoutMs,extraBody,signal}; }
function formatConversationHistory(history) { return history?.length?history.map((item)=>`${item.role==="user"?"用户":"助手"}：${String(item.content).slice(0,500)}`).join("\n"):"无"; }
function contextualRetrievalQuestion(question,history=[]) {
  const current=String(question||"").trim();
  if(!isContextualFollowUp(current))return current;
  const priorUsers=history.filter((item)=>item?.role==="user").slice(-2).map((item)=>String(item.content||"").trim()).filter(Boolean);
  return [...priorUsers,current].join("\n");
}
function isContextualFollowUp(question) {
  const text=String(question||"").trim();if(!text||[...text].length>48)return false;
  return /^(?:那|这个|那个|它|他|她|其|刚才|上面|前面|继续|还有|再加上|并且|同时(?:满足)?|还要|也要|不对|不是|应该|我是说)|(?:是|不是|指的是|说的是|改成|才对).{0,20}(?:呀|啊|呢|哦|嘛)?[？?。！!]*$|(?:呢|吗|呀|啊|哦|嘛)[？?。！!]*$/.test(text);
}
function nextSessionContext(previous={},tableNames=[],pageSlugs=[],queryIntent=null) {
  const tables=[...new Set((tableNames||[]).map(String).filter(Boolean))];const pages=[...new Set((pageSlugs||[]).map(String).filter(Boolean))];
  const safeIntent=queryIntent?sessionSafeIntent(queryIntent):previous.queryIntent?sessionSafeIntent(previous.queryIntent):null;
  return {tableNames:tables,pageSlugs:pages,recentTableNames:[...new Set([...tables,...(previous.recentTableNames||[]),...(previous.tableNames||[])])].slice(0,12),recentPageSlugs:[...new Set([...pages,...(previous.recentPageSlugs||[]),...(previous.pageSlugs||[])])].slice(0,20),...(safeIntent?{queryIntent:safeIntent}:{})};
}

// Session context is an executable structural contract, not a transcript or a
// prompt cache.  Keep the resolved slots required for deterministic follow-up
// merging, but discard raw utterances, parser spans and derived retrieval text.
// Literal filter/entity values remain because dropping them would silently
// widen a contextual follow-up; access to the session is already user-scoped.
function sessionSafeIntent(intent) {
  if(!intent||typeof intent!=="object")return null;
  const textArray=(values)=>[...new Set((values||[]).map((value)=>String(value)).filter(Boolean))];
  const evidence=(value)=>value&&typeof value==="object"?pickDefined(value,["level","page","assetId","assetKind","activationPolicy","ruleId","checksum","owner","activation","kind","sources"]):null;
  const predicate=(value)=>pickDefined(value,["column","operator","valueType","value"]);
  const aggregate=(value)=>value&&typeof value==="object"?{
    ...pickDefined(value,["aggregation","distinct","predicateBinding"]),
    columns:textArray(value.columns),predicates:(value.predicates||[]).map(predicate),
  }:null;
  const metricDefinition=(value)=>value&&typeof value==="object"?{
    ...pickDefined(value,["aggregation","source","rowCount"]),columns:textArray(value.columns),tables:textArray(value.tables),
    ...(value.formula?{formula:{numerator:aggregate(value.formula.numerator),denominator:aggregate(value.formula.denominator)}}:{}),
  }:null;
  const range=(value,fallback)=>value&&typeof value==="object"?{...pickDefined(value,["kind","start","endExclusive"]),sourceText:String(value.kind||fallback)}:null;
  const dimensions=(intent.dimensions||[]).map((item)=>({...pickDefined(item,["id","value","role","attribution","presentation"]),sourceText:String(item.value||item.id||"dimension"),terms:textArray(item.terms),labelTerms:textArray(item.labelTerms)}));
  const measures=(intent.measures||[]).map((item)=>({...pickDefined(item,["id","value","role","aggregation","grain","timeRole"]),sourceText:String(item.value||item.id||"measure"),terms:textArray(item.terms),evidence:evidence(item.evidence),metricDefinition:metricDefinition(item.metricDefinition)}));
  return {
    version:String(intent.version||""),timeZone:String(intent.timeZone||""),subjects:textArray(intent.subjects),
    entities:(intent.entities||[]).map((item)=>pickDefined(item,["type","text","immutable"])),
    filters:(intent.filters||[]).map((item)=>({...pickDefined(item,["id","requirementId","kind","field","fieldSurface","operator","value","valueType","attachesTo","immutable","valueBinding"]),fieldTerms:textArray(item.fieldTerms),physicalColumns:textArray(item.physicalColumns),scopeTables:textArray(item.scopeTables),provenance:evidence(item.provenance)})),
    timeRange:range(intent.timeRange,"time"),comparisonRange:range(intent.comparisonRange,"comparison"),
    timeRole:intent.timeRole?{...pickDefined(intent.timeRole,["value","attachesTo"]),sourceText:String(intent.timeRole.value||"time"),terms:textArray(intent.timeRole.terms)}:null,
    shape:pickDefined(intent.shape||{},["kind","direction","requestedLimit","timeGrain","comparisonMode"]),dimensions,measures,
    scope:pickDefined(intent.scope||{},["exhaustive","exhaustiveExplicit","products","productExplicit","includeDeleted","deletionMode","deletionExplicit","deletionTargets"]),
    ambiguities:[],
  };
}
function pickDefined(value,keys) {const result={};for(const key of keys)if(value?.[key]!==undefined)result[key]=structuredClone(value[key]);return result;}
function failureMessage(error) { return String(error?.message||error).replace(/(password|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]").slice(0,1000); }
function clipReason(value) { const text=String(value??"").trim();return text.length>200?`${text.slice(0,200)}…`:text; }
function semanticFailureFeedback(error) { if(error instanceof SemanticQueryPlanError&&error.details?.length)return `Query Plan 校验失败：${error.details.slice(0,5).map((item)=>item.message).join("；")}`;if(error instanceof SemanticQueryPlanError)return `Query Plan 未通过确定性编译（${error.code}），请检查对象、属性和关系路径`;return `Query Plan 模型失败：${failureMessage(error)}`; }
function isCorrectableSemanticPlanError(error) { return error instanceof SemanticQueryPlanError&&error.code==="QUERY_PLAN_VALIDATION_FAILED"; }
function normalizeSemanticMode(value) { return ["off","prefer","required"].includes(value)?value:"off"; }
function normalizeAgentMode(value) { return ["off","prefer","required"].includes(value)?value:"off"; }
function rankingLimitPreflight(intent,maxRows) {
  if(intent?.shape?.kind!=="ranking")return null;
  if(intent.shape.requestedLimitInvalid)return {code:"INTENT_RANKING_LIMIT_INVALID",reason:`排行数量“${intent.shape.requestedLimitInvalid}”不是有效的正整数，请补充有效的 Top 数量。`};
  const requested=Number(intent.shape.requestedLimit);const maximum=Number(maxRows);
  if(Number.isSafeInteger(requested)&&requested>0&&Number.isFinite(maximum)&&requested>maximum)return {code:"INTENT_RANKING_LIMIT_EXCEEDS_MAX",reason:`用户要求 Top ${requested}，超过单次查询安全上限 ${maximum}；系统不会静默截断为较小排行。`};
  return null;
}
function semanticQuestionMatches(question,schema) { const input=String(question||"").toLowerCase();return (schema?.objectTypes||[]).some((object)=>[object.apiName,object.displayName,...(object.properties||[]).flatMap((property)=>[property.apiName,property.displayName])].some((term)=>String(term||"").length>1&&input.includes(String(term).toLowerCase()))); }
function auditPlanningFields(planned,semanticFallbackReason) { return {planningMode:planned?.planningMode||null,queryPlanJson:planned?.plan?JSON.stringify(planned.plan):null,ontologySchemaVersion:planned?.ontologySchemaVersion||null,semanticPathJson:planned?.semanticPath?JSON.stringify(planned.semanticPath):null,semanticFallbackReason:semanticFallbackReason||null}; }

function ensureSummaryConsistency(summary,rowCount) { const conclusion=String(summary?.conclusion||'').trim();if(!conclusion||rowCount>0&&/(?:未|没有)(?:查询|查找|找到)|无符合|(?:不|未)包含|不存在|无数据|没有数据|无法确认|不能确认|无法判断/.test(conclusion))return {conclusion:`查询已完成，共返回 ${rowCount} 行符合条件的结果。`};return summary; }
function deterministicAnalyticalConclusion(intent,rowCount,resultSetCount=1) {
  const kind=intent?.shape?.kind;
  const labels={aggregate:['统计','具体指标值'],ranking:['排行','具体排名与指标值'],trend:['趋势','具体时间点与指标值'],comparison:['对比','具体对比周期与指标值']};
  const label=labels[kind];if(!label)return null;
  const rows=Math.max(0,Number.isFinite(Number(rowCount))?Math.trunc(Number(rowCount)):0);
  if(rows===0)return '未查询到符合条件的数据。';
  const sets=Math.max(0,Number.isFinite(Number(resultSetCount))?Math.trunc(Number(resultSetCount)):0);
  const returned=sets>1?`${sets} 个结果集、${rows} 行结果`:`${rows} 行结果`;
  return `${label[0]}查询已完成，共返回 ${returned}；${label[1]}以结果表为准。`;
}
function inferChart(rows,fields) { if(!rows.length)return null;const keys=fields.map((field)=>field.name);const isIdentifier=(key)=>/(^id$|_id$|^id_|identifier|编号|编码|code$)/i.test(key);if(keys.some(isIdentifier))return null;const numeric=keys.filter((key)=>typeof rows[0]?.[key]==='number');const yKey=numeric.find((key)=>/count|amount|total|rate|ratio|percent|qty|quantity|sum|avg|value|score|price|revenue|cost|duration|number|balance/i.test(key));if(!yKey)return null;const xKey=keys.find((key)=>key!==yKey&&/date|time|month|day|year|name|type|channel|category/i.test(key))||keys.find((key)=>key!==yKey);if(!xKey)return null;const type=/date|time|month|day|year/i.test(xKey)?'line':'bar';if(type==='bar'&&rows.length>24)return null;return {type,xKey,yKey}; }
function plannedQuerySpecs(planned={}) {
  if(Array.isArray(planned.queries)&&planned.queries.length)return planned.queries.map((item,index)=>({name:queryRunName(item?.name,index),sql:typeof item?.sql==="string"?item.sql:""}));
  return [{name:"查询结果",sql:typeof planned.sql==="string"?planned.sql:""}];
}
function plannedSqlText(planned={}) {
  const specs=plannedQuerySpecs(planned);
  return specs.length===1?specs[0].sql:specs.map((item,index)=>`-- [${index+1}] ${item.name}\n${item.sql}`).join("\n\n");
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
function hash(value){return createHash("sha256").update(value).digest("hex");}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
function throwIfAborted(signal){if(signal?.aborted){const error=new Error("查询已取消");error.name="AbortError";error.code="ABORT_ERR";throw error;}}
function mergeTokenUsage(target,usage){if(!usage||!Number.isFinite(Number(usage.totalTokens)))return;target.promptTokens+=Number(usage.promptTokens||0);target.completionTokens+=Number(usage.completionTokens||0);target.totalTokens+=Number(usage.totalTokens||0);target.available=true;}
function agentRetrievalSnapshot(outcome={},context={}) {
  const retrievalEvidence=Array.isArray(outcome?.retrievalEvidence)?outcome.retrievalEvidence.filter(Boolean):[context?.retrieval].filter(Boolean);
  return {retrievalEvidence,latestRetrieval:retrievalEvidence.at(-1)||null,resultContract:outcome?.resultContract||null,resultContractFingerprint:outcome?.resultContractFingerprint||null};
}
function agentEvidenceSelection(store,sourceId,outcome={},context={}) {
  const pageSlugs=new Set(Array.isArray(outcome?.exploredPageSlugs)?outcome.exploredPageSlugs:(context.knowledge||[]).map((page)=>page.slug));
  const ruleNames=new Set(Array.isArray(outcome?.exploredRuleNames)?outcome.exploredRuleNames:(context.rules||[]).map((rule)=>rule.name));
  return {pages:store.listKnowledge(sourceId).filter((page)=>pageSlugs.has(page.slug)),rules:store.listRules(sourceId).filter((rule)=>ruleNames.has(rule.name))};
}
// Sanitized gap descriptors for the refusal card: business words only (intent surface text
// and facet kinds), never physical table or column names.
function refusalMissingAssets(intent,missingFacetKeys=[]) {
  const assets=[];
  const seen=new Set();
  const push=(kind,label)=>{const text=String(label||"").trim();if(!text)return;const key=`${kind}|${text}`;if(seen.has(key))return;seen.add(key);assets.push({kind,label:text});};
  for(const ambiguity of intent?.ambiguities||[]) {
    if(!ambiguity?.blocking)continue;
    if(ambiguity.code==="MEASURE_DEFINITION_REQUIRED"||ambiguity.code==="METRIC_AMBIGUOUS")push("metric",ambiguity.sourceText);
  }
  const requirements=new Map((intent?.requirements||[]).map((item)=>[item.id,item]));
  for(const key of missingFacetKeys) {
    const requirement=requirements.get(key);
    const kind=requirement?.kind||String(key).split(":")[0]||"facet";
    push(kind==="measure"?"metric":kind,requirement?.surfaceText||requirement?.value||String(key).split(":").slice(1).join(":"));
  }
  return assets;
}

function auditContextFields(context={},agentRollout=null,snapshot=null) {
  const hasSnapshot=Boolean(snapshot&&Array.isArray(snapshot.retrievalEvidence));
  const retrievals=hasSnapshot?snapshot.retrievalEvidence.filter(Boolean):[context.retrieval].filter(Boolean);
  const latest=retrievals.at(-1)||null;
  if(!latest&&!hasSnapshot)return {intentVersion:context.queryIntent?.version||null,intentJson:context.queryIntent?JSON.stringify(context.queryIntent):null,promptVersion:QUERY_PROMPT_VERSION,retrievalTraceJson:null};
  const resultContract=snapshot?.resultContract||buildQueryResultContract(context.queryIntent,retrievals);
  const resultContractFingerprint=snapshot?.resultContractFingerprint||hash(JSON.stringify(resultContract));
  return {
    intentVersion:context.queryIntent?.version||null,
    intentJson:context.queryIntent?JSON.stringify(context.queryIntent):null,
    promptVersion:QUERY_PROMPT_VERSION,
    retrievalTraceJson:JSON.stringify({
      version:latest?.version||null,
      coverage:latest?.coverage||"none",
      retrievalMode:latest?.retrievalMode||null,
      coverageContract:latest?.coverageContract||null,
      evidenceCount:retrievals.length,
      resultContract,
      resultContractFingerprint,
      selectedTables:[...new Set(retrievals.flatMap((retrieval)=>retrieval.tableNames||[]))],
      selectedPages:[...new Set(retrievals.flatMap((retrieval)=>(retrieval.pages||[]).map((page)=>`${page.pageType}:${page.slug}`)))],
      candidates:latest?.diagnostics||{},
      agentRollout,
    }),
  };
}

function selectQueryAgentRollout({mode,trafficPercent=100,cohortKey="",explicit=false}) {
  const configuredMode=normalizeAgentMode(mode);const percent=Math.max(0,Math.min(100,Number.isFinite(Number(trafficPercent))?Math.round(Number(trafficPercent)):100));
  if(explicit||configuredMode!=="prefer")return {configuredMode,effectiveMode:configuredMode,trafficPercent:configuredMode==="prefer"?100:percent,bucket:null,reason:explicit?"explicit_override":"mode_not_sampled"};
  const bucket=createHash("sha256").update(String(cohortKey)).digest().readUInt32BE(0)%100;
  return {configuredMode,effectiveMode:bucket<percent?"prefer":"off",trafficPercent:percent,bucket,reason:bucket<percent?"in_cohort":"out_of_cohort"};
}

export const _internal={buildContext,buildSemanticRuntime,planSql,planSemanticQuery,summarize,llmOptions,ensureSummaryConsistency,deterministicAnalyticalConclusion,inferChart,semanticQuestionMatches,normalizeAgentMode,rankingLimitPreflight,selectQueryAgentRollout,contextualRetrievalQuestion,isContextualFollowUp,nextSessionContext,sessionSafeIntent,plannedQuerySpecs,combineQueryRuns,missingExhaustiveAccountTables,scopedKnowledgeOntologyConflicts,refusalMissingAssets};
