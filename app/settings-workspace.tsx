"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, getSettings, getTask, reindexEmbeddings, testEmbeddingSettings, testLlmSettings, updateSettings } from "./api";
import { Icon } from "./icons";
import type { BackgroundTask, ConnectionTestResult, QueryPromptKey, QueryPromptMap, SettingsData, SettingsInput } from "./types";

type ConnectionForm = { baseUrl:string; apiKey:string; model:string; dimensions:string };
type RetrievalForm = { vectorEnabled:boolean; topK:string; vectorWeight:string; minSimilarity:string; semanticThreshold:string };
type ProfilingForm = { enabled:boolean; sampleLimit:string; maxTablesPerRefresh:string; timeoutMs:string };
type QueryForm = { semanticQueryPlanMode:"off"|"prefer"|"required"; queryAgentMode:"off"|"prefer"|"required"; queryAgentTrafficPercent:string; queryAgentMaxIterations:string; queryAgentMaxSqlCalls:string; queryAgentMaxScannedRows:string; queryAgentPendingTtlMs:string; queryMaxRows:string; explainMaxRows:string; queryTimeoutMs:string; queryLlmTimeoutMs:string };
type ClaudeQueryForm = { mode:"off"|"prefer"|"required"; trafficPercent:string; binary:string; model:string; promptVersion:string; timeoutMs:string; maxTurns:string; maxBudgetUsd:string; maxConcurrency:string; queueTimeoutMs:string; maxStdioBytes:string };
type OntologyAiForm = { mode:"off"|"review"|"auto_draft"; autoConfirmScore:string; maxTables:string; maxFields:string; timeoutMs:string; criticEnabled:boolean; calibrationMinSamples:string; calibrationMinPrecision:string; maxManualObjectRate:string; maxFailureRate:string; maxP95LatencyMs:string; maxAverageTokens:string };
const PROMPT_KEYS:QueryPromptKey[]=["agentSystem","agentQuestion","legacySqlPlanner","semanticPlanner","resultSummary"];
const EMPTY_PROMPTS=Object.fromEntries(PROMPT_KEYS.map((key)=>[key,""])) as QueryPromptMap;

