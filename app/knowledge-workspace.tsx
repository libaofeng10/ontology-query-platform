"use client";

import { useEffect, useId, useState } from "react";
import { listCapabilityGaps, saveKnowledge, syncKnowledge } from "./api";
import { Icon } from "./icons";
import type { CapabilityGap, CapabilityGapBoard, DiscoveryTable, KnowledgeInput, KnowledgePage, NavId } from "./types";
import "./knowledge-workspace.css";

export type KnowledgePrefill={pageType:KnowledgeInput["pageType"];title:string};
type Draft=KnowledgeInput&{aliasText:string};
const labels:Record<string,string>={term:"业务术语",metric:"指标口径",rule:"业务规则",join:"关系说明"};
const keyOf=(page:KnowledgePage)=>`${page.pageType}:${page.slug}`;
const messageOf=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
const dateOf=(value:string|null)=>value?new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`).toLocaleDateString("zh-CN"):"—";

export function KnowledgeWorkspace({sourceId,pages,tables,role,prefill,onPrefillConsumed,onRefresh,onNavigate}:{sourceId?:number;pages:KnowledgePage[];tables:DiscoveryTable[];role:string;prefill?:KnowledgePrefill|null;onPrefillConsumed:()=>void;onRefresh:()=>Promise<void>;onNavigate:(id:NavId)=>void}) {
  const canEdit=role==="admin"||role==="editor";
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("all");
  const [selectedKey,setSelectedKey]=useState<string|null>(null);
  const [draft,setDraft]=useState<Draft|null>(()=>prefill&&sourceId&&canEdit?newDraft(sourceId,prefill):null);
  const [saving,setSaving]=useState(false);
  const [syncing,setSyncing]=useState(false);
  const [failure,setFailure]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [board,setBoard]=useState<CapabilityGapBoard|null>(null);
  const [pageNumber,setPageNumber]=useState(1);
  const id=useId();
  useEffect(()=>{if(prefill)onPrefillConsumed();},[prefill,onPrefillConsumed]);
  useEffect(()=>{
    if(!sourceId||!canEdit)return;
    let cancelled=false;
    void listCapabilityGaps(sourceId).then(value=>{if(!cancelled)setBoard(value);}).catch(()=>{});
    return()=>{cancelled=true;};
  },[sourceId,canEdit,pages]);
  const businessPages=pages.filter(page=>["term","metric","rule"].includes(page.pageType));
  const filtered=businessPages.filter(page=>(filter==="all"||filter==="draft"&&!page.verified||page.pageType===filter)&&`${page.title} ${page.content} ${page.aliases.join(" ")} ${page.tables.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const totalPages=Math.max(1,Math.ceil(filtered.length/20));
  const currentPage=Math.min(pageNumber,totalPages);
  const visible=filtered.slice((currentPage-1)*20,currentPage*20);
  const selected=filtered.find(page=>keyOf(page)===selectedKey)||visible[0]||null;
  const openGaps=board?.gaps.filter(gap=>gap.status==="open")||[];
  function edit(page:KnowledgePage){
    if(!sourceId||!canEdit||page.readOnly||page.pageType==="table")return;
    setDraft({...page,sourceId,pageType:page.pageType,aliases:[...page.aliases],tables:[...page.tables],aliasText:page.aliases.join("，"),sqlContent:page.sqlContent||"",antiExamples:page.antiExamples||"",owner:page.owner||""});
    setFailure(null);setMessage(null);
  }
  function remedy(gap:CapabilityGap){
    if(!sourceId||draft)return;
    const page=businessPages.find(page=>page.pageType===gap.remedy.prefill?.pageType&&page.slug===gap.remedy.prefill?.slug);
    if(page){setSelectedKey(keyOf(page));edit(page);}
    else setDraft(newDraft(sourceId,{pageType:gap.remedy.prefill?.pageType==="metric"?"metric":"term",title:gap.assetLabel}));
  }
  async function save(verified:boolean){
    if(!draft||!canEdit)return;
    setSaving(true);setFailure(null);setMessage(null);
    try {
      const {aliasText,...input}=draft;
      const saved=await saveKnowledge({...input,aliases:aliasText.split(/[,，\n]/).map(value=>value.trim()).filter(Boolean),verified});
      setSelectedKey(keyOf(saved));setSearch("");setFilter("all");setPageNumber(1);setDraft(null);
      setMessage(verified?"已保存生效，后续问答和本体构建将读取这条知识。":"草稿已保存，可继续完善后再生效。");
      try{await onRefresh();}catch{setFailure("知识已保存，但列表刷新失败，请刷新页面查看。");}
    }catch(cause){setFailure(messageOf(cause));}finally{setSaving(false);}
  }
  async function sync(){
    if(!sourceId||!canEdit)return;
    setSyncing(true);setFailure(null);
    try {
      const result=await syncKnowledge(sourceId);
      setMessage(`已导入 ${result.imported} 条，${result.unchanged} 条未变化。${result.errors.length?`有 ${result.errors.length} 个文件未导入。`:""}`);
      if(result.errors.length)setFailure(result.errors.map(item=>`${item.file}：${item.error}`).join("\n"));
      await onRefresh();
    }catch(cause){setFailure(messageOf(cause));}finally{setSyncing(false);}
  }
  return <div className="content sub-page knowledge-page">
    <div className="knowledge-heading"><div><h1>业务知识</h1><p>补充业务术语、统计口径和特殊规则，让问答理解你的业务。</p></div><button className="primary-button" disabled={!sourceId||!canEdit||Boolean(draft)} onClick={()=>{setDraft(newDraft(sourceId!));setFailure(null);setMessage(null);}}><Icon name="plus" size={16}/>新增知识</button></div>
    <div className="knowledge-context"><span><b>{businessPages.filter(page=>page.verified).length}</b> 条已生效</span><span>{businessPages.filter(page=>!page.verified).length} 条草稿</span><button onClick={()=>onNavigate("sources")}>维护表结构与关系<Icon name="arrow" size={14}/></button></div>
    {message&&<p className="knowledge-notice success" role="status"><Icon name="check" size={16}/>{message}</p>}
    {failure&&<p className="knowledge-notice error" role="alert">{failure}</p>}
    <div className="knowledge-workbench">
      <aside className="knowledge-library" aria-label="业务知识列表">
        <label className="knowledge-search"><Icon name="search" size={16}/><input aria-label="搜索业务知识" placeholder="搜索名称、口径或业务说明" value={search} onChange={event=>{setSearch(event.target.value);setPageNumber(1);}}/></label>
        <div className="knowledge-filters" aria-label="知识类型">{[["all","全部"],["term","术语"],["metric","指标"],["rule","规则"],["draft","草稿"]].map(([value,label])=><button key={value} aria-pressed={filter===value} className={filter===value?"active":""} onClick={()=>{setFilter(value);setPageNumber(1);}}>{label}</button>)}</div>
        <div className="knowledge-entries">{visible.map(page=><button key={keyOf(page)} disabled={Boolean(draft)} className={`knowledge-entry ${selected&&keyOf(selected)===keyOf(page)?"selected":""}`} onClick={()=>setSelectedKey(keyOf(page))}><span><i className={`knowledge-kind ${page.pageType}`}>{labels[page.pageType]}</i><small>{page.verified?"已生效":"草稿"}</small></span><strong>{page.title}</strong><p>{page.content||page.sqlContent||"暂无说明"}</p></button>)}{!visible.length&&<div className="knowledge-list-empty"><Icon name="book" size={25}/><p>{search||filter!=="all"?"没有匹配的知识":"还没有业务知识"}</p></div>}</div>
        <div className="knowledge-pagination"><span>{filtered.length} 条</span><button aria-label="上一页知识" disabled={currentPage===1||Boolean(draft)} onClick={()=>setPageNumber(currentPage-1)}>‹</button><span>{currentPage} / {totalPages}</span><button aria-label="下一页知识" disabled={currentPage===totalPages||Boolean(draft)} onClick={()=>setPageNumber(currentPage+1)}>›</button></div>
      </aside>
      <section className="knowledge-document" aria-label={draft?"编辑业务知识":"知识详情"}>
        {draft?<form onSubmit={event=>{event.preventDefault();void save(true);}}>
          <div className="knowledge-document-heading"><span>{draft.slug?"编辑知识":"新增知识"}</span><button type="button" className="text-button" disabled={saving} onClick={()=>{setDraft(null);setFailure(null);}}>取消编辑</button></div>
          <fieldset disabled={saving}><label className="knowledge-field" htmlFor={`${id}-title`}>知识名称<input id={`${id}-title`} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})} placeholder="例如：GPT 活跃用户的统计口径" required/></label>
            <div className="knowledge-form-row"><label className="knowledge-field" htmlFor={`${id}-type`}>类型<select id={`${id}-type`} value={draft.pageType} disabled={Boolean(draft.slug)} onChange={event=>setDraft({...draft,pageType:event.target.value as KnowledgeInput["pageType"]})}>{Object.entries(labels).filter(([value])=>value!=="join").map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label className="knowledge-field" htmlFor={`${id}-aliases`}>常用叫法（可选）<input id={`${id}-aliases`} value={draft.aliasText} onChange={event=>setDraft({...draft,aliasText:event.target.value})} placeholder="多个名称用逗号分隔"/></label></div>
            <label className="knowledge-field" htmlFor={`${id}-content`}>业务说明<textarea id={`${id}-content`} rows={9} value={draft.content} onChange={event=>setDraft({...draft,content:event.target.value})} placeholder="用日常语言说明含义、计算方式、时间范围，以及需要排除的情况。"/></label>
            <details className="knowledge-scope"><summary>适用范围 <span>{draft.tables.length?`${draft.tables.length} 张数据表`:"当前数据源全部问答"}</span></summary><p>选择数据表可限定适用范围；不选择时，对当前数据源的问答生效。</p><div>{[...new Set([...tables.filter(table=>table.active&&table.grade!=="C").map(table=>table.tableName),...draft.tables])].map(tableName=><label key={tableName}><input type="checkbox" checked={draft.tables.includes(tableName)} onChange={event=>setDraft({...draft,tables:event.target.checked?[...draft.tables,tableName]:draft.tables.filter(value=>value!==tableName)})}/><span>{tables.find(table=>table.tableName===tableName)?.comment||tableName}<small>{tableName}</small></span></label>)}</div></details>
            <details className="knowledge-extras" open={Boolean(draft.sqlContent||draft.antiExamples)||undefined}><summary>参考 SQL 与例外说明（可选）</summary><label className="knowledge-field" htmlFor={`${id}-sql`}>参考 SQL<textarea id={`${id}-sql`} className="mono-input" rows={5} value={draft.sqlContent} onChange={event=>setDraft({...draft,sqlContent:event.target.value})} placeholder="可留空；已有 SQL 可以作为口径示例。"/></label><label className="knowledge-field" htmlFor={`${id}-exceptions`}>例外与注意事项<textarea id={`${id}-exceptions`} rows={3} value={draft.antiExamples} onChange={event=>setDraft({...draft,antiExamples:event.target.value})}/></label></details>
          </fieldset><div className="knowledge-save-bar"><span>维护人自动记录</span><button type="button" className="secondary-button" disabled={saving||!draft.title.trim()||!draft.content.trim()&&!draft.sqlContent.trim()} onClick={()=>void save(false)}>保存草稿</button><button type="submit" className="primary-button" disabled={saving||!draft.title.trim()||!draft.content.trim()&&!draft.sqlContent.trim()}>{saving?"保存中…":"保存生效"}</button></div>
        </form>:selected?<>
          <div className="knowledge-document-heading"><span className={`knowledge-kind ${selected.pageType}`}>{labels[selected.pageType]}</span>{canEdit&&!selected.readOnly&&<button className="secondary-button" onClick={()=>edit(selected)}>编辑知识</button>}</div>
          <h2>{selected.title}</h2><div className="knowledge-document-meta"><span className={selected.verified?"active":""}>{selected.verified?"已生效":"草稿"}</span>{selected.owner&&<span>{selected.owner}</span>}<span>更新于 {dateOf(selected.updatedAt)}</span></div>
          {selected.aliases.length>0&&<p className="knowledge-aliases">常用叫法：{selected.aliases.join("、")}</p>}
          <div className="knowledge-prose">{selected.content||"这条知识以参考 SQL 描述口径。"}</div>
          {selected.antiExamples&&<div className="knowledge-exception"><h3>例外与注意事项</h3><p>{selected.antiExamples}</p></div>}
          {selected.sqlContent&&<details className="knowledge-extras"><summary>查看参考 SQL</summary><pre><code>{selected.sqlContent}</code></pre></details>}
          <div className="knowledge-document-scope"><span>适用范围</span>{selected.tables.length?selected.tables.map(table=><code key={table}>{table}</code>):<p>当前数据源全部问答</p>}</div>
          {selected.readOnly&&<p className="knowledge-origin">来自数据源规则。<button className="text-button" onClick={()=>onNavigate("questions")}>前往关系与枚举维护</button></p>}
        </>:<div className="knowledge-welcome"><Icon name="book" size={36}/><h2>把业务经验补充在这里</h2><p>例如统计周期、有效客户的定义、不同产品的账号口径。填写说明并保存后，问答就能使用。</p>{canEdit&&<button className="primary-button" disabled={!sourceId} onClick={()=>setDraft(newDraft(sourceId!))}>新增第一条知识</button>}</div>}
      </section>
    </div>
    {canEdit&&openGaps.length>0&&<details className="knowledge-review"><summary>{openGaps.length} 条业务定义需要补充或修正</summary><div>{openGaps.map(gap=><article key={gap.key}><div><strong>{gap.assetLabel}</strong><p>{gap.detail||gap.sampleQuestions[0]||"请核实业务定义"}</p></div><button className="secondary-button" disabled={Boolean(draft)} onClick={()=>remedy(gap)}>{gap.remedy.action==="edit_knowledge_page"?"修正知识":"补充说明"}</button></article>)}</div></details>}
    <div className="knowledge-footer"><button className="text-button" onClick={()=>onNavigate("audit")}>查看查询问题与历史记录<Icon name="arrow" size={14}/></button>{canEdit&&<details><summary>高级操作</summary><button className="secondary-button" disabled={syncing||Boolean(draft)||!sourceId} onClick={()=>void sync()}>{syncing?"导入中…":"从服务器 Markdown 导入"}</button><p>仅在手工修改服务器知识文件后使用，页面保存会自动同步。</p></details>}</div>
  </div>;
}

