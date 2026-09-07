"use client";

import { useEffect, useState } from "react";
import { getOntologySchema, getOntologySchemaDiff, rollbackOntologySchema } from "./api";
import { OntologyDefinitionList } from "./ontology-definition-list";
import { ChangeList, formatDate } from "./ontology-workspace-shared";
import type { SemanticSchemaDiff, SemanticSchemaVersion, SourceOntologyBuildStatus } from "./types";

export function OntologyVersionRecords({status,canEdit,busy,selectedId,onSelect,onRefresh,onEdit,onExecution}:{status:SourceOntologyBuildStatus;canEdit:boolean;busy:boolean;selectedId:number|null;onSelect:(id:number)=>void;onRefresh:()=>Promise<void>;onEdit:()=>void;onExecution:()=>void}) {
  const selected=status.versions.find((item)=>item.id===selectedId)||status.activeVersion||status.versions[0];
  return <section>
    <div className="ontology-page-intro"><h3>版本记录</h3><p>系统自动保存每次业务定义更新。选择版本即可查看变化和完整定义。</p></div>
    {!selected?<p className="ontology-simple-empty">本体生成后，版本记录会自动保存在这里。</p>:<div className="ontology-record-layout">
      <nav className="ontology-saved-versions" aria-label="选择本体版本">{status.versions.map((version)=><button key={version.id} aria-current={selected.id===version.id?"true":undefined} onClick={()=>onSelect(version.id)}><span><strong>v{version.version}</strong><small>{versionLabel(version.status)}</small></span><time>{formatDate(version.createdAt)}</time><span>{version.validation.summary.objectTypes} 个对象 · {version.validation.summary.linkTypes} 条关系</span></button>)}</nav>
      <VersionDetail key={`${selected.id}:${status.activeVersion?.id}`} selected={selected} active={status.activeVersion} canEdit={canEdit} busy={busy} onRefresh={onRefresh} onEdit={onEdit} onExecution={onExecution}/>
    </div>}
  </section>;
}
function VersionDetail({selected,active,canEdit,busy,onRefresh,onEdit,onExecution}:{selected:SemanticSchemaVersion;active:SemanticSchemaVersion|null;canEdit:boolean;busy:boolean;onRefresh:()=>Promise<void>;onEdit:()=>void;onExecution:()=>void}) {
  const [record,setRecord]=useState<SemanticSchemaVersion|null>(selected.schema?selected:null);
  const [diff,setDiff]=useState<SemanticSchemaDiff|null>(null),[loading,setLoading]=useState(true),[working,setWorking]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[retry,setRetry]=useState(0);
  const activeId=active?.id;
  useEffect(()=>{
    let cancelled=false;
    void Promise.all([getOntologySchema(selected.id),activeId&&activeId!==selected.id?getOntologySchemaDiff(selected.id,activeId):Promise.resolve(null)]).then(([version,changes])=>{if(cancelled)return;setRecord(version);setDiff(changes);setError(null);}).catch((cause)=>{if(!cancelled)setError(cause instanceof Error?cause.message:"读取版本失败");}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[selected.id,activeId,retry]);
  async function restore(){
    setWorking(true);setError(null);
    try{const result=await rollbackOntologySchema(selected.id);if(!result.ok)throw new Error("该版本与当前数据结构不兼容，无法恢复。");setNotice("已恢复，此版本现已用于问数。");await onRefresh();}
    catch(cause){setError(cause instanceof Error?cause.message:"恢复未完成，请重试");}
    finally{setWorking(false);}
  }
  return <div className="ontology-version-detail">
    <header className="ontology-version-heading"><div><span className="ontology-eyebrow">{versionLabel(selected.status)}</span><h3>业务定义 v{selected.version}</h3><p>{formatDate(selected.createdAt)}</p></div>{selected.status==="published"&&canEdit&&<button className="secondary-button" onClick={onEdit}>修改业务说明</button>}</header>
    {error&&<p className="ontology-inline-error" role="alert">{error} <button className="ontology-text-button" onClick={()=>setRetry((value)=>value+1)}>重新读取</button></p>}
    {notice&&<p className="ontology-inline-notice" role="status">{notice}</p>}
    {loading&&<p role="status">正在读取版本和变化…</p>}
    {!loading&&record&&<>
      {selected.status==="draft"&&<p className="ontology-version-note">本次整理结果尚未用于问数。<button className="ontology-text-button" onClick={onExecution}>查看执行记录</button></p>}
      {diff&&<section className="ontology-version-changes"><h4>{selected.status==="deprecated"?"恢复到此版本后的变化":"与当前使用版本的区别"}</h4><p>相对当前 v{active?.version}：新增 {diff.summary.added} 项，调整 {diff.summary.changed} 项，移除 {diff.summary.removed} 项。</p><ChangeList diff={diff} from={active?.schema} to={record.schema}/></section>}
      {selected.status==="deprecated"&&canEdit&&<div className="ontology-restore-action"><p>恢复后将使用上面的业务定义。系统会先检查它是否适用于当前数据结构，现有版本也会保留。</p><button className="secondary-button" disabled={busy||working||!!error||!diff} onClick={()=>void restore()}>{working?"正在检查并恢复…":"恢复到此版本"}</button></div>}
      <div className="ontology-section-heading"><h4>本版本的业务定义</h4><span>{record.schema?.objectTypes.length||0} 个对象</span></div>
      <OntologyDefinitionList record={record}/>
    </>}
  </div>;
}
function versionLabel(status:SemanticSchemaVersion["status"]){return ({published:"当前使用",draft:"尚未启用",deprecated:"历史版本"})[status];}