export function SettingsWorkspace({sourceId,role,onRefresh}:{sourceId?:number;role:string;onRefresh:()=>Promise<void>}){
  const [settings,setSettings]=useState<SettingsData|null>(null);
  const [llm,setLlm]=useState<ConnectionForm>({baseUrl:"",apiKey:"",model:"",dimensions:""});
  const [embedding,setEmbedding]=useState<ConnectionForm>({baseUrl:"",apiKey:"",model:"",dimensions:""});
  const [retrieval,setRetrieval]=useState<RetrievalForm>({vectorEnabled:true,topK:"8",vectorWeight:"0.4",minSimilarity:"0.35",semanticThreshold:"0.55"});
  const [profiling,setProfiling]=useState<ProfilingForm>({enabled:false,sampleLimit:"1000",maxTablesPerRefresh:"20",timeoutMs:"10000"});
  const [query,setQuery]=useState<QueryForm>({semanticQueryPlanMode:"off",queryAgentMode:"off",queryAgentTrafficPercent:"100",queryAgentMaxIterations:"8",queryAgentMaxSqlCalls:"5",queryAgentMaxScannedRows:"5000000",queryAgentPendingTtlMs:"600000",queryMaxRows:"500",explainMaxRows:"1000000",queryTimeoutMs:"30000",queryLlmTimeoutMs:"90000"});
  const [claudeQuery,setClaudeQuery]=useState<ClaudeQueryForm>({mode:"off",trafficPercent:"0",binary:"/app/node_modules/.bin/claude",model:"",promptVersion:"claude-query-v1",timeoutMs:"120000",maxTurns:"12",maxBudgetUsd:"1",maxConcurrency:"2",queueTimeoutMs:"5000",maxStdioBytes:"2097152"});
  const [ontologyAi,setOntologyAi]=useState<OntologyAiForm>({mode:"off",autoConfirmScore:"80",maxTables:"20",maxFields:"600",timeoutMs:"300000",criticEnabled:false,calibrationMinSamples:"40",calibrationMinPrecision:"0.95",maxManualObjectRate:"0.2",maxFailureRate:"0.05",maxP95LatencyMs:"90000",maxAverageTokens:"50000"});
  const [activeTab,setActiveTab]=useState<"runtime"|"prompts">("runtime");
  const [prompts,setPrompts]=useState<QueryPromptMap>(EMPTY_PROMPTS);
  const [promptChanges,setPromptChanges]=useState<Set<QueryPromptKey>>(()=>new Set());
  const [promptResets,setPromptResets]=useState<Set<QueryPromptKey>>(()=>new Set());
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [failure,setFailure]=useState<string|null>(null);
  const [llmTest,setLlmTest]=useState<ConnectionTestResult|null>(null);
  const [embeddingTest,setEmbeddingTest]=useState<ConnectionTestResult|null>(null);
  const [testing,setTesting]=useState<"llm"|"embedding"|null>(null);
  const [task,setTask]=useState<BackgroundTask|null>(null);
  const isAdmin=role==="admin";

  const applySettings=useCallback((next:SettingsData)=>{
    setSettings(next);
    setLlm({baseUrl:next.llm.baseUrl,apiKey:"",model:next.llm.model,dimensions:""});
    setEmbedding({baseUrl:next.embedding.baseUrl,apiKey:"",model:next.embedding.model,dimensions:next.embedding.dimensions==null?"":String(next.embedding.dimensions)});
    setRetrieval({vectorEnabled:next.retrieval.vectorEnabled,topK:String(next.retrieval.topK),vectorWeight:String(next.retrieval.vectorWeight),minSimilarity:String(next.retrieval.minSimilarity),semanticThreshold:String(next.retrieval.semanticThreshold)});
    setProfiling({enabled:next.profiling.enabled,sampleLimit:String(next.profiling.sampleLimit),maxTablesPerRefresh:String(next.profiling.maxTablesPerRefresh),timeoutMs:String(next.profiling.timeoutMs)});
    setQuery({semanticQueryPlanMode:next.query.semanticQueryPlanMode,queryAgentMode:next.query.queryAgentMode,queryAgentTrafficPercent:String(next.query.queryAgentTrafficPercent),queryAgentMaxIterations:String(next.query.queryAgentMaxIterations),queryAgentMaxSqlCalls:String(next.query.queryAgentMaxSqlCalls),queryAgentMaxScannedRows:String(next.query.queryAgentMaxScannedRows),queryAgentPendingTtlMs:String(next.query.queryAgentPendingTtlMs),queryMaxRows:String(next.query.queryMaxRows),explainMaxRows:String(next.query.explainMaxRows),queryTimeoutMs:String(next.query.queryTimeoutMs),queryLlmTimeoutMs:String(next.query.queryLlmTimeoutMs)});
    setClaudeQuery({mode:next.claudeQuery.mode,trafficPercent:String(next.claudeQuery.trafficPercent),binary:next.claudeQuery.binary,model:next.claudeQuery.model,promptVersion:next.claudeQuery.promptVersion,timeoutMs:String(next.claudeQuery.timeoutMs),maxTurns:String(next.claudeQuery.maxTurns),maxBudgetUsd:String(next.claudeQuery.maxBudgetUsd),maxConcurrency:String(next.claudeQuery.maxConcurrency),queueTimeoutMs:String(next.claudeQuery.queueTimeoutMs),maxStdioBytes:String(next.claudeQuery.maxStdioBytes)});
    setOntologyAi({mode:next.ontologyAi.mode,autoConfirmScore:String(next.ontologyAi.autoConfirmScore),maxTables:String(next.ontologyAi.maxTables),maxFields:String(next.ontologyAi.maxFields),timeoutMs:String(next.ontologyAi.timeoutMs),criticEnabled:next.ontologyAi.criticEnabled,calibrationMinSamples:String(next.ontologyAi.calibrationMinSamples),calibrationMinPrecision:String(next.ontologyAi.calibrationMinPrecision),maxManualObjectRate:String(next.ontologyAi.maxManualObjectRate),maxFailureRate:String(next.ontologyAi.maxFailureRate),maxP95LatencyMs:String(next.ontologyAi.maxP95LatencyMs),maxAverageTokens:String(next.ontologyAi.maxAverageTokens)});
    setPrompts(next.prompts);
    setPromptChanges(new Set());
    setPromptResets(new Set());
  },[]);

  useEffect(()=>{let cancelled=false;void getSettings().then((next)=>{if(!cancelled)applySettings(next);}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[applySettings]);

  const reindexing=Boolean(task&&["queued","running"].includes(task.status));
  useEffect(()=>{if(!task||!["queued","running"].includes(task.status))return;let cancelled=false;const timer=window.setTimeout(()=>{void getTask(task.id).then((next)=>{if(cancelled)return;setTask(next);if(next.status==="succeeded"){const result=next.result as unknown as {indexed:number;skipped:number;failed:number;total:number}|null;setMessage(`向量索引重建完成：新建 ${result?.indexed??0}，跳过 ${result?.skipped??0}，失败 ${result?.failed??0}。`);}if(next.status==="failed")setFailure(next.error||"向量索引重建失败");}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});},900);return()=>{cancelled=true;window.clearTimeout(timer);};},[task]);

  async function submit(event:FormEvent){
    event.preventDefault();
    if(!isAdmin)return;
    setSaving(true);setFailure(null);setMessage(null);
    const previousEmbeddingModel=settings?.embedding.model;
    const promptInput:Partial<Record<QueryPromptKey,string|null>>={};
    for(const key of promptChanges)promptInput[key]=prompts[key];
    for(const key of promptResets)promptInput[key]=null;
    const input:SettingsInput={
      llm:{baseUrl:llm.baseUrl.trim(),model:llm.model.trim(),...(llm.apiKey.trim()?{apiKey:llm.apiKey.trim()}:{})},
      embedding:{baseUrl:embedding.baseUrl.trim(),model:embedding.model.trim(),dimensions:embedding.dimensions.trim()?Number(embedding.dimensions):null,...(embedding.apiKey.trim()?{apiKey:embedding.apiKey.trim()}:{})},
      retrieval:{vectorEnabled:retrieval.vectorEnabled,topK:Number(retrieval.topK),vectorWeight:Number(retrieval.vectorWeight),minSimilarity:Number(retrieval.minSimilarity),semanticThreshold:Number(retrieval.semanticThreshold)},
      profiling:{enabled:profiling.enabled,sampleLimit:Number(profiling.sampleLimit),maxTablesPerRefresh:Number(profiling.maxTablesPerRefresh),timeoutMs:Number(profiling.timeoutMs)},
      query:{semanticQueryPlanMode:query.semanticQueryPlanMode,queryAgentMode:query.queryAgentMode,queryAgentTrafficPercent:Number(query.queryAgentTrafficPercent),queryAgentMaxIterations:Number(query.queryAgentMaxIterations),queryAgentMaxSqlCalls:Number(query.queryAgentMaxSqlCalls),queryAgentMaxScannedRows:Number(query.queryAgentMaxScannedRows),queryAgentPendingTtlMs:Number(query.queryAgentPendingTtlMs),queryMaxRows:Number(query.queryMaxRows),explainMaxRows:Number(query.explainMaxRows),queryTimeoutMs:Number(query.queryTimeoutMs),queryLlmTimeoutMs:Number(query.queryLlmTimeoutMs)},
      claudeQuery:{mode:claudeQuery.mode,trafficPercent:Number(claudeQuery.trafficPercent),timeoutMs:Number(claudeQuery.timeoutMs),maxTurns:Number(claudeQuery.maxTurns),maxBudgetUsd:Number(claudeQuery.maxBudgetUsd),maxConcurrency:Number(claudeQuery.maxConcurrency),queueTimeoutMs:Number(claudeQuery.queueTimeoutMs),maxStdioBytes:Number(claudeQuery.maxStdioBytes)},
      ontologyAi:{mode:ontologyAi.mode,autoConfirmScore:Number(ontologyAi.autoConfirmScore),maxTables:Number(ontologyAi.maxTables),maxFields:Number(ontologyAi.maxFields),timeoutMs:Number(ontologyAi.timeoutMs),criticEnabled:ontologyAi.criticEnabled,calibrationMinSamples:Number(ontologyAi.calibrationMinSamples),calibrationMinPrecision:Number(ontologyAi.calibrationMinPrecision),maxManualObjectRate:Number(ontologyAi.maxManualObjectRate),maxFailureRate:Number(ontologyAi.maxFailureRate),maxP95LatencyMs:Number(ontologyAi.maxP95LatencyMs),maxAverageTokens:Number(ontologyAi.maxAverageTokens)},
      ...(Object.keys(promptInput).length?{prompts:promptInput}:{}),
    };
    try{
      const next=await updateSettings(input);
      applySettings(next);
      setMessage(previousEmbeddingModel&&next.embedding.model&&previousEmbeddingModel!==next.embedding.model?"设置已保存并即时生效。Embedding 模型已切换，请重建向量索引。":"设置已保存并即时生效，无需重启服务。");
      await onRefresh();
    }catch(cause){setFailure(errorMessage(cause));}
    finally{setSaving(false);}
  }

  async function testConnection(kind:"llm"|"embedding"){
    setTesting(kind);setFailure(null);
    const form=kind==="llm"?llm:embedding;
    const input={baseUrl:form.baseUrl.trim(),apiKey:form.apiKey.trim(),model:form.model.trim(),...(kind==="embedding"&&form.dimensions.trim()?{dimensions:Number(form.dimensions)}:{})};
    try{const result=kind==="llm"?await testLlmSettings(input):await testEmbeddingSettings(input);(kind==="llm"?setLlmTest:setEmbeddingTest)(result);}
    catch(cause){(kind==="llm"?setLlmTest:setEmbeddingTest)({ok:false,error:errorMessage(cause)});}
    finally{setTesting(null);}
  }

  async function reindex(){
    if(!sourceId)return;
    setFailure(null);setMessage(null);
    try{setTask(await reindexEmbeddings(sourceId));}
    catch(cause){setFailure(errorMessage(cause));}
  }

  function updatePrompt(key:QueryPromptKey,value:string){
    setPrompts((current)=>({...current,[key]:value}));
    setPromptChanges((current)=>new Set(current).add(key));
    setPromptResets((current)=>{const next=new Set(current);next.delete(key);return next;});
  }

  function resetPrompt(key:QueryPromptKey){
    setPrompts((current)=>({...current,[key]:settings?.promptDefaults[key]||""}));
    setPromptChanges((current)=>{const next=new Set(current);next.delete(key);return next;});
    setPromptResets((current)=>new Set(current).add(key));
  }

  if(loading)return <div className="content sub-page"><div className="loading-state"><span className="mini-loader"/><h2>正在读取运行时配置</h2><p>配置来自 SQLite 设置表与环境变量的合并结果。</p></div></div>;
  if(!settings)return <div className="content sub-page"><PageHeader eyebrow="运行时配置" title="设置中心" description="模型、向量检索与查询参数的统一入口。"/><Notice tone="danger" title="无法读取设置" body={failure||"设置读取失败，请确认当前身份具备 admin 角色。"}/></div>;

  return <div className="content sub-page">
    <PageHeader eyebrow="运行时配置" title="设置中心" description="保存后立即生效，无需重启服务；密钥加密存储，仅显示掩码。" action={!isAdmin?<span className="env-pill">当前角色只读</span>:undefined}/>
    {message&&<Notice tone="success" title="操作成功" body={message}/>}
    {failure&&<Notice tone="danger" title="操作失败" body={failure}/>}
    <div className="settings-tabs" role="tablist" aria-label="设置分类">
      <button type="button" role="tab" aria-selected={activeTab==="runtime"} className={activeTab==="runtime"?"active":""} onClick={()=>setActiveTab("runtime")}>运行参数</button>
      <button type="button" role="tab" aria-selected={activeTab==="prompts"} className={activeTab==="prompts"?"active":""} onClick={()=>setActiveTab("prompts")}>提示词</button>
    </div>
    <form onSubmit={submit}>
      {activeTab==="runtime"&&<>
      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>模型配置</h2><p>问数与语义规划使用的 LLM，以及知识检索使用的 Embedding 服务，均为 OpenAI 兼容接口。</p></div></div>
        <div className="settings-group">
          <div className="settings-group-head"><strong>LLM（SQL / 语义规划）</strong>{sourceLabel(settings,"llm.model")}<button type="button" className="secondary-button" onClick={()=>void testConnection("llm")} disabled={testing!==null}>{testing==="llm"?"测试中…":"测试连接"}</button></div>
          {llmTest&&<TestResultRow result={llmTest} kind="llm"/>}
          <div className="form-grid">
            <Field label="Base URL"><input value={llm.baseUrl} disabled={!isAdmin} onChange={(event)=>setLlm({...llm,baseUrl:event.target.value})} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"/></Field>
            <Field label="模型名"><input value={llm.model} disabled={!isAdmin} onChange={(event)=>setLlm({...llm,model:event.target.value})} placeholder="qwen-max"/></Field>
            <Field label={`API Key${settings.llm.apiKey.set?` （已配置 ${settings.llm.apiKey.masked}）`:""}`}><input type="password" autoComplete="off" value={llm.apiKey} disabled={!isAdmin} onChange={(event)=>setLlm({...llm,apiKey:event.target.value})} placeholder={settings.llm.apiKey.set?"留空保持不变":"填写 API Key"}/></Field>
          </div>
        </div>
        <div className="settings-group">
          <div className="settings-group-head"><strong>Embedding（向量检索）</strong>{sourceLabel(settings,"embedding.model")}<button type="button" className="secondary-button" onClick={()=>void testConnection("embedding")} disabled={testing!==null}>{testing==="embedding"?"测试中…":"测试连接"}</button></div>
          {embeddingTest&&<TestResultRow result={embeddingTest} kind="embedding"/>}
          <div className="form-grid">
            <Field label="Base URL"><input value={embedding.baseUrl} disabled={!isAdmin} onChange={(event)=>setEmbedding({...embedding,baseUrl:event.target.value})} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"/></Field>
            <Field label="模型名"><input value={embedding.model} disabled={!isAdmin} onChange={(event)=>setEmbedding({...embedding,model:event.target.value})} placeholder="text-embedding-v3"/></Field>
            <Field label={`API Key${settings.embedding.apiKey.set?` （已配置 ${settings.embedding.apiKey.masked}）`:""}`}><input type="password" autoComplete="off" value={embedding.apiKey} disabled={!isAdmin} onChange={(event)=>setEmbedding({...embedding,apiKey:event.target.value})} placeholder={settings.embedding.apiKey.set?"留空保持不变":"填写 API Key"}/></Field>
            <Field label="向量维度（可选）"><input type="number" min={1} value={embedding.dimensions} disabled={!isAdmin} onChange={(event)=>setEmbedding({...embedding,dimensions:event.target.value})} placeholder="留空使用模型默认"/></Field>
          </div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>向量检索</h2><p>词法与向量分数加权融合；纯向量命中必须超过语义阈值才会参与召回，拒答边界只紧不松。</p></div><button type="button" className="secondary-button" onClick={()=>void reindex()} disabled={!isAdmin||!sourceId||reindexing||!settings.embedding.model}><Icon name="refresh" className={reindexing?"spin":""}/>{reindexing?"重建索引中…":"重建向量索引"}</button></div>
        {reindexing&&task&&<div className="task-progress"><div><span className="mini-loader"/><strong>{task.currentStep||"等待执行"}</strong><em>{task.total?Math.round(task.progress/task.total*100):0}%</em></div><p>知识页与物理表将按当前 Embedding 模型重新向量化；未变更的条目自动跳过。</p><span><i style={{width:`${task.total?Math.round(task.progress/task.total*100):0}%`}}/></span></div>}
        <div className="form-grid">
          <Field label="启用向量检索"><select value={retrieval.vectorEnabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,vectorEnabled:event.target.value==="on"})}><option value="on">启用（未配置 Embedding 时自动降级词法）</option><option value="off">关闭（仅词法检索）</option></select></Field>
          <Field label="Top K 召回数"><input type="number" min={1} max={50} value={retrieval.topK} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,topK:event.target.value})}/></Field>
          <Field label={`向量权重 ${retrieval.vectorWeight}`}><input type="range" min={0} max={1} step={0.05} value={retrieval.vectorWeight} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,vectorWeight:event.target.value})}/></Field>
          <Field label="相似度下限（参与融合）"><input type="number" min={0} max={1} step={0.05} value={retrieval.minSimilarity} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,minSimilarity:event.target.value})}/></Field>
          <Field label="语义阈值（纯向量命中）"><input type="number" min={0} max={1} step={0.05} value={retrieval.semanticThreshold} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,semanticThreshold:event.target.value})}/></Field>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>查询参数</h2><p>作用于问数链路与评测；Agent Loop 和语义 Query Plan 均建议先通过评测再逐步启用。</p></div></div>
        <div className="form-grid">
          <Field label="Agent Loop 模式"><select value={query.queryAgentMode} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryAgentMode:event.target.value as QueryForm["queryAgentMode"]})}><option value="off">off · 保持单发管道</option><option value="prefer">prefer · 管道优先，失败时启用 Loop 探索</option><option value="required">required · 强制工具循环（每次可见执行过程）</option></select></Field>
          <Field label="Agent prefer 灰度比例（%）"><input type="number" min={0} max={100} value={query.queryAgentTrafficPercent} disabled={!isAdmin||query.queryAgentMode!=="prefer"} onChange={(event)=>setQuery({...query,queryAgentTrafficPercent:event.target.value})}/></Field>
          <Field label="语义 Query Plan 模式"><select value={query.semanticQueryPlanMode} disabled={!isAdmin} onChange={(event)=>setQuery({...query,semanticQueryPlanMode:event.target.value as QueryForm["semanticQueryPlanMode"]})}><option value="off">off · 仅 legacy 直出 SQL</option><option value="prefer">prefer · 语义优先，可回退</option><option value="required">required · 强制语义</option></select></Field>
          <Field label="Agent 最大迭代数"><input type="number" min={2} max={20} value={query.queryAgentMaxIterations} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryAgentMaxIterations:event.target.value})}/></Field>
          <Field label="Agent SQL 调用上限"><input type="number" min={1} max={10} value={query.queryAgentMaxSqlCalls} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryAgentMaxSqlCalls:event.target.value})}/></Field>
          <Field label="Agent 累计扫描行预算"><input type="number" min={1} value={query.queryAgentMaxScannedRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryAgentMaxScannedRows:event.target.value})}/></Field>
          <Field label="澄清等待有效期（毫秒）"><input type="number" min={1000} max={3600000} value={query.queryAgentPendingTtlMs} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryAgentPendingTtlMs:event.target.value})}/></Field>
          <Field label="查询返回行数上限"><input type="number" min={1} value={query.queryMaxRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryMaxRows:event.target.value})}/></Field>
          <Field label="EXPLAIN 扫描行阈值"><input type="number" min={1} value={query.explainMaxRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,explainMaxRows:event.target.value})}/></Field>
          <Field label="SQL 执行超时（ms）"><input type="number" min={1000} value={query.queryTimeoutMs} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryTimeoutMs:event.target.value})}/></Field>
          <Field label="LLM 规划超时（ms）"><input type="number" min={1000} value={query.queryLlmTimeoutMs} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryLlmTimeoutMs:event.target.value})}/></Field>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>Claude Code 问数</h2><p>通过受限的 Claude CLI + 请求级 MCP 执行问数。默认关闭；启用前请完成真实环境 preflight 与评测门禁。</p></div></div>
        <div className="form-grid">
          <Field label="Claude 模式"><select value={claudeQuery.mode} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,mode:event.target.value as ClaudeQueryForm["mode"]})}><option value="off">off · 不调用 Claude</option><option value="prefer">prefer · 灰度调用，基础链路可回退</option><option value="required">required · 强制 Claude，失败即拒答</option></select></Field>
          <Field label="Claude 灰度比例（%）"><input type="number" min={0} max={100} value={claudeQuery.trafficPercent} disabled={!isAdmin||claudeQuery.mode!=="prefer"} onChange={(event)=>setClaudeQuery({...claudeQuery,trafficPercent:event.target.value})}/></Field>
          <Field label="模型精确 ID（部署固定）"><input value={claudeQuery.model} disabled readOnly placeholder="通过 CLAUDE_QUERY_MODEL 配置"/></Field>
          <Field label="CLI 路径（部署固定）"><input value={claudeQuery.binary} disabled readOnly/></Field>
          <Field label="Prompt 契约版本（部署固定）"><input value={claudeQuery.promptVersion} disabled readOnly/></Field>
          <Field label="单请求超时（ms）"><input type="number" min={1000} max={600000} value={claudeQuery.timeoutMs} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,timeoutMs:event.target.value})}/></Field>
          <Field label="最大 CLI turns"><input type="number" min={1} max={100} value={claudeQuery.maxTurns} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,maxTurns:event.target.value})}/></Field>
          <Field label="单请求预算（USD）"><input type="number" min={0} max={100} step={0.01} value={claudeQuery.maxBudgetUsd} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,maxBudgetUsd:event.target.value})}/></Field>
          <Field label="最大并发请求"><input type="number" min={1} max={32} value={claudeQuery.maxConcurrency} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,maxConcurrency:event.target.value})}/></Field>
          <Field label="排队超时（ms）"><input type="number" min={0} max={120000} value={claudeQuery.queueTimeoutMs} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,queueTimeoutMs:event.target.value})}/></Field>
          <Field label="CLI 输出上限（bytes）"><input type="number" min={65536} max={16777216} value={claudeQuery.maxStdioBytes} disabled={!isAdmin} onChange={(event)=>setClaudeQuery({...claudeQuery,maxStdioBytes:event.target.value})}/></Field>
        </div>
        <p className="settings-help">Anthropic API Key 和模型精确 ID 只从部署环境变量 ANTHROPIC_API_KEY / CLAUDE_QUERY_MODEL 注入，不会保存或显示在这里。CLI 路径、模型和契约版本需要重新部署后变更。</p>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>证据画像与 AI 本体建模</h2><p>画像仅采集 A/B 级表的脱敏列级聚合；critic 只会把不一致候选降级到人工审核。</p></div></div>
        <div className="form-grid">
          <Field label="启用列值画像"><select value={profiling.enabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,enabled:event.target.value==="on"})}><option value="off">关闭（默认）</option><option value="on">启用脱敏画像</option></select></Field>
          <Field label="每列采样上限"><input type="number" min={1} max={1000} value={profiling.sampleLimit} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,sampleLimit:event.target.value})}/></Field>
          <Field label="每轮画像表数"><input type="number" min={1} max={1000} value={profiling.maxTablesPerRefresh} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,maxTablesPerRefresh:event.target.value})}/></Field>
          <Field label="画像查询超时（ms）"><input type="number" min={100} max={120000} value={profiling.timeoutMs} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,timeoutMs:event.target.value})}/></Field>
          <Field label="建模模式"><select value={ontologyAi.mode} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,mode:event.target.value as OntologyAiForm["mode"]})}><option value="off">off · 关闭生成</option><option value="review">review · 全量人工确认</option><option value="auto_draft" disabled={ontologyAi.mode!=="auto_draft"}>auto_draft · 已通过门禁</option></select></Field>
          <Field label="生成后 critic"><select value={ontologyAi.criticEnabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,criticEnabled:event.target.value==="on"})}><option value="off">关闭</option><option value="on">启用（矛盾项强制人审）</option></select></Field>
          <Field label="自动确认分数"><input type="number" min={0} max={100} value={ontologyAi.autoConfirmScore} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,autoConfirmScore:event.target.value})}/></Field>
          <Field label="单批表数上限"><input type="number" min={1} max={20} value={ontologyAi.maxTables} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxTables:event.target.value})}/></Field>
          <Field label="单批字段上限"><input type="number" min={1} max={600} value={ontologyAi.maxFields} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxFields:event.target.value})}/></Field>
          <Field label="模型调用超时（ms）"><input type="number" min={1000} max={600000} value={ontologyAi.timeoutMs} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,timeoutMs:event.target.value})}/></Field>
          <Field label="双检最小样本"><input type="number" min={1} value={ontologyAi.calibrationMinSamples} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,calibrationMinSamples:event.target.value})}/></Field>
          <Field label="最低准确率"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.calibrationMinPrecision} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,calibrationMinPrecision:event.target.value})}/></Field>
          <Field label="人工补录率上限"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.maxManualObjectRate} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxManualObjectRate:event.target.value})}/></Field>
          <Field label="生成失败率上限"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.maxFailureRate} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxFailureRate:event.target.value})}/></Field>
          <Field label="P95 延迟上限（ms）"><input type="number" min={1000} max={600000} value={ontologyAi.maxP95LatencyMs} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxP95LatencyMs:event.target.value})}/></Field>
          <Field label="批次平均 Token 上限"><input type="number" min={1} value={ontologyAi.maxAverageTokens} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxAverageTokens:event.target.value})}/></Field>
        </div>
      </section>
      </>}

      {activeTab==="prompts"&&<section className="panel settings-panel prompt-settings-panel">
        <div className="panel-title"><div><h2>查询链路提示词</h2><p>按步骤自定义模型指令。变量使用双花括号语法；保存时会校验必需变量，修改后立即用于新查询。</p></div></div>
        <div className="prompt-editor-list">
          {PROMPT_KEYS.map((key)=>{const meta=settings.promptMeta[key];return <article className="prompt-editor" key={key}>
            <header>
              <div><strong>{meta.label}</strong>{sourceLabel(settings,`prompts.${key}`)}</div>
              <button type="button" className="secondary-button" disabled={!isAdmin} onClick={()=>resetPrompt(key)}>恢复默认</button>
            </header>
            <p>{meta.description}</p>
            <div className="prompt-variables"><span>必需变量</span>{meta.variables.map((variable)=><code key={variable}>{`{{${variable}}}`}</code>)}</div>
            <textarea aria-label={meta.label} value={prompts[key]} disabled={!isAdmin} rows={key==="agentQuestion"?6:14} spellCheck={false} onChange={(event)=>updatePrompt(key,event.target.value)}/>
          </article>;})}
        </div>
      </section>}

      <div className="editor-actions settings-actions">
        <button type="submit" className="primary-button" disabled={!isAdmin||saving}>{saving?"保存中…":activeTab==="prompts"?"保存提示词":"保存全部设置"}</button>
      </div>
    </form>
  </div>;
}

