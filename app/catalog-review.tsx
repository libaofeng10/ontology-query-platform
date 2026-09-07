"use client";

import { useState } from "react";
import { answerQuestion } from "./api";
import type { OntologyQuestion } from "./types";
import "./knowledge-workspace.css";

export function CatalogReview({items,role,onRefresh}:{items:OntologyQuestion[];role:string;onRefresh:()=>Promise<void>}) {
  const [search,setSearch]=useState("");
  const [choices,setChoices]=useState<Record<number,string>>({});
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState<string|null>(null);
  const [limit,setLimit]=useState(15);
  const canEdit=role==="editor"||role==="admin";
  const groups=new Map<string,OntologyQuestion[]>();
  for(const item of items){
    const key=[item.kind,item.tableName,item.columnName].filter(Boolean).join(" · ");
    if(!`${key} ${item.question}`.toLowerCase().includes(search.trim().toLowerCase()))continue;
    const group=groups.get(key)||[];group.push(item);groups.set(key,group);
  }
  async function save(group:OntologyQuestion[]){
    if(!canEdit||busy)return;
    setBusy(true);setFailure(null);
    const completed:number[]=[];
    try {
      for(const item of group.filter(item=>choices[item.id])){await answerQuestion(item.id,choices[item.id]);completed.push(item.id);}
    }catch(cause){setFailure(`${completed.length?`已保存 ${completed.length} 项。`:""}${cause instanceof Error?cause.message:String(cause)}，其余选择已保留。`);}
    finally {
      setChoices(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!completed.includes(Number(id)))));
      try{await onRefresh();}catch{setFailure("已完成的选择已经保存，列表刷新失败，请刷新页面查看。");}
      setBusy(false);
    }
  }
  return <section className="catalog-review"><div className="catalog-review-header"><div><h2>关系与枚举确认</h2><p>{items.length?`${items.length} 项待确认，按字段集中维护。` :"当前没有待确认项。"}用于补充本体与业务含义。</p></div><input aria-label="搜索关系与枚举" placeholder="搜索表、字段或问题" value={search} onChange={event=>{setSearch(event.target.value);setLimit(15);}}/></div>{failure&&<p className="knowledge-notice error" role="alert">{failure}</p>}{[...groups.entries()].slice(0,limit).map(([key,group])=><details className="catalog-review-group" key={key}><summary><strong>{key}</strong><span>{group.length} 项</span></summary><form onSubmit={event=>{event.preventDefault();void save(group);}}>{group.map(item=><div className="catalog-review-item" key={item.id}><div><strong>{item.question}</strong><p>{item.evidence}</p></div><select aria-label={`确认：${item.question}`} disabled={!canEdit||busy} value={choices[item.id]||""} onChange={event=>setChoices({...choices,[item.id]:event.target.value})}><option value="">请选择含义或关系判断</option>{item.options.map(option=><option key={option} value={option}>{option}</option>)}</select></div>)}{canEdit&&<button className="primary-button" disabled={busy||!group.some(item=>choices[item.id])} type="submit">{busy?"保存中…":`保存 ${group.filter(item=>choices[item.id]).length} 项选择`}</button>}</form></details>)}{groups.size>limit&&<button className="secondary-button" onClick={()=>setLimit(limit+15)}>再显示 15 组</button>}{!groups.size&&<p className="knowledge-muted">{search?"没有匹配的待确认项。":"后续构建中需要核实的关系和枚举含义会集中出现在这里。"}</p>}</section>;
}
