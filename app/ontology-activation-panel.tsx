"use client";

import {useEffect,useRef,useState} from "react";
import {activateOntologyVersion,getOntologyActivation} from "./api";
import type {OntologyActivationStatus} from "./types";

export function OntologyActivationPanel({sourceId,versionId,canEdit,busy,revision,onRefresh,onEvaluation,onVersion}:{sourceId:number;versionId:number;canEdit:boolean;busy:boolean;revision?:string;onRefresh:()=>Promise<void>;onEvaluation:(activation:OntologyActivationStatus)=>void;onVersion?:(id:number)=>void}) {
  const [info,setInfo]=useState<OntologyActivationStatus|null>(null),[working,setWorking]=useState(false);
  const [failure,setFailure]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const sequence=useRef(0);
  useEffect(()=>{
    const request=++sequence.current;let cancelled=false;
    void getOntologyActivation(sourceId,versionId).then(next=>{if(!cancelled&&sequence.current===request){setInfo(next);setFailure(null);}}).catch(cause=>{if(!cancelled&&sequence.current===request)setFailure(cause instanceof Error?cause.message:"读取启用条件失败");});
    return()=>{cancelled=true;};
  },[sourceId,versionId,revision]);
  async function recheck(){
    const request=++sequence.current;setWorking(true);setFailure(null);setNotice(null);
    try{const next=await getOntologyActivation(sourceId,versionId);if(sequence.current===request){setInfo(next);setNotice(`检查完成：${next.detail}`);}await onRefresh();}
    catch(cause){setFailure(cause instanceof Error?cause.message:"检查未完成，请重试");}
    finally{setWorking(false);}
  }
  async function activate(mode:"activate"|"retain_removed_properties"){
    if(!info)return;
    setWorking(true);setFailure(null);setNotice(null);
    try{const result=await activateOntologyVersion(sourceId,{versionId,mode,snapshotChecksum:info.snapshotChecksum});await onRefresh();setNotice(`已提交 v${result.version} 的启用检查，通过后自动用于问数。`);if(result.versionId!==versionId)onVersion?.(result.versionId);}
    catch(cause){setFailure(cause instanceof Error?cause.message:"启用未完成，请重新检查条件");}
    finally{setWorking(false);}
  }
  const disabled=busy||working,newer=info?.supersededBy;
  return <section className="ontology-activation-panel" aria-label="版本启用条件">
    <div className="ontology-section-heading"><h4>{info?`启用 v${info.version}`:"版本启用条件"}</h4>{(disabled||!info&&!failure)&&<span role="status"><i className="mini-loader"/>{working?"正在处理…":busy?"后台检查中…":"正在读取…"}</span>}</div>
    {failure&&<p className="ontology-inline-error" role="alert">{failure}</p>}
    {notice&&<p className="ontology-inline-notice" role="status">{notice}</p>}
    {info&&<>
      <p>{info.detail}</p>
      {info.errors.length>0&&<ul>{info.errors.map((issue,index)=><li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
      {info.missingChanges.length>0&&<>
        <p className="ontology-activation-label">需要验证的变化</p>
        <ul>{info.missingChanges.map(change=>{const field=info.retention?.fields.find(item=>item.path===change.path);return <li key={change.path}>{field?`${field.objectLabel} · ${field.label}`:change.label}<small>{change.detail}</small></li>;})}</ul>
      </>}
      {info.retention&&<div className="ontology-retention-option"><strong>也可以保留这 {info.retention.fieldCount} 个已有字段</strong><p>保留上述字段，同时采用本次新增的对象、关系和说明。系统会保存为新版本并检查启用，v{info.version} 继续保留在版本记录中。</p>{canEdit&&<button className="primary-button" disabled={disabled} onClick={()=>void activate("retain_removed_properties")}>保留这 {info.retention.fieldCount} 个字段并启用更新</button>}</div>}
      <div className="ontology-activation-actions">
        {canEdit&&info.canActivate&&<button className="primary-button" disabled={disabled} onClick={()=>void activate("activate")}>{info.state==="needs_evaluation"?`运行验证并启用 v${info.version}`:`启用 v${info.version}`}</button>}
        {info.state==="needs_cases"&&canEdit&&<button className="secondary-button" disabled={disabled} onClick={()=>onEvaluation(info)}>补充验证用例后启用 v{info.version}</button>}
        {info.state==="needs_evaluation"&&canEdit&&<button className="secondary-button" disabled={disabled} onClick={()=>onEvaluation(info)}>查看或调整验证用例</button>}
        {newer&&onVersion&&<button className="secondary-button" onClick={()=>onVersion(newer.id)}>查看 v{newer.version}</button>}
        {!canEdit&&!["published","historical","superseded"].includes(info.state)&&<span>需要编辑者或管理员处理启用。</span>}
      </div>
    </>}
    <button className="ontology-text-button" disabled={disabled} onClick={()=>void recheck()}>{working?"检查中…":"重新检查启用条件"}</button>
  </section>;
}
