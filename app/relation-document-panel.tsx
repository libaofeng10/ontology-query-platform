"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, listRelationDocuments, uploadRelationDocument } from "./api";
import { Icon } from "./icons";
import type { RelationDocument } from "./types";

export function RelationDocumentPanel({sourceId,role,onRefresh}:{sourceId?:number;role:string;onRefresh:()=>Promise<void>}){
  const [documents,setDocuments]=useState<RelationDocument[]>([]);const [file,setFile]=useState<File|null>(null);const [working,setWorking]=useState(false);const [failure,setFailure]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const canEdit=["editor","admin"].includes(role);
  const load=useCallback(async()=>{if(!sourceId){setDocuments([]);return;}try{setDocuments(await listRelationDocuments(sourceId));}catch(cause){setFailure(errorMessage(cause));}},[sourceId]);
  useEffect(()=>{if(!sourceId)return;let cancelled=false;void listRelationDocuments(sourceId).then((items)=>{if(!cancelled)setDocuments(items);}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});return()=>{cancelled=true;};},[sourceId]);
  async function upload(){if(!sourceId||!file||!canEdit)return;setWorking(true);setFailure(null);setMessage(null);try{const content=await file.text();const result=await uploadRelationDocument(sourceId,file.name,content);setMessage(`${result.idempotent?"文档已存在":"抽取完成"}：通过 ${result.acceptedCount} 条，拒绝 ${result.rejectedCount} 条；通过项已进入 JOIN 人工确认队列。`);setFile(null);await load();await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setWorking(false);}}
  return <div className="content sub-page relation-documents"><section className="panel"><div className="panel-title"><div><h2>关系文档桥接</h2><p>上传 Markdown 或纯文本，明确关系经目录校验后只会进入 review，不会直接进入 JOIN 白名单。</p></div></div>{failure&&<p className="ai-error-copy">{failure}</p>}{message&&<p className="calibration-message">{message}</p>}<div className="form-grid"><label className="form-field"><span>关系说明文档（最大 256 KiB）</span><input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" disabled={!canEdit||working} onChange={(event)=>setFile(event.target.files?.[0]||null)}/></label><button className="primary-button" disabled={!file||!canEdit||working} onClick={()=>void upload()}><Icon name="plus"/>{working?"抽取与校验中…":"上传并生成关系候选"}</button></div>{documents.length?<div className="table-responsive"><table className="data-table"><thead><tr><th>文档</th><th>状态</th><th>断言</th><th>结果</th><th>上传时间</th></tr></thead><tbody>{documents.map((document)=><tr key={document.id}><td><strong>{document.fileName}</strong><small>{document.createdBy||"未知操作人"}</small></td><td>{document.status}</td><td>{document.assertionCount}</td><td><strong>{document.acceptedCount} 通过</strong><small>{document.rejectedCount} 拒绝{document.error?` · ${document.error}`:""}</small></td><td>{new Date(document.createdAt).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div>:<p>尚未上传关系文档。</p>}</section></div>;
}

function errorMessage(error:unknown){return error instanceof ApiError&&error.detail?`${error.message}：${error.detail}`:error instanceof Error?error.message:"发生未知错误";}
