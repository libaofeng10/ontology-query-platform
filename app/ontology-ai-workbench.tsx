"use client";

import { useEffect, useState } from "react";
import { getOntologyBuildRecord, getOntologyGenerationTrace, listOntologyGenerationTraces } from "./api";
import { Icon } from "./icons";
import { formatDate, phaseLabel } from "./ontology-workspace-shared";
import type { OntologyBuildRecord, OntologyGenerationTraceDetail, OntologyGenerationTraceSummary, SourceOntologyBuildStatus } from "./types";

export function OntologyExecutionRecords({sourceId,status,canInspect,onResolve,onVersion}:{sourceId:number;status:SourceOntologyBuildStatus;canInspect:boolean;onResolve:()=>void;onVersion:(id:number)=>void}) {
  const [selected,setSelected]=useState<string|null>(null);
  const id=selected||status.update?.id||status.history[0]?.id;
  return <section>
    <div className="ontology-page-intro"><h3>执行记录</h3><p>一次更新，一条记录。查看整理进度、处理结果和模型调用。</p></div>
    {!id?<p className="ontology-simple-empty">还没有更新记录。选择数据表后，执行过程会显示在这里。</p>:<>
      <label className="ontology-record-picker">查看更新<select value={id} onChange={(event)=>setSelected(event.target.value)}>{status.history.map((item)=><option value={item.id} key={item.id}>{formatDate(item.createdAt)} · {item.selectedTableCount==null?"业务定义更新":`${item.selectedTableCount} 张表`} · {phaseLabel(item.id===status.update?.id?status.update.phase:item.phase)}</option>)}</select></label>
      <ExecutionDetail key={`${sourceId}:${id}`} sourceId={sourceId} id={id} canInspect={canInspect} currentId={status.update?.id} onResolve={onResolve} onVersion={onVersion} versions={status.versions}/>
    </>}
  </section>;
}

function ExecutionDetail({sourceId,id,canInspect,currentId,onResolve,onVersion,versions}:{sourceId:number;id:string;canInspect:boolean;currentId?:string;onResolve:()=>void;onVersion:(id:number)=>void;versions:SourceOntologyBuildStatus["versions"]}) {
  const [record,setRecord]=useState<OntologyBuildRecord|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      try{const next=await getOntologyBuildRecord(sourceId,id);if(cancelled)return;setRecord(next);setError(null);if(next.busy)timer=setTimeout(()=>void refresh(),2000);}
      catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:"读取执行记录失败");}
    }
    void refresh();return()=>{cancelled=true;clearTimeout(timer);};
  },[sourceId,id,retry]);
  const version=versions.find((item)=>item.id===record?.versionId);
  return <>
    {error&&<p className="ontology-inline-error" role="alert">{error} <button className="ontology-text-button" onClick={()=>setRetry((value)=>value+1)}>重新读取</button></p>}
    {!record&&!error&&<p className="ontology-simple-empty" role="status">正在读取本次执行…</p>}
    {record&&<>
      <section className="ontology-record-summary">
        <span className={`ontology-status ${record.phase}`}>{phaseLabel(record.phase)}</span>
        <h3>{record.summary|| (record.busy?record.currentStep:null)|| (record.legacy?"历史生成过程已保留":"本次业务定义更新")}</h3>
        <p>{formatDate(record.createdAt)} · {record.tableNames.length} 张数据表{record.finishedAt&&` · 结束于 ${formatDate(record.finishedAt)}`}</p>
        {record.busy&&<progress aria-label="本次更新进度" value={record.progress} max={100}/>}
        {record.legacy&&<p>这是旧流程的生成记录。当前用于问数的定义以“本体结果”为准。</p>}
        {version&&<button className="ontology-text-button" onClick={()=>onVersion(version.id)}>查看本次版本 v{version.version} <Icon name="arrow" size={14}/></button>}
        <details className="ontology-plain-details"><summary>查看涉及的数据表</summary><p className="ontology-table-names">{record.tableNames.join("、")||"未记录表范围"}</p></details>
      </section>
      {(!!record.questions.length||record.error||record.phase==="awaiting_change")&&<section className="ontology-clarifications">
        <h3>{record.id===currentId?"需要处理":"当时遇到的问题"}</h3>
        {record.error&&<p>{record.error}</p>}
        {record.questions.map((question)=><p key={question.id}><strong>{question.title}</strong>：{question.detail}</p>)}
        {record.phase==="awaiting_change"&&<p>本次更新涉及已有业务定义变化，等待确认变化范围。</p>}
        {record.id===currentId&&<button className="primary-button" onClick={onResolve}>去处理本次更新</button>}
      </section>}
      {!!record.events.length&&<section className="ontology-stage-section"><h3>处理过程</h3><ol className="ontology-stage-list">{record.events.map((event,index)=>{
        const last=index===record.events.length-1;
        const paused=last&&!["ready","unchanged"].includes(record.phase);
        return <li key={`${event.at}:${index}`}><span className={paused?"active":"done"}>{paused?"·":"✓"}</span><div><strong>{event.label}</strong><time>{formatDate(event.at)}</time></div>{last&&record.busy&&<small>进行中</small>}</li>;
      })}</ol></section>}
      <div className="ontology-section-heading"><h3>模型处理明细</h3><span>{record.runs.length} 项</span></div>
      <p className="ontology-section-copy">以下是模型的处理记录，无需逐项确认。</p>
      <div className="ontology-run-list">{record.runs.map((run)=><article key={run.id}>
        <div className="ontology-run-heading"><div><strong>{run.name}</strong><p>{run.tableNames.length} 张表 · {run.objectCount} 个对象 · {run.linkCount} 条关系{run.modelName&&` · ${run.modelName}`}</p></div><span className={`ontology-status ${run.status}`}>{runStatus(run.status)}{["queued","running"].includes(run.status)&&` ${run.progress}%`}</span></div>
        {run.error&&<p className="ontology-inline-error">{run.error}</p>}
        <details className="ontology-plain-details"><summary>数据范围</summary><p className="ontology-table-names">{run.tableNames.join("、")}</p></details>
        {canInspect&&<ModelCalls runId={run.id} busy={record.busy}/>}
      </article>)}</div>
      {!record.runs.length&&<p className="ontology-simple-empty">{record.busy?"正在准备，模型处理记录会自动显示。":"本次更新没有模型生成调用。业务说明修改、沿用结果等操作会直接检查已有定义。"}</p>}
    </>}
  </>;
}

