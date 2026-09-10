"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, getSettings, getTask, reindexEmbeddings, testEmbeddingSettings, testLlmSettings, updateSettings } from "./api";
import { Icon } from "./icons";
import type { BackgroundTask, ConnectionTestResult, SettingsData, SettingsInput } from "./types";

type ConnectionForm = { baseUrl:string; apiKey:string; model:string; dimensions:string };
type RetrievalForm = { vectorEnabled:boolean; vectorWeight:string; minSimilarity:string; semanticThreshold:string };
type ProfilingForm = { enabled:boolean; sampleLimit:string; maxTablesPerRefresh:string; timeoutMs:string };
type QueryForm = { queryMaxSqlCalls:string; queryMaxScannedRows:string; queryPendingTtlMs:string; queryMaxRows:string; explainMaxRows:string; queryTimeoutMs:string };
type ClaudeQueryForm = { binary:string; model:string; promptVersion:string; timeoutMs:string; maxTurns:string; maxBudgetUsd:string; maxConcurrency:string; queueTimeoutMs:string; maxStdioBytes:string };
type OntologyAiForm = { mode:"off"|"review"|"auto_draft"; autoConfirmScore:string; maxTables:string; maxFields:string; timeoutMs:string; criticEnabled:boolean; calibrationMinSamples:string; calibrationMinPrecision:string; maxManualObjectRate:string; maxFailureRate:string; maxP95LatencyMs:string; maxAverageTokens:string };

