import { createHash } from "node:crypto";
import { callLlmTools, isProtocolFormatError } from "./llm-client.mjs";
import { retrieveKnowledge } from "./knowledge-retrieval.mjs";
import { compileSemanticQueryPlan, semanticPlanningView } from "./semantic-query-plan.mjs";
import { guardSql } from "./sql-guard.mjs";
import { buildQueryColumnSemantics, columnSemanticKind, detectQuestionValueKinds, redactTypedLiterals } from "./query-column-semantics.mjs";
import { normalizeQueryRow } from "./query-result-normalization.mjs";
import { exhaustiveAccountTables, missingExhaustiveAccountProductColumns, missingExhaustiveAccountTables, missingIntentSubjectFacets, missingRequiredRetrievalFacets, queryIntentFilterError, queryResultContractValidation } from "./query-scope-coverage.mjs";
import { applyIntentClarification, buildIntentRetrievalQuestion, describeIntentFacets, parseQueryIntent } from "./query-intent.mjs";
import { buildQueryResultContract, validateQueryRunSet } from "./query-result-contract.mjs";
import { dominantFailureClass, toolFailure } from "./query-errors.mjs";
import { QUERY_PROMPT_DEFAULTS, renderQueryPrompt } from "./query-prompts.mjs";

export const QUERY_AGENT_TOOLS=[
  {
    name:"search_context",
    description:"按业务关键词检索知识页、术语、指标、规则及相关表。遇到口径或表选择不确定时先调用。",
    inputSchema:{type:"object",properties:{query:{type:"string",description:"业务关键词或待消歧问题"}},required:["query"],additionalProperties:false},
  },
  {
    name:"get_schema",
    description:"查看指定白名单表的字段元数据、字段语义、枚举和已确认关系。最多一次查看 8 张表。",
    inputSchema:{type:"object",properties:{tables:{type:"array",items:{type:"string"},maxItems:8}},required:["tables"],additionalProperties:false},
  },
  {
    name:"resolve_entity",
    description:"把用户原句中的机构等实体绑定到候选业务字段。返回 Harness 固化的连续实体值与候选列，不查询或改写实体值；随后仍需 get_schema 才能执行。",
    inputSchema:{type:"object",properties:{entity:{type:"string"},entityType:{type:"string",enum:["organization"]}},required:["entity"],additionalProperties:false},
  },
  {
    name:"sample_data",
    description:"从一张已查看结构的表中采样指定列，用于确认值格式或枚举含义。最多 20 行，不可作为最终答案 SQL。",
    inputSchema:{type:"object",properties:{table:{type:"string"},columns:{type:"array",items:{type:"string"},minItems:1,maxItems:10},limit:{type:"integer",minimum:1,maximum:20}},required:["table","columns"],additionalProperties:false},
  },
  {
    name:"validate_semantic_plan",
    description:"仅在提供了发布语义模型时使用。校验对象/属性级 Query Plan，并由 Harness 确定性编译为受限只读 SQL。",
    inputSchema:{type:"object",properties:{plan:{type:"object",properties:{rootObject:{type:"string"},dimensions:{type:"array"},metrics:{type:"array"},filters:{type:"array"},timeDimension:{type:["object","null"]},orderBy:{type:"array"},limit:{type:"integer"}},required:["rootObject"],additionalProperties:true}},required:["plan"],additionalProperties:false},
  },
  {
    name:"run_sql",
    description:"执行一个业务范围的一条只读 SELECT。Harness 会强制执行字段白名单、值与字段语义、JOIN、枚举、LIMIT 和 EXPLAIN 护栏；跨产品完整查询可分别调用多次。",
    inputSchema:{type:"object",properties:{name:{type:"string",description:"该结果集的业务范围名称，例如 Alpha 账号"},sql:{type:"string"}},required:["sql"],additionalProperties:false},
  },
  {
    name:"ask_user",
    description:"仅当先探索后仍存在会实质改变结果且没有合理默认的业务口径歧义时，向用户澄清一次。不得询问 SQL、表名或字段名。",
    inputSchema:{type:"object",properties:{question:{type:"string"},options:{type:"array",items:{type:"string"},maxItems:5},allowFreeText:{type:"boolean"}},required:["question"],additionalProperties:false},
  },
  {
    name:"submit_answer",
    description:"使用本轮成功 run_sql 的 SQL 提交最终结论。单结果用 sql；多个产品或范围必须用 sqls 一并提交，且每项都要与成功调用完全对应。",
    inputSchema:{type:"object",properties:{sql:{type:"string"},sqls:{type:"array",items:{type:"string"},minItems:1,maxItems:5},conclusion:{type:"string"},delta:{type:"string"}},required:["conclusion"],additionalProperties:false},
  },
  {
    name:"refuse",
    description:"只有在现有知识与安全工具仍无法可靠回答时拒答，并给出业务可理解的原因。",
    inputSchema:{type:"object",properties:{reason:{type:"string"}},required:["reason"],additionalProperties:false},
  },
];