function ModelCalls({runId,busy}:{runId:string;busy:boolean}) {
  const [open,setOpen]=useState(false),[items,setItems]=useState<OntologyGenerationTraceSummary[]|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function read(){try{const result=await listOntologyGenerationTraces(runId);if(cancelled)return;setItems(result);setError(null);if(busy)timer=setTimeout(()=>void read(),3000);}catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:"读取模型调用失败");}}
    void read();return()=>{cancelled=true;clearTimeout(timer);};
  },[runId,open,busy,retry]);
  return <details className="ontology-model-calls" onToggle={(event)=>setOpen(event.currentTarget.open)}><summary>模型调用{items?` · ${items.length} 次`:""}</summary>
    {error&&<p className="ontology-inline-error" role="alert">{error} <button className="ontology-text-button" onClick={()=>setRetry((value)=>value+1)}>重试</button></p>}
    {!items&&!error&&<p role="status">正在读取调用记录…</p>}
    {items?.map((item,index)=><div className="ontology-call" key={item.fileName}><button className="ontology-call-button" aria-expanded={selected===item.fileName} onClick={()=>setSelected(selected===item.fileName?null:item.fileName)}><span>调用 {index+1} · {callLabel(item.fileName)}</span><small>{(item.durationMs/1000).toFixed(1)} 秒 · {item.error?"失败":"完成"}</small><Icon name="down" size={14}/></button>
      {selected===item.fileName&&<CallDetail key={item.fileName} runId={runId} fileName={item.fileName}/>}
    </div>)}
    {items?.length===0&&<p>暂无可读取的模型调用记录。</p>}
  </details>;
}
function CallDetail({runId,fileName}:{runId:string;fileName:string}) {
  const [detail,setDetail]=useState<OntologyGenerationTraceDetail|null>(null),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let cancelled=false;void getOntologyGenerationTrace(runId,fileName).then((value)=>{if(!cancelled)setDetail(value);}).catch((cause)=>{if(!cancelled)setError(cause instanceof Error?cause.message:"读取调用详情失败");});return()=>{cancelled=true;};},[runId,fileName]);
  if(error)return <p className="ontology-inline-error" role="alert">{error}</p>;
  if(!detail)return <p role="status">正在读取模型输入和输出…</p>;
  return <div className="ontology-call-detail">{detail.error&&<p className="ontology-inline-error">{detail.error}</p>}<h4>模型收到的内容</h4>{detail.messages.map((message,index)=><pre key={index}>{message.content}</pre>)}<h4>模型返回的内容</h4><pre>{typeof detail.rawOutput==="string"?detail.rawOutput:JSON.stringify(detail.rawOutput,null,2)}</pre></div>;
}
function runStatus(status:OntologyBuildRecord["runs"][number]["status"]){return ({queued:"等待处理",running:"处理中",succeeded:"已完成",failed:"未完成",cancelled:"已取消"})[status];}
function callLabel(fileName:string){const base=fileName.startsWith("object")?"整理业务对象":fileName.startsWith("link")?"整理业务关系":"业务分析";return fileName.includes("repair")?`${base} · 自动修正`:base;}