export function SettingsWorkspace({sourceId,role,onRefresh}:{sourceId?:number;role:string;onRefresh:()=>Promise<void>}){
  const [settings,setSettings]=useState<SettingsData|null>(null);
  const [llm,setLlm]=useState<ConnectionForm>({baseUrl:"",apiKey:"",model:"",dimensions:""});
  const [embedding,setEmbedding]=useState<ConnectionForm>({baseUrl:"",apiKey:"",model:"",dimensions:""});
  const [retrieval,setRetrieval]=useState<RetrievalForm>({vectorEnabled:true,vectorWeight:"0.4",minSimilarity:"0.35",semanticThreshold:"0.55"});
  const [profiling,setProfiling]=useState<ProfilingForm>({enabled:false,sampleLimit:"1000",maxTablesPerRefresh:"20",timeoutMs:"10000"});
  const [query,setQuery]=useState<QueryForm>({queryMaxSqlCalls:"5",queryMaxScannedRows:"5000000",queryPendingTtlMs:"600000",queryMaxRows:"500",explainMaxRows:"1000000",queryTimeoutMs:"30000"});
  const [claudeQuery,setClaudeQuery]=useState<ClaudeQueryForm>({binary:"/app/node_modules/.bin/claude",model:"",promptVersion:"claude-query-v1",timeoutMs:"120000",maxTurns:"12",maxBudgetUsd:"1",maxConcurrency:"2",queueTimeoutMs:"5000",maxStdioBytes:"2097152"});
  const [ontologyAi,setOntologyAi]=useState<OntologyAiForm>({mode:"off",autoConfirmScore:"85",maxTables:"20",maxFields:"600",timeoutMs:"300000",criticEnabled:false,calibrationMinSamples:"40",calibrationMinPrecision:"0.95",maxManualObjectRate:"0.2",maxFailureRate:"0.05",maxP95LatencyMs:"90000",maxAverageTokens:"50000"});
  const [activeTab,setActiveTab]=useState<"runtime"|"compatibility">("runtime");
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
    setRetrieval({vectorEnabled:next.retrieval.vectorEnabled,vectorWeight:String(next.retrieval.vectorWeight),minSimilarity:String(next.retrieval.minSimilarity),semanticThreshold:String(next.retrieval.semanticThreshold)});
    setProfiling({enabled:next.profiling.enabled,sampleLimit:String(next.profiling.sampleLimit),maxTablesPerRefresh:String(next.profiling.maxTablesPerRefresh),timeoutMs:String(next.profiling.timeoutMs)});
    setQuery({queryMaxSqlCalls:String(next.query.queryMaxSqlCalls),queryMaxScannedRows:String(next.query.queryMaxScannedRows),queryPendingTtlMs:String(next.query.queryPendingTtlMs),queryMaxRows:String(next.query.queryMaxRows),explainMaxRows:String(next.query.explainMaxRows),queryTimeoutMs:String(next.query.queryTimeoutMs)});
    setClaudeQuery({binary:next.claudeQuery.binary,model:next.claudeQuery.model,promptVersion:next.claudeQuery.promptVersion,timeoutMs:String(next.claudeQuery.timeoutMs),maxTurns:String(next.claudeQuery.maxTurns),maxBudgetUsd:String(next.claudeQuery.maxBudgetUsd),maxConcurrency:String(next.claudeQuery.maxConcurrency),queueTimeoutMs:String(next.claudeQuery.queueTimeoutMs),maxStdioBytes:String(next.claudeQuery.maxStdioBytes)});
    setOntologyAi({mode:next.ontologyAi.mode,autoConfirmScore:String(next.ontologyAi.autoConfirmScore),maxTables:String(next.ontologyAi.maxTables),maxFields:String(next.ontologyAi.maxFields),timeoutMs:String(next.ontologyAi.timeoutMs),criticEnabled:next.ontologyAi.criticEnabled,calibrationMinSamples:String(next.ontologyAi.calibrationMinSamples),calibrationMinPrecision:String(next.ontologyAi.calibrationMinPrecision),maxManualObjectRate:String(next.ontologyAi.maxManualObjectRate),maxFailureRate:String(next.ontologyAi.maxFailureRate),maxP95LatencyMs:String(next.ontologyAi.maxP95LatencyMs),maxAverageTokens:String(next.ontologyAi.maxAverageTokens)});
  },[]);

  useEffect(()=>{let cancelled=false;void getSettings().then((next)=>{if(!cancelled)applySettings(next);}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[applySettings]);

  const reindexing=Boolean(task&&["queued","running"].includes(task.status));
  useEffect(()=>{if(!task||!["queued","running"].includes(task.status))return;let cancelled=false;const timer=window.setTimeout(()=>{void getTask(task.id).then((next)=>{if(cancelled)return;setTask(next);if(next.status==="succeeded"){const result=next.result as unknown as {indexed:number;skipped:number;failed:number;total:number}|null;setMessage(`向量索引重建完成：新建 ${result?.indexed??0}，跳过 ${result?.skipped??0}，失败 ${result?.failed??0}。`);}if(next.status==="failed")setFailure(next.error||"向量索引重建失败");}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});},900);return()=>{cancelled=true;window.clearTimeout(timer);};},[task]);

  async function submit(event:FormEvent){
    event.preventDefault();
    if(!isAdmin)return;
    setSaving(true);setFailure(null);setMessage(null);
    const previousEmbeddingModel=settings?.embedding.model;
    const input:SettingsInput=activeTab==="compatibility"?{
      retrieval:{vectorWeight:Number(retrieval.vectorWeight),minSimilarity:Number(retrieval.minSimilarity),semanticThreshold:Number(retrieval.semanticThreshold)},
    }:{
      llm:{baseUrl:llm.baseUrl.trim(),model:llm.model.trim(),...(llm.apiKey.trim()?{apiKey:llm.apiKey.trim()}:{})},
      embedding:{baseUrl:embedding.baseUrl.trim(),model:embedding.model.trim(),dimensions:embedding.dimensions.trim()?Number(embedding.dimensions):null,...(embedding.apiKey.trim()?{apiKey:embedding.apiKey.trim()}:{})},
      retrieval:{vectorEnabled:retrieval.vectorEnabled},
      profiling:{enabled:profiling.enabled,sampleLimit:Number(profiling.sampleLimit),maxTablesPerRefresh:Number(profiling.maxTablesPerRefresh),timeoutMs:Number(profiling.timeoutMs)},
      query:{queryMaxSqlCalls:Number(query.queryMaxSqlCalls),queryMaxScannedRows:Number(query.queryMaxScannedRows),queryPendingTtlMs:Number(query.queryPendingTtlMs),queryMaxRows:Number(query.queryMaxRows),explainMaxRows:Number(query.explainMaxRows),queryTimeoutMs:Number(query.queryTimeoutMs)},
      claudeQuery:{timeoutMs:Number(claudeQuery.timeoutMs),maxTurns:Number(claudeQuery.maxTurns),maxBudgetUsd:Number(claudeQuery.maxBudgetUsd),maxConcurrency:Number(claudeQuery.maxConcurrency),queueTimeoutMs:Number(claudeQuery.queueTimeoutMs),maxStdioBytes:Number(claudeQuery.maxStdioBytes)},
      ontologyAi:{mode:ontologyAi.mode,autoConfirmScore:Number(ontologyAi.autoConfirmScore),maxTables:Number(ontologyAi.maxTables),maxFields:Number(ontologyAi.maxFields),timeoutMs:Number(ontologyAi.timeoutMs),criticEnabled:ontologyAi.criticEnabled,calibrationMinSamples:Number(ontologyAi.calibrationMinSamples),calibrationMinPrecision:Number(ontologyAi.calibrationMinPrecision),maxManualObjectRate:Number(ontologyAi.maxManualObjectRate),maxFailureRate:Number(ontologyAi.maxFailureRate),maxP95LatencyMs:Number(ontologyAi.maxP95LatencyMs),maxAverageTokens:Number(ontologyAi.maxAverageTokens)},
    };
    try{
      const next=await updateSettings(input);
      applySettings(next);
      setMessage(previousEmbeddingModel&&next.embedding.model&&previousEmbeddingModel!==next.embedding.model?"设置已保存。Embedding 模型已切换，请重建向量索引。":"当前分类的设置已保存。");
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

  if(loading)return <div className="content sub-page"><div className="loading-state"><span className="mini-loader"/><h2>正在读取运行时配置</h2><p>配置来自 SQLite 设置表与环境变量的合并结果。</p></div></div>;
  if(!settings)return <div className="content sub-page"><PageHeader eyebrow="运行时配置" title="设置中心" description="模型、向量检索与查询参数的统一入口。"/><Notice tone="danger" title="无法读取设置" body={failure||"设置读取失败，请确认当前身份具备 admin 角色。"}/></div>;

  return <div className="content sub-page">
    <PageHeader eyebrow="运行时配置" title="设置中心" description="管理 Claude 问数、本体建模与知识索引；密钥加密存储，仅显示掩码。" action={!isAdmin?<span className="env-pill">当前角色只读</span>:undefined}/>
    {message&&<Notice tone="success" title="操作成功" body={message}/>}
    {failure&&<Notice tone="danger" title="操作失败" body={failure}/>}
    <div className="settings-tabs" role="tablist" aria-label="设置分类">
      <button type="button" role="tab" aria-selected={activeTab==="runtime"} className={activeTab==="runtime"?"active":""} onClick={()=>setActiveTab("runtime")}>运行参数</button>
      <button type="button" role="tab" aria-selected={activeTab==="compatibility"} className={activeTab==="compatibility"?"active":""} onClick={()=>setActiveTab("compatibility")}>兼容引擎与评测</button>
    </div>
    <form onSubmit={submit}>
      {activeTab==="runtime"&&<>
      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>本体与知识模型</h2><p>LLM 用于本体建模、关系发现和知识建议，Embedding 用于知识索引与本体匹配。Claude 问数使用下方独立配置。</p></div></div>
        <div className="settings-group">
          <div className="settings-group-head"><strong>LLM（本体与知识）</strong>{sourceLabel(settings,"llm.model")}<button type="button" className="secondary-button" onClick={()=>void testConnection("llm")} disabled={testing!==null}>{testing==="llm"?"测试中…":"测试连接"}</button></div>
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
        <div className="panel-title"><div><h2>知识向量索引</h2><p>供本体匹配和兼容引擎检索使用。Claude 通过工具读取本体和业务知识。</p></div><button type="button" className="secondary-button" onClick={()=>void reindex()} disabled={!isAdmin||!sourceId||reindexing||!settings.embedding.model}><Icon name="refresh" className={reindexing?"spin":""}/>{reindexing?"重建索引中…":"重建向量索引"}</button></div>
        {reindexing&&task&&<div className="task-progress"><div><span className="mini-loader"/><strong>{task.currentStep||"等待执行"}</strong><em>{task.total?Math.round(task.progress/task.total*100):0}%</em></div><p>知识页与物理表将按当前 Embedding 模型重新向量化；未变更的条目自动跳过。</p><span><i style={{width:`${task.total?Math.round(task.progress/task.total*100):0}%`}}/></span></div>}
        <div className="form-grid">
          <Field label="启用向量索引"><select value={retrieval.vectorEnabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,vectorEnabled:event.target.value==="on"})}><option value="on">启用（需要配置 Embedding）</option><option value="off">关闭</option></select></Field>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>查询执行与 ASK</h2><p>Claude 问数和兼容引擎共用的 SQL 资源限制与澄清等待时间。</p></div></div>
        <div className="form-grid">
          <Field label="每轮 SQL 调用上限"><input type="number" min={1} max={10} value={query.queryMaxSqlCalls} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryMaxSqlCalls:event.target.value})}/></Field>
          <Field label="累计扫描行预算"><input type="number" min={1} value={query.queryMaxScannedRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryMaxScannedRows:event.target.value})}/></Field>
          <Field label="澄清等待有效期（毫秒）"><input type="number" min={1000} max={3600000} value={query.queryPendingTtlMs} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryPendingTtlMs:event.target.value})}/></Field>
          <Field label="查询返回行数上限"><input type="number" min={1} value={query.queryMaxRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryMaxRows:event.target.value})}/></Field>
          <Field label="EXPLAIN 扫描行阈值"><input type="number" min={1} value={query.explainMaxRows} disabled={!isAdmin} onChange={(event)=>setQuery({...query,explainMaxRows:event.target.value})}/></Field>
          <Field label="SQL 执行超时（ms）"><input type="number" min={1000} value={query.queryTimeoutMs} disabled={!isAdmin} onChange={(event)=>setQuery({...query,queryTimeoutMs:event.target.value})}/></Field>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-title"><div><h2>智能问数</h2><p>依据本体和业务知识生成 SQL、调用查询工具并回答；最大轮数和请求超时在此配置。</p></div></div>
        <div className="form-grid">
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
        <p className="settings-help">   API Key 仅从部署环境注入，不在页面显示。CLI 路径、模型和契约版本显示部署值，变更需重新部署。</p>
      </section>

      <section className="panel settings-panel ontology-build-settings">
        <div className="panel-title"><div><h2>本体构建设置</h2><p>选择数据表后自动生成业务对象与关系，达到设定分数的候选自动确认。</p></div></div>
        <div className="form-grid">
          <Field label="确认方式"><select value={ontologyAi.mode} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,mode:event.target.value as OntologyAiForm["mode"]})}><option value="auto_draft">达到分数自动确认</option><option value="review">全部人工确认</option><option value="off">关闭本体生成</option></select></Field>
          <Field label="自动确认分数"><input type="number" min={0} max={100} value={ontologyAi.autoConfirmScore} disabled={!isAdmin||ontologyAi.mode!=="auto_draft"} onChange={(event)=>setOntologyAi({...ontologyAi,autoConfirmScore:event.target.value})}/></Field>
        </div>
        <p className="settings-help">{ontologyAi.mode==="auto_draft"?`${ontologyAi.autoConfirmScore} 分及以上且结构校验通过的候选自动确认；低分项集中待处理。`:ontologyAi.mode==="review"?"所有候选生成后都需要人工确认。":"当前已关闭本体生成。"} 修改对新建批次生效。</p>
        <details className="settings-advanced">
          <summary>高级设置 · 批次、超时与采样</summary>
          <p className="settings-help">系统按表结构自动分批，无需日常调整。只有遇到模型容量或耗时问题时，才需要修改下面的运行上限。</p>
          <div className="form-grid">
            <Field label="单批表数上限"><input type="number" min={1} max={20} value={ontologyAi.maxTables} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxTables:event.target.value})}/></Field>
            <Field label="单批字段上限"><input type="number" min={1} max={600} value={ontologyAi.maxFields} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxFields:event.target.value})}/></Field>
            <Field label="模型调用超时（ms）"><input type="number" min={1000} max={600000} value={ontologyAi.timeoutMs} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,timeoutMs:event.target.value})}/></Field>
            <Field label="列值画像"><select value={profiling.enabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,enabled:event.target.value==="on"})}><option value="off">关闭</option><option value="on">采样字段取值辅助建模</option></select></Field>
            <Field label="生成后 AI 复核"><select value={ontologyAi.criticEnabled?"on":"off"} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,criticEnabled:event.target.value==="on"})}><option value="off">关闭</option><option value="on">启用（矛盾项降分待处理）</option></select></Field>
            {profiling.enabled&&<>
              <Field label="每列采样上限"><input type="number" min={1} max={1000} value={profiling.sampleLimit} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,sampleLimit:event.target.value})}/></Field>
              <Field label="每轮画像表数"><input type="number" min={1} max={1000} value={profiling.maxTablesPerRefresh} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,maxTablesPerRefresh:event.target.value})}/></Field>
              <Field label="画像查询超时（ms）"><input type="number" min={100} max={120000} value={profiling.timeoutMs} disabled={!isAdmin} onChange={(event)=>setProfiling({...profiling,timeoutMs:event.target.value})}/></Field>
            </>}
          </div>
        </details>
        <details className="settings-advanced">
          <summary>质量校准参数 · 可选</summary>
          <p className="settings-help">用于评估自动确认的准确率和运行质量，校准结果不会改变上面选择的确认方式。</p>
          <div className="form-grid">
            <Field label="双检最小样本"><input type="number" min={1} value={ontologyAi.calibrationMinSamples} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,calibrationMinSamples:event.target.value})}/></Field>
            <Field label="最低准确率"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.calibrationMinPrecision} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,calibrationMinPrecision:event.target.value})}/></Field>
            <Field label="人工补录率上限"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.maxManualObjectRate} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxManualObjectRate:event.target.value})}/></Field>
            <Field label="生成失败率上限"><input type="number" min={0} max={1} step={0.01} value={ontologyAi.maxFailureRate} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxFailureRate:event.target.value})}/></Field>
            <Field label="P95 延迟上限（ms）"><input type="number" min={1000} max={600000} value={ontologyAi.maxP95LatencyMs} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxP95LatencyMs:event.target.value})}/></Field>
            <Field label="批次平均 Token 上限"><input type="number" min={1} value={ontologyAi.maxAverageTokens} disabled={!isAdmin} onChange={(event)=>setOntologyAi({...ontologyAi,maxAverageTokens:event.target.value})}/></Field>
          </div>
        </details>
      </section>
      </>}

      {activeTab==="compatibility"&&<section className="panel settings-panel">
        <div className="panel-title"><div><h2>检索加权</h2><p>向量与词法检索的融合权重及命中阈值。Claude 问数从工具读取本体与知识，不在此路径内。</p></div></div>
        <div className="form-grid">
          <Field label={`向量权重 ${retrieval.vectorWeight}`}><input type="range" min={0} max={1} step={0.05} value={retrieval.vectorWeight} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,vectorWeight:event.target.value})}/></Field>
          <Field label="相似度下限（参与融合）"><input type="number" min={0} max={1} step={0.05} value={retrieval.minSimilarity} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,minSimilarity:event.target.value})}/></Field>
          <Field label="语义阈值（纯向量命中）"><input type="number" min={0} max={1} step={0.05} value={retrieval.semanticThreshold} disabled={!isAdmin} onChange={(event)=>setRetrieval({...retrieval,semanticThreshold:event.target.value})}/></Field>
        </div>
      </section>}

      <div className="editor-actions settings-actions">
        <button type="submit" className="primary-button" disabled={!isAdmin||saving}>{saving?"保存中…":"保存当前分类"}</button>
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