export async function runQueryAgent({store,connector,config,source,question,context,conversationHistory=[],embeddingIndex,semanticRuntime,signal,onEvent}) {
  const started=Date.now();
  const maxIterations=boundedInteger(config.queryAgentMaxIterations,8,2,20);
  const maxSqlCalls=boundedInteger(config.queryAgentMaxSqlCalls,5,1,10);
  const timeoutMs=boundedInteger(config.queryLlmTimeoutMs,90_000,1,600_000);
  let deadline=started+timeoutMs;
  let activeSignal=signal;let activeOnEvent=onEvent;
  const catalog=buildCatalog(store,source.id,config.queryMaxRows||500,question,context.ontologySchema);
  let queryIntent=context.queryIntent||parseQueryIntent(question);
  if(Array.isArray(context.valueKinds)&&context.valueKinds.length)catalog.policy.valueKinds=context.valueKinds;
  const maxScannedRows=boundedInteger(config.queryAgentMaxScannedRows,Math.max(Number(config.explainMaxRows||1_000_000),1)*maxSqlCalls,1,Number.MAX_SAFE_INTEGER);
  const initialTables=new Set(context.tables.map((table)=>table.tableName).filter((table)=>catalog.tableByName.has(table)));
  const disclosedTables=new Set([...initialTables].map(normalizeIdentifier));
  const exploredPageSlugs=new Set(context.knowledge.map((page)=>page.slug));
  const exploredRuleNames=new Set(context.rules.map((rule)=>rule.name));
  const successfulRuns=[];
  const retrievalEvidence=[context.retrieval].filter(Boolean);
  const validatedSemanticPlans=new Map();
  const toolTrace=[];
  const actionHistory=new Map();
  const stateTransitions=[];
  const messages=[
    {role:"system",content:agentSystemPrompt({maxIterations,maxSqlCalls,maxScannedRows},config.prompts?.agentSystem)},
    {role:"user",content:agentQuestionPrompt(question,context,conversationHistory,semanticRuntime,config.prompts?.agentQuestion)},
  ];
  let runSqlCalls=0;
  let sampleDataCalls=0;
  let askUserCalls=0;
  let explorationCalls=0;
  let scannedRowsTotal=0;
  let forcedTerminal=false;
  let consecutiveProtocolErrors=0;
  let consecutiveRepeatedActions=0;
  let searchContextSucceeded=false;
  let currentPhase="UNDERSTAND";
  const clarifications=[];
  const tokenUsage={promptTokens:0,completionTokens:0,totalTokens:0,available:false};

  const intentClarification=blockingIntentClarification(queryIntent);
  if(intentClarification)return pauseForIntentClarification(intentClarification);
  const intentFailure=unresolvableBlockingIntent(queryIntent);
  return intentFailure?intentFailureOutcome(intentFailure):continueLoop(0);

  function pauseForIntentClarification(clarification) {
    askUserCalls++;
    const step=toolTrace.length+1;
    const thought="已识别出会改变查询结果的业务口径歧义，需要先由用户确认。";
    const action={tool:"ask_user",args:clarification};
    const result={ok:true,pending:true,question:clarification.question,optionCount:clarification.options.length,allowFreeText:clarification.allowFreeText};
    const phases=phasesForTool(action.tool);
    for(const nextPhase of phases)if(nextPhase!==currentPhase){stateTransitions.push({from:currentPhase,to:nextPhase,step});currentPhase=nextPhase;}
    const trace=makeTrace(action,thought,result,0,currentPhase);
    toolTrace.push(trace);
    emitEvent(activeOnEvent,{type:"step",step,status:"started"});
    emitEvent(activeOnEvent,{type:"thought",step,text:thought});
    emitEvent(activeOnEvent,toolCallEvent(step,action));
    emitEvent(activeOnEvent,{type:"tool_result",step,tool:action.tool,ok:true,summary:trace.summary,durationMs:0});
    emitEvent(activeOnEvent,{type:"step",step,status:"completed",durationMs:0});
    const pausedAt=Date.now();let resumed=false;
    return {
      status:"clarification",clarification,queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:1,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started,
      resume:async(userAnswer,{signal,onEvent}={})=>{
        try {
        if(resumed)throw new Error("该澄清请求已恢复，不能重复使用");resumed=true;
        const answer=requiredText(userAnswer,"澄清回复",500);deadline+=Date.now()-pausedAt;activeSignal=signal;activeOnEvent=onEvent;
        clarifications.push({question:clarification.question,answer});
        const resolution=resolveClarifiedIntent(answer);
        messages.push({role:"assistant",content:JSON.stringify({thought,tool:action.tool,args:action.args})});
        if(!resolution.changed)return unboundClarificationOutcome(clarification,answer);
        const nextClarification=blockingIntentClarification(queryIntent);
        if(nextClarification)return pauseForIntentClarification(nextClarification);
        const intentFailure=unresolvableBlockingIntent(queryIntent);
        if(intentFailure)return intentFailureOutcome(intentFailure);
        const refreshed=await ensureClarifiedIntentEvidence(answer,resolution);
        const evidenceGap=clarifiedEvidenceGapOutcome(refreshed);
        if(evidenceGap)return evidenceGap;
        resetMessagesForClarifiedIntent(answer,resolution,refreshed);
        return await continueLoop(toolTrace.length);
        } catch(error) { throw agentSnapshotError(error); }
      },
    };
  }

  function intentFailureOutcome(ambiguity) {
    return {status:"refused",reason:`当前问题仍缺少可验证的业务口径：${ambiguity.message}。请先补充或发布对应的指标/字段定义后再查询。`,failureClass:"schema_gap",queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:toolTrace.length,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
  }

  function unboundClarificationOutcome(clarification,answer) {
    return {status:"refused",reason:`澄清答复“${clipText(answer,80)}”未能绑定到已发布的指标、枚举、术语或结构化查询口径，系统不会仅凭对话文本改变结果范围。请先发布该口径或改用可验证的筛选条件。`,failureClass:"schema_gap",errorCode:"CLARIFICATION_INTENT_BINDING_REQUIRED",queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:toolTrace.length,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
  }

  function clarifiedEvidenceGapOutcome(refreshed) {
    const gap=clarifiedEvidenceGap(queryIntent,refreshed);
    if(!gap)return null;
    return {status:"refused",...gap,failureClass:"schema_gap",queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:toolTrace.length,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
  }

  function resolveClarifiedIntent(answer) {
    const previousFingerprint=intentEvidenceFingerprint(queryIntent);
    queryIntent=applyIntentClarification(queryIntent,answer);
    const nextFingerprint=intentEvidenceFingerprint(queryIntent);
    const changed=previousFingerprint!==nextFingerprint;
    if(changed) {
      // Retrieval evidence, semantic plans, and successful runs are valid only
      // for the exact immutable intent contract that produced them.
      retrievalEvidence.splice(0,retrievalEvidence.length);
      successfulRuns.splice(0,successfulRuns.length);
      validatedSemanticPlans.clear();
      exploredPageSlugs.clear();
      exploredRuleNames.clear();
      searchContextSucceeded=false;
    }
    return {changed,previousFingerprint,nextFingerprint};
  }

  async function ensureClarifiedIntentEvidence(answer,resolution) {
    if(!resolution.changed&&retrievalEvidence.length)return null;
    const refreshQuery=clipText(`${question} ${answer}`.trim(),200);
    const action={tool:"search_context",args:{query:refreshQuery}};
    const thought=resolution.changed?"业务意图契约已改变，已废弃旧证据并按新口径刷新检索上下文。":"当前没有可复用的检索证据，按已确认口径补充检索上下文。";
    const step=toolTrace.length+1;
    if(currentPhase!=="RETRIEVE"){stateTransitions.push({from:currentPhase,to:"RETRIEVE",step});currentPhase="RETRIEVE";}
    emitEvent(activeOnEvent,{type:"step",step,status:"started"});
    emitEvent(activeOnEvent,{type:"thought",step,text:thought});
    emitEvent(activeOnEvent,toolCallEvent(step,action));
    const refreshStarted=Date.now();let result;
    try {result=await searchContext(action.args);}
    catch(error) {
      throwIfAborted(activeSignal);
      result=toolFailure({stage:"internal",code:"INTENT_EVIDENCE_REFRESH_FAILED",error:safeError(error),retryable:true});
    }
    result=normalizeToolFailure(result);
    searchContextSucceeded=Boolean(result?.ok);
    const trace=makeTrace(action,thought,result,Date.now()-refreshStarted,"RETRIEVE");
    toolTrace.push(trace);
    emitEvent(activeOnEvent,{type:"tool_result",step,tool:action.tool,ok:trace.ok,summary:trace.summary,durationMs:trace.durationMs,...traceDisplay(trace)});
    emitEvent(activeOnEvent,{type:"step",step,status:trace.ok?"completed":"failed",durationMs:trace.durationMs});
    return result;
  }

  function resetMessagesForClarifiedIntent(answer,resolution,refreshed) {
    const retrieval=retrievalEvidence.at(-1)||null;
    const tableNames=new Set(retrieval?.tableNames||[]);
    const promptContext={
      ...context,
      queryIntent,
      retrieval,
      knowledge:retrieval?.pages||[],
      tables:catalog.tables.filter((table)=>tableNames.has(table.tableName)),
      columns:catalog.columnsByTable,
      relations:catalog.relations.filter((relation)=>tableNames.has(relation.fromTable)&&tableNames.has(relation.toTable)),
      rules:catalog.rules.filter((rule)=>exploredRuleNames.has(rule.name)),
    };
    const clarificationResult={ok:true,answer,resolvedIntent:queryIntent,priorEvidenceInvalidated:resolution.changed,evidenceDisposition:clarificationEvidenceDisposition(refreshed),...(refreshed?{refreshedContext:refreshed}:{})};
    messages.splice(0,messages.length,
      {role:"system",content:agentSystemPrompt({maxIterations,maxSqlCalls,maxScannedRows},config.prompts?.agentSystem)},
      {role:"user",content:agentQuestionPrompt(question,promptContext,conversationHistory,semanticRuntime,config.prompts?.agentQuestion)},
      {role:"user",content:`Harness 工具结果（用户已澄清）：${JSON.stringify(clarificationResult)}`},
    );
    disclosedTables.clear();for(const table of promptContext.tables)disclosedTables.add(normalizeIdentifier(table.tableName));
    actionHistory.clear();consecutiveProtocolErrors=0;consecutiveRepeatedActions=0;
  }

  function agentSnapshotError(error) {
    const failure=error instanceof Error?error:new Error(String(error));
    failure.queryAgentSnapshot={queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:toolTrace.length,toolTrace:[...toolTrace],stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
    return failure;
  }

  async function continueLoop(startIndex) {
    for(let index=startIndex;index<maxIterations;index++) {
      throwIfAborted(activeSignal);
      const remaining=deadline-Date.now();
      if(remaining<=0) break;
      if(!forcedTerminal&&(index===maxIterations-1||remaining<=Math.max(1_000,Math.floor(timeoutMs*.15)))) {
        messages.push({role:"user",content:"Harness 预算即将耗尽。下一步必须调用 submit_answer 或 refuse；不得再调用探索、澄清或执行工具。"});
        forcedTerminal=true;
      }
      const step=index+1;
      emitEvent(activeOnEvent,{type:"step",step,status:"started"});
      let action;
      try {
        action=await callLlmTools(config.llm,messages,availableAgentTools({searchContextSucceeded}),toolLlmOptions(config.llm,remaining,activeSignal));
      } catch(error) {
        throwIfAborted(activeSignal);
        // Only format violations (malformed JSON, empty tool name, missing thought) earn one
        // deterministic retry. Requesting an unauthorized tool is a semantic violation and
        // terminates immediately — feeding it back would invite privilege probing.
        if(isProtocolFormatError(error)&&++consecutiveProtocolErrors<2) {
          const reason=safeError(error);
          toolTrace.push({tool:"protocol_retry",phase:currentPhase,thought:"模型返回违反工具协议的格式，已要求按协议重发。",argsHash:hash("{}"),durationMs:0,ok:false,summary:`协议格式违规：${reason}`,reason});
          emitEvent(activeOnEvent,{type:"tool_result",step,tool:"protocol_retry",ok:false,summary:`协议格式违规：${reason}`,durationMs:0});
          emitEvent(activeOnEvent,{type:"step",step,status:"failed"});
          messages.push({role:"user",content:`Harness 协议错误：${reason}。请严格按协议重新返回一个 JSON 动作：{"thought":"...","tool":"...","args":{...}}，不要输出其他文本。`});
          index--; // A format slip must not burn a reasoning iteration; the wall-clock deadline still bounds the loop.
          continue;
        }
        throw error;
      }
      consecutiveProtocolErrors=0;
      mergeTokenUsage(tokenUsage,action.usage);
      throwIfAborted(activeSignal);
      const thought=sanitizeThought(action.thought);
      emitEvent(activeOnEvent,{type:"thought",step,text:thought});
      emitEvent(activeOnEvent,toolCallEvent(step,action));
      const stepStarted=Date.now();
      let result;
      let terminal=null;
      const phases=phasesForTool(action.tool);
      for(const nextPhase of phases)if(nextPhase!==currentPhase){stateTransitions.push({from:currentPhase,to:nextPhase,step});currentPhase=nextPhase;}
      const phase=phases.at(-1)||currentPhase;
      const fingerprint=actionFingerprint(action);
      let repeatedActionLimitReached=false;
      try {
        const previous=actionHistory.get(fingerprint);
        if(previous) {
          consecutiveRepeatedActions++;
          repeatedActionLimitReached=consecutiveRepeatedActions>=2;
          result=toolFailure({stage:repeatedActionLimitReached?"budget":"loop",code:repeatedActionLimitReached?"REPEATED_ACTION_LIMIT":"REPEATED_ACTION",error:repeatedActionLimitReached?`连续重复相同动作，Loop 已触发无进展熔断：${action.tool}`:`相同的 ${action.tool} 动作已经执行过且参数未变化；请根据上次结果修改参数或进入下一阶段`,retryable:!repeatedActionLimitReached,details:{previousStep:previous.step,previousOk:previous.ok,consecutiveRepeats:consecutiveRepeatedActions}});
        }
        else if(forcedTerminal&&!isTerminalTool(action.tool)) result=toolFailure({stage:"budget",code:"BUDGET_TERMINAL_ONLY",error:"Harness 已进入收尾阶段，只允许 submit_answer 或 refuse"});
        else if(action.tool==="search_context") result=await searchContext(action.args);
        else if(action.tool==="get_schema") result=getSchema(action.args);
        else if(action.tool==="resolve_entity") result=resolveEntity(action.args);
        else if(action.tool==="sample_data") result=await sampleData(action.args);
        else if(action.tool==="validate_semantic_plan") result=validateSemanticPlan(action.args);
        else if(action.tool==="run_sql") result=await runSql(action.args);
        else if(action.tool==="ask_user") ({result,terminal}=askUser(action.args));
        else if(action.tool==="submit_answer") ({result,terminal}=submitAnswer(action.args));
        else if(action.tool==="refuse") ({result,terminal}=refuse(action.args));
      } catch(error) {
        result=toolFailure({stage:"internal",code:"INTERNAL_ERROR",error:safeError(error)});
      }
      result=normalizeToolFailure(result);
      if(!repeatedActionLimitReached&&result?.code!=="REPEATED_ACTION")consecutiveRepeatedActions=0;
      if(action.tool==="search_context"&&result?.ok)searchContextSucceeded=true;
      if(!actionHistory.has(fingerprint))actionHistory.set(fingerprint,{step,ok:Boolean(result?.ok),code:result?.code});
      throwIfAborted(activeSignal);
      const trace=makeTrace(action,thought,result,Date.now()-stepStarted,phase);
      toolTrace.push(trace);
      emitEvent(activeOnEvent,{type:"tool_result",step,tool:action.tool,ok:trace.ok,summary:trace.summary,durationMs:trace.durationMs,...traceDisplay(trace)});
      emitEvent(activeOnEvent,{type:"step",step,status:trace.ok?"completed":"failed",durationMs:trace.durationMs});
      if(terminal?.status==="clarification") {
        const pausedAt=Date.now();let resumed=false;
        return {...terminal,queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:index+1,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started,resume:async(userAnswer,{signal,onEvent}={})=>{
          try {
          if(resumed)throw new Error("该澄清请求已恢复，不能重复使用");resumed=true;
          const answer=requiredText(userAnswer,"澄清回复",500);deadline+=Date.now()-pausedAt;activeSignal=signal;activeOnEvent=onEvent;
          clarifications.push({question:terminal.clarification.question,answer});
          const resolution=resolveClarifiedIntent(answer);
          messages.push({role:"assistant",content:JSON.stringify({thought,tool:action.tool,args:action.args})});
          if(!resolution.changed)return unboundClarificationOutcome(terminal.clarification,answer);
          const nextClarification=blockingIntentClarification(queryIntent);
          if(nextClarification)return pauseForIntentClarification(nextClarification);
          const intentFailure=unresolvableBlockingIntent(queryIntent);
          if(intentFailure)return intentFailureOutcome(intentFailure);
          const refreshed=await ensureClarifiedIntentEvidence(answer,resolution);
          const evidenceGap=clarifiedEvidenceGapOutcome(refreshed);
          if(evidenceGap)return evidenceGap;
          resetMessagesForClarifiedIntent(answer,resolution,refreshed);
          return await continueLoop(toolTrace.length);
          } catch(error) { throw agentSnapshotError(error); }
        }};
      }
      if(terminal) return {...terminal,queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],iterations:index+1,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
      messages.push({role:"assistant",content:JSON.stringify({thought,tool:action.tool,args:action.args})});
      messages.push({role:"user",content:`Harness 工具结果（可信 JSON）：${JSON.stringify(result)}`});
      if(repeatedActionLimitReached)break;
    }

    const accountFallbackRuns=completeAccountFallbackRuns(successfulRuns,question,context);
    if(accountFallbackRuns?.length)for(const run of accountFallbackRuns)refreshRunContractValidation(run);
    const fallbackContract=resultContractForRuns(accountFallbackRuns||[]);
    const accountFallbackValidation=accountFallbackRuns?.length?validateQueryRunSet(fallbackContract,accountFallbackRuns):null;
    if(accountFallbackRuns?.length&&accountFallbackValidation?.ok) {
      const rowCount=accountFallbackRuns.reduce((sum,run)=>sum+run.rows.length,0);
      return {
        status:"answered",
        conclusion:`查询已完成，共返回 ${rowCount} 行符合条件的结果。`,
        run:accountFallbackRuns.at(-1),runs:accountFallbackRuns,
        budgetFallback:true,
        queryIntent,
        retrievalEvidence:[...retrievalEvidence],
        exploredRuleNames:[...exploredRuleNames],
        resultContract:fallbackContract,
        resultContractFingerprint:contractFingerprint(fallbackContract),
        iterations:toolTrace.length,
        toolTrace,
        clarifications:[...clarifications],
        tokenUsage:{...tokenUsage},
        exploredPageSlugs:[...exploredPageSlugs],
        durationMs:Date.now()-started,stateTransitions:[...stateTransitions],
      };
    }
    if(accountFallbackRuns) return {status:"exhausted",reason:"Agent Loop 已取得部分账号查询结果，但未能在预算内形成覆盖全部账号主表和产品维度的完整结果",failureClass:"result_incomplete",queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],resultContract:fallbackContract,resultContractFingerprint:contractFingerprint(fallbackContract),iterations:toolTrace.length,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
    const lastRun=successfulRuns.at(-1);
    if(lastRun)refreshRunContractValidation(lastRun);
    const lastRunContract=resultContractForRuns(lastRun?[lastRun]:[]);
    const lastRunMissingSubjects=lastRun?missingIntentSubjectFacets(queryIntent,retrievalEvidence,lastRun.verdict?.tables||[]):[];
    const lastRunSetValidation=lastRun?validateQueryRunSet(lastRunContract,[lastRun]):null;
    if(lastRun&&lastRun.contractValidation?.ok&&lastRunSetValidation?.ok&&!lastRunMissingSubjects.length&&!(queryIntent.scope?.exhaustive&&lastRun.mayBeTruncated)) return {
      status:"answered",
      conclusion:`查询已完成，共返回 ${lastRun.rows.length} 行符合条件的结果。`,
      run:lastRun,runs:[lastRun],
      budgetFallback:true,
      queryIntent,
      retrievalEvidence:[...retrievalEvidence],
      exploredRuleNames:[...exploredRuleNames],
      resultContract:lastRunContract,
      resultContractFingerprint:contractFingerprint(lastRunContract),
      iterations:toolTrace.length,
      toolTrace,
      clarifications:[...clarifications],
      tokenUsage:{...tokenUsage},
      exploredPageSlugs:[...exploredPageSlugs],
      durationMs:Date.now()-started,stateTransitions:[...stateTransitions],
    };
    const incomplete=Boolean(lastRun&&queryIntent.scope?.exhaustive&&lastRun.mayBeTruncated);
    return {status:"exhausted",reason:incomplete?"查询结果达到安全 LIMIT，无法确认已覆盖用户要求的完整范围":"Agent Loop 在预算内没有得到可验证的查询结果",failureClass:incomplete?"result_incomplete":dominantFailureClass(toolTrace,"budget_exhausted"),queryIntent,retrievalEvidence:[...retrievalEvidence],exploredRuleNames:[...exploredRuleNames],resultContract:lastRunContract,resultContractFingerprint:contractFingerprint(lastRunContract),iterations:toolTrace.length,toolTrace,stateTransitions:[...stateTransitions],clarifications:[...clarifications],tokenUsage:{...tokenUsage},exploredPageSlugs:[...exploredPageSlugs],durationMs:Date.now()-started};
  }

  async function searchContext(args) {
    explorationCalls++;
    const query=buildIntentRetrievalQuestion(queryIntent,requiredText(args.query,"query",200));
    const vector=await buildAgentRetrievalVector(query);throwIfAborted(activeSignal);
    const retrieval=retrieveKnowledge({
      question:query,
      pages:catalog.pages,
      tables:catalog.tables,
      columnsByTable:catalog.columnsByTable,
      relations:catalog.relations,
      maxPages:6,
      maxTables:8,
      vector,
      conceptAliases:config.retrieval?.conceptAliases||[],
      termAliases:context.termAliases||[],
      intent:queryIntent,
      ontologySchema:catalog.ontologySchema,
      enumItemsByColumn:catalog.enumItemsByColumn,
    });
    retrievalEvidence.push(retrieval);
    for(const page of retrieval.pages) exploredPageSlugs.add(page.slug);
    const rules=catalog.rules.filter((rule)=>!rule.appliesTo||retrieval.tableNames.some((table)=>String(rule.appliesTo).split(/[,，]/).map((item)=>item.trim()).includes(table)));
    for(const rule of rules)exploredRuleNames.add(rule.name);
    return {
      ok:true,
      retrievalVersion:retrieval.version,
      coverage:retrieval.coverage,
      retrievalMode:retrieval.retrievalMode,
      pages:retrieval.pages.map((page)=>({type:page.pageType,title:page.title,definition:clipText(page.content,2_000),sqlGuidance:clipText(page.sqlContent,1_500),antiExamples:clipText(page.antiExamples,1_000),tables:page.tables||[]})),
      relatedTables:retrieval.tableNames,
      coverageContract:retrieval.coverageContract,
      capabilities:(retrieval.diagnostics?.facets||[]).filter((facet)=>facet.required).map((facet)=>({
        key:facet.key,
        executionTables:(facet.executionTables||[]).slice(0,4),
        executionColumns:(facet.executionColumns||[]).slice(0,12),
        filterBindings:(facet.filterBindings||[]).slice(0,12),
        executionValidityPredicates:(facet.executionValidityPredicates||[]).slice(0,8),
        labelColumns:(facet.labelColumns||[]).slice(0,8),
        bindingTables:(facet.bindingTables||[]).slice(0,4),
        bindingColumns:(facet.bindingColumns||[]).slice(0,8),
        bindingRelationIds:(facet.bindingRelationIds||[]).slice(0,8),
        bindingValidityPredicates:(facet.bindingValidityPredicates||[]).slice(0,8),
        bindingProvenance:facet.bindingProvenance||null,
        paths:(facet.paths||[]).slice(0,4),
      })),
      rules:rules.slice(0,10).map((rule)=>({name:rule.name,content:clipText(rule.content,1_000)})),
    };
  }

  async function buildAgentRetrievalVector(query) {
    if(!embeddingIndex?.enabled?.())return null;
    try { const vectors=embeddingIndex.loadVectors(source.id);if(!vectors)return null;const queryVector=await embeddingIndex.embedQuestion(query);if(!queryVector)return null;return {queryVector,pageVectors:vectors.pageVectors,tableVectors:vectors.tableVectors,vectorWeight:config.retrieval?.vectorWeight,minSimilarity:config.retrieval?.minSimilarity,semanticThreshold:config.retrieval?.semanticThreshold}; }
    catch { return null; }
  }

  function getSchema(args) {
    if(!Array.isArray(args.tables)||!args.tables.length) throw new Error("tables 必须是非空数组");
    const names=[...new Set(args.tables.map((name)=>String(name||"").trim()).filter(Boolean))];
    if(names.length>8) throw new Error("一次最多查看 8 张表");
    const unknown=names.filter((name)=>!catalog.tableByName.has(name));
    if(unknown.length) {
      const suggestedTables=suggestCatalogTables(unknown,catalog.tables);
      return toolFailure({stage:"schema",code:"UNKNOWN_TABLE",error:`表不在可查询白名单：${unknown.join(", ")}${suggestedTables.length?`；可能相关的真实表：${suggestedTables.join("、")}，请改用这些表调用 get_schema`:""}`,retryable:true,details:{unknownTables:unknown,suggestedTables}});
    }
    for(const name of names) disclosedTables.add(normalizeIdentifier(name));
    const selected=new Set(names);
    return {
      ok:true,
      tables:names.map((name)=>({
        name,
        comment:catalog.tableByName.get(name).comment||"",
        columnCount:catalog.columnsByTable[name].length,
        columnsTruncated:catalog.columnsByTable[name].length>120,
        columns:catalog.columnsByTable[name].slice(0,120).map((column)=>({name:column.columnName,type:column.dataType,nullable:Boolean(column.nullable),comment:clipText(column.comment,300),primary:Boolean(column.isPrimary),unique:Boolean(column.isUnique),semanticKind:columnSemanticKind(column)||undefined,enum:catalog.enums[`${name}.${column.columnName}`]?.slice(0,20)||undefined})),
      })),
      relations:catalog.relations.filter((relation)=>selected.has(relation.fromTable)&&selected.has(relation.toTable)).map((relation)=>`${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}`),
    };
  }

  function resolveEntity(args) {
    const requested=requiredText(args.entity,"entity",200);
    const entityType=String(args.entityType||"organization");
    if(entityType!=="organization")return toolFailure({stage:"intent",code:"INTENT_ENTITY_TYPE_UNSUPPORTED",error:`当前只支持解析 organization 实体，收到 ${entityType}`});
    const immutable=queryIntent.entities.find((item)=>item.type==="organization");
    if(immutable&&requested.replace(/\s+/g,"")!==immutable.text.replace(/\s+/g,""))return toolFailure({stage:"intent",code:"INTENT_ENTITY_MUTATED",error:`实体必须保持用户原文“${immutable.text}”，不能改写为“${requested}”`,retryable:true,details:{expected:immutable.text,received:requested}});
    const canonical=immutable?.text||requested;
    const candidates=[];
    for(const table of catalog.tables)for(const column of catalog.columnsByTable[table.tableName]||[]) {
      const score=organizationColumnScore(column);
      if(score>0)candidates.push({table:table.tableName,column:column.columnName,comment:clipText(column.comment,160),score});
    }
    candidates.sort((left,right)=>right.score-left.score||left.table.localeCompare(right.table)||left.column.localeCompare(right.column));
    if(!candidates.length)return toolFailure({stage:"schema",code:"SCHEMA_GAP",error:"当前白名单结构中没有可绑定机构名称的字段",details:{entity:canonical}});
    return {ok:true,entity:{type:"organization",value:canonical,immutable:Boolean(immutable)},operator:"contains",sqlLiteral:`%${canonical}%`,candidateColumns:candidates.slice(0,16).map((item)=>({table:item.table,column:item.column,comment:item.comment})),requiresSchemaReview:true};
  }

  async function sampleData(args) {
    sampleDataCalls++;
    if(sampleDataCalls>3) return {ok:false,stage:"budget",error:"sample_data 已达到 3 次上限"};
    const table=requiredText(args.table,"table",256);
    if(!catalog.tableByName.has(table)) return {ok:false,stage:"guard",error:`表不在可查询白名单：${table}`};
    if(!disclosedTables.has(normalizeIdentifier(table))) return {ok:false,stage:"guard",error:`采样前必须先用 get_schema 查看表：${table}`};
    if(!Array.isArray(args.columns)||!args.columns.length) return {ok:false,stage:"guard",error:"columns 必须是非空数组"};
    const columns=[...new Set(args.columns.map((column)=>String(column||"").trim()).filter(Boolean))];
    if(columns.length>10) return {ok:false,stage:"guard",error:"一次最多采样 10 个字段"};
    const allowed=new Set(catalog.columnsByTable[table].map((column)=>column.columnName));
    const forbidden=columns.filter((column)=>!allowed.has(column));
    if(forbidden.length) return {ok:false,stage:"guard",error:`字段不在白名单：${forbidden.map((column)=>`${table}.${column}`).join(", ")}`};
    const limit=boundedInteger(args.limit,10,1,20);
    const sql=`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)} LIMIT ${limit}`;
    const verdict=guardSql(sql,catalog.policy);
    if(!verdict.ok) return {ok:false,stage:"guard",error:verdict.reason};
    const executionStarted=Date.now();
    const explanation=await explainSql(verdict.sql);
    if(!explanation.ok) return explanation;
    try {
      const [rawRows,rawFields]=await connector.query(source,verdict.sql,[],activeSignal);
      const rows=rawRows.map(normalizeQueryRow);
      const fields=normalizeFields(rawFields,rows);
      const contextRows=truncateRows(rows,{maxRows:20,maxBytes:32*1024,maxCellChars:200});
      explorationCalls++;
      return {ok:true,table,columns,rowCount:rows.length,fields,scannedRows:explanation.scannedRows,durationMs:Date.now()-executionStarted,rows:contextRows.rows,truncated:contextRows.truncated};
    } catch(error) {
      return {ok:false,stage:"query",error:safeError(error)};
    }
  }

  function validateSemanticPlan(args) {
    if(!semanticRuntime?.ok) return {ok:false,stage:"semantic",error:semanticRuntime?.reason||"当前没有可用的发布语义模型"};
    if(!args?.plan||typeof args.plan!=="object"||Array.isArray(args.plan)) return {ok:false,stage:"semantic",error:"plan 必须是对象"};
    try {
      const compiled=compileSemanticQueryPlan(args.plan,{schema:semanticRuntime.published.schema,catalog:semanticRuntime.catalog,maxRows:config.queryMaxRows,ontologySchemaVersion:semanticRuntime.published.version});
      const contractValidation=queryResultContractValidation(queryIntent,compiled.sql,{usedTables:compiled.policy.allowedTables||[],retrieval:retrievalEvidence,verdict:guardSql(compiled.sql,{...compiled.policy,valueKinds:catalog.policy.valueKinds}),columnsByTable:catalog.columnsByTable,semanticContract:compiled.semanticContract});
      if(!contractValidation.ok)return toolFailure({stage:"intent",code:contractValidation.errors[0].code,error:contractValidation.errors[0].message,retryable:true,details:contractValidation.errors[0].details});
      const binding={...compiled,ontologySchemaVersion:semanticRuntime.published.version,contractValidation};
      validatedSemanticPlans.set(sqlHash(compiled.sql),binding);
      for(const table of compiled.policy.allowedTables||[]) disclosedTables.add(normalizeIdentifier(table));
      return {ok:true,sql:compiled.sql,plan:compiled.plan,semanticPath:compiled.semanticPath,ontologySchemaVersion:semanticRuntime.published.version};
    } catch(error) {
      return {ok:false,stage:"semantic",error:safeError(error)};
    }
  }

  async function runSql(args) {
    const sql=requiredText(args.sql,"sql",50_000);
    const name=args.name==null?`查询 ${runSqlCalls+1}`:requiredText(args.name,"name",100);
    runSqlCalls++;
    if(runSqlCalls>maxSqlCalls) return toolFailure({stage:"budget",code:"SQL_CALL_BUDGET_EXCEEDED",error:`run_sql 已达到 ${maxSqlCalls} 次上限`});
    const semanticPlan=validatedSemanticPlans.get(sqlHash(sql));
    const verdict=guardSql(sql,{...(semanticPlan?.policy||catalog.policy),valueKinds:catalog.policy.valueKinds});
    if(!verdict.ok) {
      const suggestedTables=verdict.code==="UNKNOWN_TABLE"?suggestCatalogTables(verdict.details?.unknownTables||[],catalog.tables):[];
      const bindingTables=new Set(retrievalEvidence.flatMap((item)=>item?.diagnostics?.facets||[]).flatMap((facet)=>facet.bindingTables||[]));
      const relationPath=verdict.code==="UNCONFIRMED_RELATION"?suggestConfirmedRelationPath(verdict.reason,catalog.relations,bindingTables):null;
      const relationHint=relationPath?`；已确认的替代关联路径：${relationPath.joins.join(" → ")}。${relationPath.intermediateTables.length?`请先用 get_schema 查看中间表 ${relationPath.intermediateTables.join("、")}`:"请按此已确认字段关系改写"}`:"";
      return toolFailure({stage:"guard",code:verdict.code||"GUARD_REJECTED",error:`${verdict.reason}${suggestedTables.length?`；可能相关的真实表：${suggestedTables.join("、")}，请先调用 get_schema 确认字段`:""}${relationHint}`,retryable:true,details:{...(verdict.details||{}),...(suggestedTables.length?{suggestedTables}:{}),...(relationPath?{suggestedRelationPath:relationPath}:{})}});
    }
    const contractExecution={usedTables:verdict.tables,retrieval:retrievalEvidence,verdict,columnsByTable:catalog.columnsByTable,semanticContract:semanticPlan?.semanticContract||null};
    const intentError=queryIntentFilterError(question,verdict.sql,queryIntent,contractExecution);
    if(intentError)return toolFailure({stage:"intent",code:intentError.code,error:intentError.message,retryable:intentError.retryable,details:intentError.details});
    const contractValidation=queryResultContractValidation(queryIntent,verdict.sql,contractExecution);
    if(!contractValidation.ok) {
      const error=contractValidation.errors?.[0]||{};
      return toolFailure({stage:"intent",code:error.code||"INTENT_RESULT_CONTRACT_MISMATCH",error:error.message||"SQL 未满足查询结果契约",retryable:true,details:error.details});
    }
    const undisclosed=verdict.tables.filter((table)=>!disclosedTables.has(normalizeIdentifier(table)));
    if(undisclosed.length) return {ok:false,stage:"guard",error:`执行前必须先用 get_schema 查看表：${undisclosed.join(", ")}`};
    const executionStarted=Date.now();
    const explanation=await explainSql(verdict.sql);
    if(!explanation.ok) return explanation;
    try {
      const [rawRows,rawFields]=await connector.query(source,verdict.sql,[],activeSignal);
      const rows=rawRows.map(normalizeQueryRow);
      const fields=normalizeFields(rawFields,rows);
      const resultDelivery=rows.length>100?"direct":"preview";
      const mayBeTruncated=Number.isFinite(Number(verdict.limit?.effective))&&rows.length>=Number(verdict.limit.effective);
      const run={name,requestedSql:sql,sql:verdict.sql,sqlHashes:new Set([sqlHash(sql),sqlHash(verdict.sql)]),rows,fields,verdict,contractValidation,scannedRows:explanation.scannedRows,durationMs:Date.now()-executionStarted,resultDelivery,semanticPlan,mayBeTruncated};
      successfulRuns.push(run);
      const contextRows=resultDelivery==="direct"?{rows:[],truncated:true,modelRowsOmitted:true}:truncateRows(rows,{maxRows:40,maxBytes:64*1024,maxCellChars:200});
      return {ok:true,executedSql:verdict.sql,columns:fields,rowCount:rows.length,scannedRows:explanation.scannedRows,durationMs:run.durationMs,rows:contextRows.rows,truncated:contextRows.truncated,modelRowsOmitted:contextRows.modelRowsOmitted||undefined,resultDelivery,mayBeTruncated,limit:verdict.limit};
    } catch(error) {
      return toolFailure({stage:"query",code:"EXECUTION_ERROR",error:safeError(error),retryable:true});
    }
  }

  function askUser(args) {
    askUserCalls++;
    if(askUserCalls>1)return {result:{ok:false,stage:"budget",error:"每轮问答最多只能调用一次 ask_user"},terminal:null};
    if(explorationCalls<1)return {result:{ok:false,stage:"guard",error:"调用 ask_user 前必须先用 search_context 或 sample_data 自行消歧"},terminal:null};
    const clarificationQuestion=requiredText(args.question,"question",300);
    const options=Array.isArray(args.options)?[...new Set(args.options.map((item)=>String(item||"").trim()).filter(Boolean))]:[];
    if(options.length>5)return {result:{ok:false,stage:"guard",error:"澄清选项最多 5 个"},terminal:null};
    if(options.some((item)=>item.length>100))return {result:{ok:false,stage:"guard",error:"单个澄清选项不能超过 100 字"},terminal:null};
    const allowFreeText=args.allowFreeText!==false;
    if(!options.length&&!allowFreeText)return {result:{ok:false,stage:"guard",error:"ask_user 必须提供选项或允许自由输入"},terminal:null};
    const unsafe=clarificationContentError([clarificationQuestion,...options].join("\n"),catalog);
    if(unsafe)return {result:{ok:false,stage:"guard",error:unsafe},terminal:null};
    const clarification={question:clarificationQuestion,options,allowFreeText};
    return {result:{ok:true,pending:true,question:clarificationQuestion,optionCount:options.length,allowFreeText},terminal:{status:"clarification",clarification}};
  }

  function submitAnswer(args) {
    const conclusion=requiredText(args.conclusion,"conclusion",2_000);
    const requested=Array.isArray(args.sqls)&&args.sqls.length?args.sqls:args.sql!=null?[args.sql]:[];
    if(!requested.length)return {result:{ok:false,error:"submit_answer 必须提供 sql 或 sqls"},terminal:null};
    if(requested.length>5)return {result:{ok:false,error:"submit_answer 一次最多提交 5 个 SQL"},terminal:null};
    const runs=[];
    for(const value of requested) {
      const sql=requiredText(value,"sql",50_000);
      const run=successfulRuns.findLast((item)=>item.sqlHashes.has(sqlHash(sql)));
      if(!run) return {result:{ok:false,error:"submit_answer 的 SQL 未匹配本轮任何成功 run_sql；请引用已成功执行的 SQL"},terminal:null};
      if(runs.includes(run))return {result:{ok:false,error:"submit_answer.sqls 不能重复引用同一次 SQL 执行"},terminal:null};
      runs.push(run);
    }
    for(const run of runs) {
      const validation=refreshRunContractValidation(run);
      if(!validation.ok) {
        const error=validation.errors?.[0]||{};
        return {result:toolFailure({stage:"intent",code:error.code||"INTENT_RESULT_CONTRACT_MISMATCH",error:error.message||"提交结果与最终查询契约不一致",retryable:true,details:error.details}),terminal:null};
      }
    }
    const missingScopes=missingExhaustiveAccountTables(question,context,runs.flatMap((run)=>run.verdict.tables||[]));
    if(missingScopes.length)return {result:{ok:false,error:`问题要求查询所有账号，但提交结果遗漏账号主表：${missingScopes.join("、")}`},terminal:null};
    const missingSubjectFacets=missingIntentSubjectFacets(queryIntent,retrievalEvidence,runs.flatMap((run)=>run.verdict.tables||[]));
    if(missingSubjectFacets.length)return {result:toolFailure({stage:"intent",code:"INTENT_SUBJECT_INCOMPLETE",error:`提交结果遗漏业务对象：${describeIntentFacets(queryIntent,missingSubjectFacets).join("、")}`,retryable:true,details:{missingFacets:missingSubjectFacets}}),terminal:null};
    const missingProductColumns=missingExhaustiveAccountProductColumns(question,context,runs.map((run)=>({sql:run.sql,tables:run.verdict.tables||[]})));
    if(missingProductColumns.length)return {result:{ok:false,error:`问题要求查询所有账号，但提交结果没有返回产品维度：${missingProductColumns.join("、")}`},terminal:null};
    const resultContract=resultContractForRuns(runs);
    const contractSetValidation=validateQueryRunSet(resultContract,runs);
    if(!contractSetValidation.ok) {
      const error=contractSetValidation.errors[0];
      return {result:toolFailure({stage:"intent",code:error.code||"INTENT_RESULT_CONTRACT_MISMATCH",error:error.message||"提交结果未满足查询结果契约",retryable:true,details:error.details}),terminal:null};
    }
    const incompleteRuns=runs.filter((run)=>run.mayBeTruncated);
    if(queryIntent.scope?.exhaustive&&incompleteRuns.length)return {result:toolFailure({stage:"result",code:"RESULT_INCOMPLETE",error:`问题要求完整结果，但以下结果集达到安全 LIMIT，无法确认已完整返回：${incompleteRuns.map((run)=>run.name).join("、")}`,retryable:true,details:{resultSets:incompleteRuns.map((run)=>run.name)}}),terminal:null};
    const delta=args.delta==null?undefined:clipText(String(args.delta),500);
    return {result:{ok:true,queryCount:runs.length},terminal:{status:"answered",conclusion,delta,run:runs.at(-1),runs,resultContract,resultContractFingerprint:contractFingerprint(resultContract)}};
  }

  function refreshRunContractValidation(run) {
    const contractValidation=queryResultContractValidation(queryIntent,run.sql,{
      usedTables:run.verdict?.tables||[],retrieval:retrievalEvidence,verdict:run.verdict,columnsByTable:catalog.columnsByTable,semanticContract:run.semanticPlan?.semanticContract||null,
    });
    run.contractValidation=contractValidation;
    return contractValidation;
  }

  function resultContractForRuns(runs) {
    const semanticContracts=(runs||[]).map((run)=>run.semanticPlan?.semanticContract||null);
    const sharedSemanticContract=semanticContracts.length&&semanticContracts.every(Boolean)&&semanticContracts.every((contract)=>stableJson(contract)===stableJson(semanticContracts[0]))?semanticContracts[0]:null;
    return buildQueryResultContract(queryIntent,retrievalEvidence,sharedSemanticContract);
  }

  function contractFingerprint(contract) { return hash(`query-result-contract:${stableJson(contract)}`); }

  function refuse(args) {
    const reason=requiredText(args.reason,"reason",1_000);
    return {result:{ok:true},terminal:{status:"refused",reason,failureClass:dominantFailureClass(toolTrace,"policy_block")}};
  }

  async function explainSql(sql) {
    let explain;
    try { explain=await connector.explain(source,sql,activeSignal); }
    catch(error) { return toolFailure({stage:"explain",code:"EXPLAIN_ERROR",error:safeError(error),retryable:true}); }
    const scannedRows=explain.reduce((sum,row)=>sum+Math.max(0,Number(row.rows||0)),0);
    if(scannedRows>Number(config.explainMaxRows||1_000_000)) return toolFailure({stage:"explain",code:"SCAN_LIMIT_EXCEEDED",error:`EXPLAIN 预计扫描 ${scannedRows} 行，超过单次阈值 ${config.explainMaxRows||1_000_000}`,retryable:true});
    if(scannedRowsTotal+scannedRows>maxScannedRows) return toolFailure({stage:"budget",code:"SCAN_BUDGET_EXCEEDED",error:`累计 EXPLAIN 扫描预算将超过 ${maxScannedRows} 行`});
    scannedRowsTotal+=scannedRows;
    return {ok:true,scannedRows};
  }
}

function completeAccountFallbackRuns(successfulRuns,question,context) {
  const roots=exhaustiveAccountTables(question,context);
  if(roots.length<2)return null;
  const selected=[];
  for(const root of roots) {
    const candidate=successfulRuns.findLast((run)=>{
      if(!run.contractValidation?.ok)return false;
      if(!(run.verdict?.tables||[]).some((table)=>normalizeIdentifier(table)===normalizeIdentifier(root)))return false;
      if(run.mayBeTruncated)return false;
      return !missingExhaustiveAccountProductColumns(question,context,[{sql:run.sql,tables:run.verdict?.tables||[]}]).some((item)=>normalizeIdentifier(item.split(".")[0])===normalizeIdentifier(root));
    });
    if(!candidate)return [];
    if(!selected.includes(candidate))selected.push(candidate);
  }
  return selected.sort((left,right)=>successfulRuns.indexOf(left)-successfulRuns.indexOf(right));
}

function buildCatalog(store,sourceId,maxRows,question="",ontologySchema=null) {
  const tables=store.listTables(sourceId).filter((table)=>table.grade!=="C"&&table.active);
  const rawColumnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));
  const columnSemantics=buildQueryColumnSemantics(rawColumnsByTable);
  const columnsByTable=rawColumnsByTable;
  const enums={};const enumItemsByColumn={};
  for(const table of tables) for(const item of store.listEnums(sourceId,table.tableName)) {const key=`${table.tableName}.${item.columnName}`;(enums[key]??=[]).push(item.value);(enumItemsByColumn[key]??=[]).push(item);}
  const relations=store.listRelations(sourceId,true);
  return {
    tables,
    tableByName:new Map(tables.map((table)=>[table.tableName,table])),
    columnsByTable,
    enums,
    enumItemsByColumn,
    relations,
    ontologySchema:ontologySchema||store.getPublishedOntologySchema(sourceId)?.schema||null,
    pages:store.listKnowledge(sourceId),
    rules:store.listRules(sourceId),
    policy:{allowedTables:tables.map((table)=>table.tableName),allowedColumns:columnSemantics.allowedColumns,columnKinds:columnSemantics.columnKinds,valueKinds:detectQuestionValueKinds(question),allowedRelations:relations,maxRows,enums:Object.fromEntries(Object.entries(enums).map(([key,values])=>[key,{mode:"observed",values:values.filter((value)=>value!=="null")}]))},
  };
}

function agentSystemPrompt({maxIterations,maxSqlCalls,maxScannedRows},template=QUERY_PROMPT_DEFAULTS.agentSystem) {
  return renderQueryPrompt(template||QUERY_PROMPT_DEFAULTS.agentSystem,{maxIterations,maxSqlCalls,maxScannedRows});
}

function agentQuestionPrompt(question,context,history,semanticRuntime,template=QUERY_PROMPT_DEFAULTS.agentQuestion) {
  const retrievalCapabilities=(context.retrieval?.diagnostics?.facets||[]).filter((facet)=>facet.required).map((facet)=>({
    key:facet.key,
    executionTables:(facet.executionTables||[]).slice(0,4),
    executionColumns:(facet.executionColumns||[]).slice(0,12),
    filterBindings:(facet.filterBindings||[]).slice(0,12),
    executionValidityPredicates:(facet.executionValidityPredicates||[]).slice(0,8),
    labelColumns:(facet.labelColumns||[]).slice(0,8),
    bindingTables:(facet.bindingTables||[]).slice(0,4),
    bindingColumns:(facet.bindingColumns||[]).slice(0,8),
    bindingRelationIds:(facet.bindingRelationIds||[]).slice(0,8),
    bindingValidityPredicates:(facet.bindingValidityPredicates||[]).slice(0,8),
    paths:(facet.paths||[]).slice(0,4),
  }));
  const initial={
    question,
    queryIntent:context.queryIntent||parseQueryIntent(question),
    retrievalContract:context.retrieval?.coverageContract,
    retrievalCapabilities,
    lifecycle:["UNDERSTAND","RETRIEVE","RESOLVE","PLAN","VALIDATE","EXECUTE","REPAIR","SUBMIT"],
    recentConversation:history.slice(-10).map((item)=>({role:item.role,content:clipText(item.content,500)})),
    retrievedKnowledge:context.knowledge.map((page)=>({type:page.pageType,title:page.title,definition:clipText(page.content,1_500),sqlGuidance:clipText(page.sqlContent,1_000),antiExamples:clipText(page.antiExamples,800)})),
    initialSchema:context.tables.map((table)=>({name:table.tableName,comment:table.comment||"",columns:(context.columns[table.tableName]||[]).map((column)=>({name:column.columnName,type:column.dataType,comment:column.comment||"",semanticKind:columnSemanticKind(column)||undefined}))})),
    confirmedRelations:context.relations.map((relation)=>`${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}`),
    businessRules:context.rules.map((rule)=>({name:rule.name,content:clipText(rule.content,1_000)})),
    semanticModel:semanticRuntime?.ok?{version:semanticRuntime.published.version,...semanticPlanningView(semanticRuntime.published.schema,semanticRuntime.catalog)}:undefined,
  };
  return renderQueryPrompt(template||QUERY_PROMPT_DEFAULTS.agentQuestion,{context:JSON.stringify(initial)});
}

function toolLlmOptions(llm,timeoutMs,signal) {
  const extraBody={max_tokens:3_000};
  if(/dashscope|\.maas\.aliyuncs\.com/i.test(llm.baseUrl)) extraBody.enable_thinking=false;
  return {timeoutMs:Math.max(1,timeoutMs),extraBody,signal};
}

function makeTrace(action,thought,result,durationMs,phase) {
  const trace={tool:action.tool,phase,thought,argsHash:hash(JSON.stringify(action.args||{})),durationMs,ok:Boolean(result?.ok),summary:toolSummary(action.tool,result)};
  if(!result?.ok){trace.stage=result?.stage;trace.errorCode=result?.code;trace.failureClass=result?.failureClass;trace.retryable=Boolean(result?.retryable);}
  if(action.tool==="run_sql") trace.sql=result?.executedSql||redactTypedLiterals(clipText(action.args.sql,50_000));
  if(action.tool==="search_context"&&result?.pages) trace.pages=result.pages.map((page)=>page.title);
  if(action.tool==="get_schema"&&result?.tables) trace.tables=result.tables.map((table)=>({name:table.name,fieldCount:table.columnCount??table.columns.length}));
  if(action.tool==="resolve_entity"&&result?.entity) trace.entity={type:result.entity.type,value:result.entity.value,candidateCount:result.candidateColumns?.length||0};
  if(action.tool==="sample_data") trace.sample={table:clipText(result?.table??action.args.table,256),columns:(result?.columns??(Array.isArray(action.args.columns)?action.args.columns:[])).slice(0,10).map(String)};
  if(action.tool==="validate_semantic_plan"&&result?.ok) trace.semanticPlan={ontologySchemaVersion:result.ontologySchemaVersion,rootObject:result.plan?.rootObject};
  if(action.tool==="ask_user"&&result?.question) trace.clarification={question:result.question,optionCount:result.optionCount,allowFreeText:result.allowFreeText};
  return trace;
}

function toolCallEvent(step,action) {
  const event={type:"tool_call",step,tool:action.tool};
  if(action.tool==="run_sql") event.sql=clipText(action.args.sql,50_000);
  if(action.tool==="get_schema") event.tables=Array.isArray(action.args.tables)?action.args.tables.slice(0,8).map(String):[];
  if(action.tool==="sample_data") event.sample={table:clipText(action.args.table,256),columns:Array.isArray(action.args.columns)?action.args.columns.slice(0,10).map(String):[]};
  return event;
}

function traceDisplay(trace) {
  if(trace.tool==="run_sql"&&trace.sql) return {sql:trace.sql};
  if(trace.tool==="search_context"&&trace.pages) return {pages:trace.pages};
  if(trace.tool==="get_schema"&&trace.tables) return {tables:trace.tables};
  if(trace.tool==="sample_data"&&trace.sample) return {sample:trace.sample};
  return {};
}

function toolSummary(tool,result) {
  if(!result?.ok) return clipText(result?.error||`${tool} 执行失败`,300);
  if(tool==="search_context") return `命中 ${result.pages.length} 个知识页、${result.relatedTables.length} 张相关表`;
  if(tool==="get_schema") return `已查看 ${result.tables.length} 张表的安全结构元数据`;
  if(tool==="resolve_entity") return `实体“${result.entity.value}”已保持原文并绑定到 ${result.candidateColumns.length} 个候选字段`;
  if(tool==="sample_data") return `已采样 ${result.table} 的 ${result.columns.length} 个字段、${result.rowCount} 行`;
  if(tool==="validate_semantic_plan") return `语义计划已通过确定性编译（Ontology v${result.ontologySchemaVersion}）`;
  if(tool==="run_sql") return `SQL 执行成功，返回 ${result.rowCount} 行，耗时 ${result.durationMs}ms`;
  if(tool==="ask_user") return `等待用户澄清：${result.question}`;
  if(tool==="submit_answer") return `已提交 ${result.queryCount||1} 个已验证查询的结论`;
  if(tool==="refuse") return "已安全拒答";
  return `${tool} 已完成`;
}

function truncateRows(rows,{maxRows,maxBytes,maxCellChars}) {
  const output=[];
  let bytes=2;
  for(const row of rows.slice(0,maxRows)) {
    const clipped=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,truncateCell(value,maxCellChars)]));
    const serialized=JSON.stringify(clipped);
    const size=Buffer.byteLength(serialized)+1;
    if(bytes+size>maxBytes) break;
    output.push(clipped);bytes+=size;
  }
  return {rows:output,truncated:output.length<rows.length};
}