function newDraft(sourceId:number,prefill?:KnowledgePrefill):Draft{return {sourceId,pageType:prefill?.pageType==="metric"?"metric":prefill?.pageType==="rule"?"rule":"term",title:prefill?.title||"",aliases:[],aliasText:"",tables:[],content:"",sqlContent:"",antiExamples:"",verified:false,owner:""};}

export function AuditIssues({sourceId,role,onNavigate}:{sourceId?:number;role:string;onNavigate:(id:NavId)=>void}) {
  const [board,setBoard]=useState<CapabilityGapBoard|null>(null);
  const [failure,setFailure]=useState<string|null>(null);
  const [tab,setTab]=useState<"current"|"history">("current");
  const [limit,setLimit]=useState(10);
  useEffect(()=>{
    if(!sourceId||!["admin","editor"].includes(role))return;
    let cancelled=false;
    void listCapabilityGaps(sourceId,"all").then(value=>{if(!cancelled)setBoard(value);}).catch(cause=>{if(!cancelled)setFailure(messageOf(cause));});
    return()=>{cancelled=true;};
  },[sourceId,role]);
  if(!["admin","editor"].includes(role))return null;
  const rows=board?.gaps.filter(gap=>tab==="current"?gap.status==="open":gap.status!=="open")||[];
  return <section className="panel audit-issues"><div className="audit-issues-heading"><div><h2>查询问题</h2><p>区分当前问题、旧流程记录和后续回放结果。</p></div><div className="knowledge-filters">{([['current','当前问题'],['history','历史记录']] as const).map(([value,label])=><button key={value} className={tab===value?"active":""} aria-pressed={tab===value} onClick={()=>{setTab(value);setLimit(10);}}>{label}</button>)}</div></div>{failure?<p role="alert">{failure}</p>:!board?<p role="status">正在读取问题记录…</p>:rows.length?rows.slice(0,limit).map(gap=><details className="audit-issue" key={gap.key}><summary><span>{gap.assetLabel}</span><small>{gap.count} 条记录</small><b>{gap.status==="historical"?"旧流程记录":gap.status==="replayed"?"后续执行成功":gap.status==="resolved"?"已有匹配定义":gap.category==="knowledge"?"业务定义":gap.category==="catalog"?"数据源维护":"运行问题"}</b></summary><div>{gap.detail&&<p>{gap.detail}</p>}{gap.sampleQuestions.map(question=><p key={question}>{question}</p>)}{Boolean(gap.replayedCount)&&<p>{gap.replayedCount} 条失败记录有同一问法的后续成功执行；业务口径仍需结合结果核实。</p>}{gap.status==="historical"&&<p>来自当前 Claude 问数启用前的其他执行流程，保留供追溯。</p>}{gap.status==="open"&&gap.category!=="operation"&&<button className="secondary-button" onClick={()=>onNavigate(gap.category==="catalog"?"questions":"knowledge")}>{gap.category==="catalog"?"查看数据源与本体":"查看业务知识"}</button>}</div></details>):<p className="knowledge-muted">{tab==="current"?"当前没有待排查的问题。":"暂无历史问题。"}</p>}{rows.length>limit&&<button className="text-button" onClick={()=>setLimit(limit+10)}>再显示 10 条</button>}</section>;
}