function TestResultRow({result,kind}:{result:ConnectionTestResult;kind:"llm"|"embedding"}){
  if(!result.ok)return <Notice tone="danger" title={kind==="llm"?"LLM 连接失败":"Embedding 连接失败"} body={result.error||"未知错误"}/>;
  return <Notice tone="success" title={kind==="llm"?"LLM 连接正常":"Embedding 连接正常"} body={kind==="llm"?`模型 ${result.model} · 延迟 ${result.latencyMs}ms`:`实测维度 ${result.dimensions} · 延迟 ${result.latencyMs}ms`}/>;
}

function sourceLabel(settings:SettingsData,key:string){
  const source=settings.sources[key];
  if(source==="db")return <small className="settings-source">已在线配置</small>;
  if(source==="env")return <small className="settings-source">来自环境变量</small>;
  if(source==="override")return <small className="settings-source">由启动参数固定</small>;
  return <small className="settings-source">默认值</small>;
}

function PageHeader({eyebrow,title,description,action}:{eyebrow:string;title:string;description:string;action?:React.ReactNode}){return <div className="page-header"><div><span className="section-kicker">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;}
function Notice({tone,title,body}:{tone:"success"|"danger";title:string;body:string}){return <div className={`notice ${tone}`}><Icon name={tone==="success"?"check":"shield"}/><div><strong>{title}</strong><span>{body}</span></div></div>;}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="form-field"><span>{label}</span>{children}</label>;}
function errorMessage(error:unknown){return error instanceof ApiError&&error.detail?`${error.message}：${error.detail}`:error instanceof Error?error.message:"发生未知错误";}