function truncateCell(value,maxChars) {
  if(typeof value==="string"&&value.length>maxChars) return `${value.slice(0,maxChars)}…`;
  return value;
}

function normalizeFields(fields,rows) {
  if(Array.isArray(fields)&&fields.length) return fields.map((field)=>({name:field.name,type:field.type??field.columnType??null}));
  return Object.keys(rows[0]||{}).map((name)=>({name,type:typeof rows[0]?.[name]}));
}

function normalizeToolFailure(result) {
  if(result?.ok||result?.code)return result;
  const stage=result?.stage||"internal";
  const code={budget:"BUDGET_EXCEEDED",guard:"GUARD_REJECTED",semantic:"SEMANTIC_PLAN_INVALID",query:"EXECUTION_ERROR",explain:"EXPLAIN_ERROR",result:"RESULT_INCOMPLETE"}[stage]||"TOOL_ERROR";
  return {...result,...toolFailure({stage,code,error:result?.error||"工具执行失败",retryable:["guard","semantic","query","explain","intent","loop"].includes(stage),details:result?.details})};
}

function phasesForTool(tool) { return {search_context:["RETRIEVE"],get_schema:["RETRIEVE"],resolve_entity:["RESOLVE"],sample_data:["RESOLVE"],validate_semantic_plan:["PLAN","VALIDATE"],run_sql:["PLAN","VALIDATE","EXECUTE"],ask_user:["RESOLVE"],submit_answer:["SUBMIT"],refuse:["SUBMIT"]}[tool]||["UNDERSTAND"]; }
function availableAgentTools({searchContextSucceeded=false}={}) { return searchContextSucceeded?QUERY_AGENT_TOOLS.filter((tool)=>tool.name!=="search_context"):QUERY_AGENT_TOOLS; }
function actionFingerprint(action){return `${action?.tool||"unknown"}:${hash(stableJson(action?.args||{}))}`;}
function stableJson(value){if(Array.isArray(value))return `[${value.map(stableJson).join(",")}]`;if(value&&typeof value==="object")return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;return JSON.stringify(value);}
function clarificationEvidenceDisposition(refreshed) {return !refreshed?"reused":refreshed.ok?"refreshed":"refresh_failed";}
function clarifiedEvidenceGap(intent,retrieval) {
  if(!retrieval?.ok)return null;
  const missingFacets=missingRequiredRetrievalFacets(retrieval);
  if(!missingFacets.length)return null;
  const requirements=new Map((intent?.requirements||[]).map((item)=>[item.id,item]));
  const attribution=missingFacets.map((id)=>requirements.get(id)).find((item)=>item?.kind==="dimension"&&item.attribution);
  if(attribution) {
    const attributionLabel=attribution.attribution==="event_time"?"事件发生时负责人":attribution.attribution==="current"?"当前负责人":String(attribution.attribution);
    return {
      errorCode:"INTENT_DIMENSION_ATTRIBUTION_BINDING_MISSING",
      missingFacets,
      reason:`澄清后的“${attributionLabel}”没有唯一、可验证的已发布归属角色和已确认关系路径；系统不会复用其他归属口径或猜测历史快照。`,
    };
  }
  return {
    errorCode:"INTENT_REQUIRED_RETRIEVAL_FACET_MISSING",
    missingFacets,
    reason:`澄清后的结构化查询口径仍缺少可执行的已发布能力：${describeIntentFacets(intent,missingFacets).join("、")}；系统不会在覆盖不完整时继续规划或执行 SQL。`,
  };
}
function intentEvidenceFingerprint(intent) {
  const excluded=new Set(["rawQuestion","normalizedQuestion","semanticQuestion","ambiguities"]);
  const contract=Object.fromEntries(Object.entries(intent||{}).filter(([key])=>!excluded.has(key)));
  return hash(`intent-evidence-v1:${stableJson(contract)}`);
}
function suggestCatalogTables(unknownTables,tables,limit=5) {
  const unknown=[...new Set((unknownTables||[]).map(normalizeIdentifier).filter(Boolean))];
  if(!unknown.length)return [];
  return tables.map((table)=>({name:table.tableName,score:Math.max(...unknown.map((value)=>tableNameSimilarity(value,table.tableName)))})).filter((item)=>item.score>0).sort((left,right)=>right.score-left.score||left.name.localeCompare(right.name)).slice(0,limit).map((item)=>item.name);
}
function suggestConfirmedRelationPath(reason,relations,preferredTables=new Set(),maxHops=4) {
  const match=String(reason||"").match(/未确认的(?:\s*JOIN|关联)：([a-z0-9_$-]+)\.([a-z0-9_$-]+)\s*=\s*([a-z0-9_$-]+)\.([a-z0-9_$-]+)/i);
  if(!match)return null;
  const start=normalizeIdentifier(match[1]);const target=normalizeIdentifier(match[3]);
  const graph=new Map();
  for(const relation of relations||[]) {
    if(!isUsableConfirmedRelation(relation))continue;
    const from=normalizeIdentifier(relation.fromTable);const to=normalizeIdentifier(relation.toTable);
    if(!graph.has(from))graph.set(from,[]);if(!graph.has(to))graph.set(to,[]);
    graph.get(from).push({next:to,relation});graph.get(to).push({next:from,relation});
  }
  const preferred=new Set([...preferredTables].map(normalizeIdentifier));
  const queue=[{table:start,tables:[start],edges:[]}];const bestDepth=new Map([[start,0]]);
  while(queue.length) {
    const current=queue.shift();
    if(current.table===target&&current.edges.length) {
      return {
        tables:current.tables,
        intermediateTables:current.tables.slice(1,-1),
        joins:current.edges.map(({relation})=>`${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}`),
      };
    }
    if(current.edges.length>=maxHops)continue;
    const edges=[...(graph.get(current.table)||[])].sort((left,right)=>Number(preferred.has(right.next))-Number(preferred.has(left.next))||left.next.localeCompare(right.next));
    for(const edge of edges) {
      const depth=current.edges.length+1;
      if((bestDepth.get(edge.next)??Infinity)<=depth)continue;
      bestDepth.set(edge.next,depth);
      queue.push({table:edge.next,tables:[...current.tables,edge.next],edges:[...current.edges,edge]});
    }
  }
  return null;
}
function isUsableConfirmedRelation(relation) {
  const status=String(relation?.status||"").toLowerCase();
  return !status||status==="confirmed"||status==="accepted";
}
function tableNameSimilarity(leftValue,rightValue) {
  const left=normalizeIdentifier(leftValue);const right=normalizeIdentifier(rightValue);
  if(left===right)return 100;
  let score=0;if(right.endsWith(`_${left}`)||left.endsWith(`_${right}`))score+=20;if(right.includes(left)||left.includes(right))score+=10;
  const leftParts=new Set(left.split("_").filter((part)=>part.length>1));const rightParts=new Set(right.split("_").filter((part)=>part.length>1));
  const overlap=[...leftParts].filter((part)=>rightParts.has(part)).length;score+=overlap*4-Math.abs(leftParts.size-rightParts.size)*.25;
  return score;
}
function organizationColumnScore(column){const name=String(column?.columnName||"").toLowerCase();const comment=String(column?.comment||"");let score=0;if(/(?:^|_)(?:office_?name|law_?firm(?:_?name)?|firm_?name|organization_?name|org_?name)(?:_|$)/.test(name))score+=5;if(/(?:律所|律师事务所|机构|组织)(?:名称|名)/.test(comment))score+=5;if(/name/.test(name)&&/(?:office|firm|org)/.test(name))score+=2;return score;}

function sanitizeThought(value) {
  const safe=String(value||"").replace(/(password|token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]").replace(/\s+/g," ").trim();
  return clipText(safe.split(/(?<=[。！？!?])\s*/)[0],160)||"正在安全分析。";
}

function safeError(error) {
  return clipText(String(error?.message||error).replace(/(password|token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]"),1_000);
}

function requiredText(value,name,maxLength) {
  const text=String(value??"").trim();
  if(!text) throw new Error(`${name} 不能为空`);
  if(text.length>maxLength) throw new Error(`${name} 超过长度上限 ${maxLength}`);
  return text;
}

function clipText(value,maxLength) {
  const text=String(value??"");
  return text.length>maxLength?`${text.slice(0,maxLength)}…`:text;
}

function sqlHash(sql) { return hash(String(sql||"").trim().replace(/\s+/g," ")); }
function normalizeIdentifier(value) { return String(value||"").replaceAll("`","").toLowerCase(); }
function quoteIdentifier(value) { return `\`${String(value).replaceAll("`","``")}\``; }
function isTerminalTool(tool) { return tool==="submit_answer"||tool==="refuse"; }
function clarificationContentError(value,catalog) {
  const text=String(value||"");const normalized=text.toLowerCase();
  if(/```|;|\b(?:select|from|where|join|group\s+by|order\s+by|having|limit|union|insert|update|delete|drop|alter|create)\b/i.test(text))return "澄清问题不能包含 SQL 或技术查询细节";
  const table=catalog.tables.map((item)=>item.tableName).find((name)=>normalized.includes(String(name).toLowerCase()));
  if(table)return `澄清问题不能暴露物理表名 ${table}`;
  return null;
}
function blockingIntentClarification(intent) {
  const supported=RESOLVABLE_INTENT_AMBIGUITIES;
  const ambiguity=(intent?.ambiguities||[]).find((item)=>item?.blocking&&supported.has(item.code));
  if(!ambiguity)return null;
  const options=[...new Set((ambiguity.options||[]).map((item)=>String(item||"").trim()).filter(Boolean))].slice(0,5);
  return {question:`${String(ambiguity.message||"查询口径需要确认").replace(/[。；;]+$/g,"")}。请选择统计口径：`,options,allowFreeText:true};
}
function unresolvableBlockingIntent(intent) {return (intent?.ambiguities||[]).find((item)=>item?.blocking&&!RESOLVABLE_INTENT_AMBIGUITIES.has(item.code))||null;}
const RESOLVABLE_INTENT_AMBIGUITIES=new Set([
  "DIMENSION_ATTRIBUTION_AMBIGUOUS","TIME_RANGE_UNKNOWN","TIME_ROLE_AMBIGUOUS","TIME_ROLE_UNKNOWN","TIME_GRAIN_UNKNOWN","MEASURE_GRAIN_AMBIGUOUS",
  "RANKING_DIMENSION_UNKNOWN","RANKING_MEASURE_UNKNOWN","RANKING_LIMIT_INVALID","COMPARISON_BASELINE_UNKNOWN",
  "FILTER_BOOLEAN_UNSUPPORTED","FILTER_EXPRESSION_UNSUPPORTED","FILTER_VALUE_TYPE_UNSUPPORTED","FILTER_OPERATOR_UNSUPPORTED","FILTER_RESET_TARGET_UNKNOWN",
  "DELETION_SCOPE_UNKNOWN",
]);
function emitEvent(onEvent,event) { try { onEvent?.(event); } catch { /* Streaming observers cannot control the harness. */ } }
function throwIfAborted(signal) { if(signal?.aborted){const error=new Error("查询已取消");error.name="AbortError";error.code="ABORT_ERR";throw error;} }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function boundedInteger(value,fallback,min,max) { const number=Number(value);return Number.isFinite(number)?Math.max(min,Math.min(max,Math.floor(number))):fallback; }
function mergeTokenUsage(target,usage) { if(!usage||!Number.isFinite(Number(usage.totalTokens)))return;target.promptTokens+=Number(usage.promptTokens||0);target.completionTokens+=Number(usage.completionTokens||0);target.totalTokens+=Number(usage.totalTokens||0);target.available=true; }

export const _internal={buildCatalog,truncateRows,sanitizeThought,sqlHash,intentEvidenceFingerprint,clarifiedEvidenceGap,agentSystemPrompt,agentQuestionPrompt,clarificationContentError,blockingIntentClarification,unresolvableBlockingIntent,completeAccountFallbackRuns,availableAgentTools,suggestCatalogTables,suggestConfirmedRelationPath};
