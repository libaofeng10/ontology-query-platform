"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError, answerQuestion, archiveEvalCase, askQuestion, continueQuestion, createQuerySession, createSource, deleteQuerySession, discoverSource, getBootstrap, getQuerySession, getTask, listCapabilityGaps, listQuerySessions, previewSourceTables, rotateSourceCredential, runAgentEvaluationGate, runEvaluation, runEvaluationGate, saveEvalCase, saveKnowledge, saveTableSelections, setApiToken, setTableGrade, syncKnowledge, testSource } from "./api";
import { DataChart } from "./chart";
import { QUERY_SUGGESTIONS } from "./demo-data";
import { coverageByType, missingAssetLines } from "./knowledge-coverage.mjs";
import { Icon, type IconName } from "./icons";
import { OntologyGraphWorkspace } from "./ontology-graph";
import { SemanticModelingWorkspace } from "./semantic-modeling";
import { SettingsWorkspace } from "./settings-workspace";
import { RelationDocumentPanel } from "./relation-document-panel";
import type { AuditRecord, BackgroundTask, BootstrapData, CapabilityGap, CapabilityGapBoard, DataSource, DiscoverySummary, EvalCase, EvalInput, EvalRun, EvaluationGate, EvaluationSummary, KnowledgeInput, KnowledgePage, NavId, OntologyQuestion, QueryAnswer, QueryClarification, QueryRefusal, QuerySession, QuerySessionDetail, QueryStreamEvent, QueryToolTrace, SchemaSnapshot, SourceInput, TableSelectionRow } from "./types";

const NAV_ITEMS:{id:NavId;label:string;hint:string}[]=[
  {id:"query",label:"AI 问答",hint:"与业务数据对话"},{id:"sources",label:"数据源",hint:"连接与只读校验"},
  {id:"discovery",label:"数据探查",hint:"结构与分级"},{id:"questions",label:"消歧队列",hint:"证据驱动确认"},
  {id:"modeling",label:"业务对象建模",hint:"对象、属性与关系"},{id:"knowledge",label:"知识资产",hint:"本体与口径"},{id:"graph",label:"本体图谱",hint:"关系与语义网络"},{id:"evaluation",label:"评测中心",hint:"准确率回归"},{id:"audit",label:"审计日志",hint:"全链路追溯"},
  {id:"settings",label:"设置中心",hint:"模型与检索参数"},
];
const NAV_ICONS:Record<NavId,IconName>={query:"spark",sources:"database",discovery:"search",questions:"message",modeling:"graph",knowledge:"book",graph:"graph",evaluation:"target",audit:"shield",settings:"shield"};

// Same parameter shape as the S7 gap-remedy prefill: pageType plus title.
type KnowledgePrefill={pageType:KnowledgeInput["pageType"];title:string};

export function PlatformApp(){
  const [active,setActive]=useState<NavId>("query");
  const [mobileNav,setMobileNav]=useState(false);
  const [data,setData]=useState<BootstrapData|null>(null);
  const [selectedSourceId,setSelectedSourceId]=useState<number|undefined>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [authRequired,setAuthRequired]=useState(false);
  const [knowledgePrefill,setKnowledgePrefill]=useState<KnowledgePrefill|null>(null);

  const load=useCallback(async(sourceId?:number,quiet=false)=>{if(!quiet)setLoading(true);try{const next=await getBootstrap(sourceId);setData(next);setSelectedSourceId(next.sourceId||next.sources[0]?.id);setError(null);setAuthRequired(false);}catch(cause){if(cause instanceof ApiError&&cause.status===401)setAuthRequired(true);setError(errorMessage(cause));}finally{setLoading(false);}},[]);
  useEffect(()=>{let cancelled=false;void getBootstrap().then((next)=>{if(cancelled)return;setData(next);setSelectedSourceId(next.sourceId||next.sources[0]?.id);setError(null);setAuthRequired(false);}).catch((cause)=>{if(!cancelled){setError(errorMessage(cause));if(cause instanceof ApiError&&cause.status===401)setAuthRequired(true);}}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[]);
  const selectedSource=data?.sources.find((source)=>source.id===selectedSourceId)||null;
  const refresh=useCallback(()=>load(selectedSourceId,true),[load,selectedSourceId]);
  async function selectSource(id:number){setSelectedSourceId(id);await load(id);}

  if(authRequired&&!data)return <LoginState error={error} onLogin={async(token)=>{setApiToken(token);await load();}}/>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav?"open":""}`}>
      <div className="brand"><div className="brand-mark"><span/><span/><span/></div><div><strong>OntoQuery</strong><small>本体驱动智能问数</small></div></div>
      <nav aria-label="主导航">{NAV_ITEMS.filter((item)=>item.id!=="settings"||data?.identity?.role==="admin").map((item)=><button key={item.id} className={active===item.id?"nav-item active":"nav-item"} onClick={()=>{setActive(item.id);setMobileNav(false);}}><Icon name={NAV_ICONS[item.id]} size={19}/><span><b>{item.label}</b><small>{item.hint}</small></span>{item.id==="questions"&&Boolean(data?.questions.length)&&<em>{data?.questions.length}</em>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className="source-card source-card-button" onClick={()=>setActive("sources")}>
          <div className="source-top"><span className={selectedSource?.lastTestOk===0?"status-dot offline":"status-dot"}/><span>{selectedSource?.isDemo?"演示数据源":selectedSource?.lastTestOk?"只读连接已验证":"数据源待验证"}</span><b>{selectedSource?.isDemo?"DEMO":"MYSQL"}</b></div>
          <strong>{selectedSource?.dbName||"尚未配置"}</strong><small>{data?.discovery?.totalTables||0} 张表 · {formatDate(selectedSource?.lastDiscoveryAt,"尚未探查")}</small>
        </button>
        <div className="system-row"><span className={error?"status-dot offline":"status-dot"}/>{error?"API 连接异常":"本地服务正常"}<button aria-label="刷新平台状态" onClick={()=>void refresh()}>↻</button></div>
      </div>
    </aside>
    {mobileNav&&<button className="nav-backdrop" aria-label="关闭导航" onClick={()=>setMobileNav(false)}/>}

    <main className={active==="query"?"workspace chat-workspace":"workspace"}>
      <header className="topbar"><button className="mobile-menu" aria-label="打开导航" onClick={()=>setMobileNav(true)}><Icon name="menu"/></button><div><span className="crumb">工作空间</span><span className="slash">/</span><strong>{NAV_ITEMS.find((item)=>item.id===active)?.label}</strong></div><div className="top-actions">{data?.sources.length?<select className="source-select" aria-label="切换数据源" value={selectedSourceId} onChange={(event)=>void selectSource(Number(event.target.value))}>{data.sources.map((source)=><option value={source.id} key={source.id}>{source.name} · {source.dbName}</option>)}</select>:null}<span className="env-pill"><span className={selectedSource?.lastTestOk===0?"status-dot offline":"status-dot"}/>{data?.identity?.name||"已认证"} · {data?.identity?.role||"viewer"}</span><div className="avatar">{(data?.identity?.name||"OQ").slice(0,2).toUpperCase()}</div></div></header>
      {error&&<div className="global-error"><Icon name="shield"/><span>{error}</span><button onClick={()=>void load(selectedSourceId)}>重试</button></div>}
      {loading&&!data?<LoadingState/>:<>
        {active==="query"&&<QueryWorkspace key={selectedSourceId} source={selectedSource} role={data?.identity?.role||"viewer"} onNavigate={setActive} onCreateKnowledge={(prefill)=>{setKnowledgePrefill(prefill);setActive("knowledge");}}/>}
        {active==="sources"&&<SourcesWorkspace sources={data?.sources||[]} selectedId={selectedSourceId} onSelect={selectSource} onRefresh={refresh}/>} 
        {active==="discovery"&&<DiscoveryWorkspace key={selectedSourceId} source={selectedSource} discovery={data?.discovery||null} tasks={data?.tasks||[]} snapshots={data?.schemaSnapshots||[]} onRefresh={refresh}/>} 
        {active==="questions"&&<><RelationDocumentPanel sourceId={selectedSourceId} role={data?.identity.role||"viewer"} onRefresh={refresh}/><QuestionsWorkspace items={data?.questions||[]} onRefresh={refresh}/></>} 
        {active==="modeling"&&<SemanticModelingWorkspace sourceId={selectedSourceId} role={data?.identity.role||"viewer"} onPublished={refresh}/>} 
        {active==="knowledge"&&<KnowledgeWorkspace sourceId={selectedSourceId} pages={data?.knowledge||[]} role={data?.identity?.role||"viewer"} prefill={knowledgePrefill} onPrefillConsumed={()=>setKnowledgePrefill(null)} onRefresh={refresh}/>}
        {active==="graph"&&<OntologyGraphWorkspace graph={data?.graph||null} source={selectedSource} onNavigate={setActive}/>} 
        {active==="evaluation"&&<EvaluationWorkspace key={selectedSourceId} source={selectedSource} cases={data?.evalCases||[]} runs={data?.evalRuns||[]} gates={data?.evalGates||[]} tasks={data?.tasks||[]} onRefresh={refresh}/>} 
        {active==="audit"&&<AuditWorkspace rows={data?.audits||[]} stats={data?.auditStats||null}/>}
        {active==="settings"&&<SettingsWorkspace key={selectedSourceId} sourceId={selectedSourceId} role={data?.identity.role||"viewer"} onRefresh={refresh}/>}
      </>}
    </main>
  </div>;
}

function LoadingState(){return <div className="loading-state"><span className="mini-loader"/><h2>正在读取平台状态</h2><p>这里只显示 SQLite 与数据源返回的真实数据。</p></div>;}
function LoginState({error,onLogin}:{error:string|null;onLogin:(token:string)=>Promise<void>}){const [token,setToken]=useState("");const [loading,setLoading]=useState(false);return <main className="login-page"><form className="panel login-card" onSubmit={(event)=>{event.preventDefault();setLoading(true);void onLogin(token).finally(()=>setLoading(false));}}><div className="brand-mark"><span/><span/><span/></div><span className="section-kicker">OntoQuery 安全入口</span><h1>输入 API 身份令牌</h1><p>令牌只保存在当前浏览器标签页的 sessionStorage；服务端据此应用角色和数据源权限。</p>{error&&<Notice tone="danger" title="认证失败" body={error}/>}<Field label="Bearer Token"><input type="password" autoComplete="current-password" value={token} onChange={(event)=>setToken(event.target.value)} placeholder="粘贴管理员、编辑者或分析师令牌"/></Field><button className="primary-button" type="submit" disabled={!token.trim()||loading}>{loading?"验证中…":"进入工作空间"}</button></form></main>;}

function QueryWorkspace({source,role,onNavigate,onCreateKnowledge}:{source:DataSource|null;role:string;onNavigate:(id:NavId)=>void;onCreateKnowledge:(prefill:KnowledgePrefill)=>void}){
  const [input,setInput]=useState("");
  const [sessions,setSessions]=useState<QuerySession[]>([]);
  const [detail,setDetail]=useState<QuerySessionDetail|null>(null);
  const [sessionId,setSessionId]=useState<string|undefined>();
  const [failure,setFailure]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [sessionLoading,setSessionLoading]=useState(true);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [liveQuestion,setLiveQuestion]=useState<string|null>(null);
  const [liveSteps,setLiveSteps]=useState<LiveQueryStep[]>([]);
  const [liveReplies,setLiveReplies]=useState<Array<{question:string;answer:string}>>([]);
  const [clarification,setClarification]=useState<QueryClarification|null>(null);
  const streamController=useRef<AbortController|null>(null);
  const scrollRef=useRef<HTMLDivElement|null>(null);
  const inputRef=useRef<HTMLTextAreaElement|null>(null);
  const followLatest=useRef(true);
  const suggestions=source?.isDemo?QUERY_SUGGESTIONS:[];
  const hasMessages=Boolean(detail?.messages.length||liveQuestion);
  const needsOption=Boolean(clarification&&!clarification.clarification.allowFreeText);

  useEffect(()=>{
    if(!source)return;
    let cancelled=false;
    void listQuerySessions(source.id).then(async(items)=>{
      if(cancelled)return;
      setSessions(items);
      if(!items.length){setSessionId(undefined);setDetail(null);return;}
      const selected=await getQuerySession(items[0].id);
      if(cancelled)return;
      setSessionId(selected.id);setDetail(selected);restorePending(selected);
    }).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));}).finally(()=>{if(!cancelled)setSessionLoading(false);});
    return()=>{cancelled=true;};
  },[source]);
  useEffect(()=>()=>streamController.current?.abort(),[]);
  useEffect(()=>{
    if(!historyOpen)return;
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape")setHistoryOpen(false);};
    window.addEventListener("keydown",closeOnEscape);
    return()=>window.removeEventListener("keydown",closeOnEscape);
  },[historyOpen]);
  useEffect(()=>{
    const field=inputRef.current;
    if(field){field.style.height="auto";field.style.height=`${Math.min(field.scrollHeight,176)}px`;}
  },[input]);
  useEffect(()=>{
    if(followLatest.current&&scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight;
  },[sessionId,detail?.messages.length,liveQuestion,liveSteps,clarification,liveReplies]);

  async function refreshConversation(preferredId?:string){
    if(!source)return;
    const items=await listQuerySessions(source.id);setSessions(items);
    const target=preferredId||sessionId||items[0]?.id;
    if(!target){setSessionId(undefined);setDetail(null);return;}
    const selected=await getQuerySession(target);setSessionId(selected.id);setDetail(selected);restorePending(selected);
  }
  function restorePending(selected:QuerySessionDetail){
    const pending=selected.pendingClarification;
    setLiveReplies([]);
    if(!pending){setClarification(null);setLiveQuestion(null);setLiveSteps([]);return;}
    setClarification(pending.response);setLiveQuestion(pending.question);
    setLiveSteps(traceSteps(pending.response.toolTrace));
  }
  async function selectSession(id:string){
    if(loading||sessionLoading||id===sessionId){setHistoryOpen(false);return;}
    setSessionLoading(true);setFailure(null);
    try{const selected=await getQuerySession(id);followLatest.current=true;setSessionId(id);setDetail(selected);setInput("");restorePending(selected);setHistoryOpen(false);}
    catch(cause){setFailure(errorMessage(cause));}finally{setSessionLoading(false);}
  }
  async function newSession(){
    if(!source||loading||sessionLoading)return;
    setSessionLoading(true);setFailure(null);
    try{const created=await createQuerySession(source.id);followLatest.current=true;await refreshConversation(created.id);setInput("");setHistoryOpen(false);}
    catch(cause){setFailure(errorMessage(cause));}finally{setSessionLoading(false);inputRef.current?.focus();}
  }
  async function removeSession(id:string){
    if(loading||sessionLoading)return;
    setSessionLoading(true);setFailure(null);
    try{
      await deleteQuerySession(id);const remaining=sessions.filter((item)=>item.id!==id);setSessions(remaining);
      if(id===sessionId){const next=remaining[0];followLatest.current=true;if(next){const selected=await getQuerySession(next.id);setSessionId(next.id);setDetail(selected);restorePending(selected);}else{setSessionId(undefined);setDetail(null);setClarification(null);setLiveQuestion(null);setLiveSteps([]);setLiveReplies([]);}setInput("");}
    }catch(cause){setFailure(errorMessage(cause));}finally{setSessionLoading(false);}
  }
  function handleStreamEvent(event:QueryStreamEvent){
    if(event.type==="clarification"&&"clarification" in event.result)setLiveSteps(traceSteps(event.result.toolTrace));
    if(event.type==="final"||event.type==="refused"||event.type==="clarification")return;
    setLiveSteps((current)=>updateLiveSteps(current,event));
  }
  async function submit(question=input.trim()){
    if(!question||loading||streamController.current||sessionLoading||!source)return;
    if(clarification){await answerClarification(question);return;}
    const controller=new AbortController();streamController.current=controller;
    let keepLive=false;followLatest.current=true;setInput("");setLoading(true);setFailure(null);setLiveQuestion(question);setLiveSteps([]);setLiveReplies([]);
    try{const result=await askQuestion(question,source.id,sessionId,{onEvent:handleStreamEvent,signal:controller.signal});if("clarification" in result){keepLive=true;setClarification(result);setSessionId(result.sessionId);}else await refreshConversation(result.sessionId);}
    catch(cause){if(!controller.signal.aborted)setFailure(errorMessage(cause));setInput(question);}
    finally{if(streamController.current===controller)streamController.current=null;setLoading(false);if(!keepLive){setLiveQuestion(null);setLiveSteps([]);}}
  }
  async function answerClarification(answer:string){
    if(!answer.trim()||loading||streamController.current||!source||!clarification)return;
    const current=clarification;
    if(!current.clarification.allowFreeText&&!current.clarification.options.includes(answer.trim()))return;
    const controller=new AbortController();streamController.current=controller;let keepLive=false;
    followLatest.current=true;setLoading(true);setFailure(null);setInput("");setClarification(null);
    setLiveReplies((items)=>[...items,{question:current.clarification.question,answer:answer.trim()}]);
    try{const result=await continueQuestion(answer.trim(),source.id,current.sessionId,current.clarification.pendingId,{onEvent:handleStreamEvent,signal:controller.signal});if("clarification" in result){keepLive=true;setClarification(result);}else await refreshConversation(result.sessionId);}
    catch(cause){const expired=controller.signal.aborted||(cause instanceof ApiError&&[404,410].includes(cause.status));keepLive=!expired;if(!expired){setClarification(current);setLiveReplies((items)=>items.slice(0,-1));}if(!controller.signal.aborted)setFailure(errorMessage(cause));setInput(answer);}
    finally{if(streamController.current===controller)streamController.current=null;setLoading(false);if(!keepLive){setLiveQuestion(null);setLiveSteps([]);setLiveReplies([]);}}
  }

  return <div className="chat-page"><div className="chat-layout">
    {historyOpen&&<button className="chat-history-backdrop" aria-label="关闭会话记录" onClick={()=>setHistoryOpen(false)}/>}
    <aside className={`chat-history ${historyOpen?"is-open":""}`} aria-label="会话记录">
      <div className="chat-history-heading"><strong>会话记录</strong><button className="chat-history-close" aria-label="关闭会话记录" onClick={()=>setHistoryOpen(false)}><Icon name="close"/></button></div>
      <button className="chat-new" onClick={()=>void newSession()} disabled={!source||loading||sessionLoading}><Icon name="plus"/>新对话</button>
      <div className="chat-session-list">{sessionLoading&&!sessions.length?<div className="chat-history-empty"><span className="mini-loader"/>读取会话…</div>:sessions.length?sessions.map((item)=><div className={`chat-session ${item.id===sessionId?"is-active":""}`} key={item.id}>
        <button className="chat-session-select" onClick={()=>void selectSession(item.id)} disabled={loading||sessionLoading} aria-current={item.id===sessionId?"true":undefined}><Icon name="message" size={16}/><span><strong>{item.title}</strong><small>{formatDate(item.updatedAt,"—")}</small></span></button>
        <button className="chat-session-delete" aria-label={`删除会话 ${item.title}`} onClick={()=>void removeSession(item.id)} disabled={loading||sessionLoading}><Icon name="trash" size={15}/></button>
      </div>):<div className="chat-history-empty"><Icon name="message" size={22}/><span>还没有对话</span></div>}</div>
      <div className="chat-history-source"><Icon name="database" size={16}/><span>{source?.name||"未选择数据源"}</span></div>
    </aside>
    <section className="chat-conversation" aria-label="AI 问答">
      <header className="chat-heading"><button className="chat-history-toggle" aria-label="打开会话记录" aria-expanded={historyOpen} onClick={()=>setHistoryOpen(true)}><Icon name="message"/></button><div><strong>{detail?.title||"新对话"}</strong><span><i/>{loading?"正在分析":clarification?"等待你的回答":"OntoQuery"}</span></div><button className="chat-heading-new" onClick={()=>void newSession()} disabled={!source||loading||sessionLoading} aria-label="新建对话"><Icon name="plus"/><span>新对话</span></button></header>
      <div className="chat-scroll" ref={scrollRef} onScroll={(event)=>{const el=event.currentTarget;followLatest.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}>
        {sessionLoading&&source?<div className="chat-opening" role="status"><span className="mini-loader"/>正在读取对话…</div>:!hasMessages?<div className="chat-welcome"><div className="chat-welcome-mark"><Icon name="spark" size={32}/></div><h1>今天想了解什么？</h1><p>{source?"直接提问，也可以在回答后继续追问。":"选择一个数据源，开始对话。"}</p>{suggestions.length>0&&<div className="chat-suggestions">{suggestions.map((question)=><button key={question} disabled={loading||!source} onClick={()=>void submit(question)}>{question}<Icon name="arrow" size={16}/></button>)}</div>}</div>:null}
        <div className="chat-thread" role="log" aria-label="对话内容" aria-live="polite" aria-busy={loading||sessionLoading}>
          {detail?.messages.map((message)=>message.role==="user"?<UserMessage key={message.id} text={sessionUserText(message.content)}/>:isQueryResponse(message.content)?<Fragment key={message.id}><ClarificationHistory items={"refused" in message.content?message.content.clarifications:message.content.evidence.clarifications}/>{"refused" in message.content?<QueryRefusalMessage refusal={message.content} role={role} onNavigate={onNavigate} onCreateKnowledge={onCreateKnowledge}/>:<QueryAnswerMessage answer={message.content} onNavigate={onNavigate}/>}</Fragment>:null)}
          {liveQuestion&&<><UserMessage text={liveQuestion}/><ClarificationHistory items={liveReplies}/><AssistantMessage><QueryTimeline liveSteps={liveSteps} running={loading}/>{clarification&&<ClarificationPrompt value={clarification} answer={input} onSelect={(answer)=>{setInput(answer);inputRef.current?.focus();}}/>}</AssistantMessage></>}
        </div>
      </div>
      <div className="chat-composer-dock">
        {failure&&<div className="chat-error" role="alert"><Icon name="shield" size={16}/><span>{failure}</span><button aria-label="关闭错误提示" onClick={()=>setFailure(null)}><Icon name="close" size={16}/></button></div>}
        <form className={`chat-composer ${clarification?"is-asking":""}`} onSubmit={(event)=>{event.preventDefault();void submit();}}>
          {clarification&&<div className="chat-composer-context"><span>ASK</span>{needsOption?"选择上方选项，确认后继续":"选择上方选项，或在这里补充回答"}</div>}
          <textarea ref={inputRef} aria-label={clarification?"回答 AI 追问":"输入业务问题"} value={input} onChange={(event)=>setInput(event.target.value)} placeholder={!source?"请先选择数据源":needsOption?"请选择上方选项":clarification?"补充你的回答…":hasMessages?"继续追问…":"向 OntoQuery 提问…"} rows={1} disabled={!source||loading||sessionLoading} readOnly={needsOption} onKeyDown={(event)=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void submit();}}}/>
          <div className="chat-composer-actions"><span className="chat-input-hint">Enter 发送 · Shift + Enter 换行</span>{loading?<button className="chat-stop" type="button" onClick={()=>streamController.current?.abort()}><span/>停止生成</button>:<button className="chat-send" type="submit" disabled={!input.trim()||!source||sessionLoading||(needsOption&&!clarification?.clarification.options.includes(input.trim()))} aria-label={clarification?"确认回答并继续":"发送问题"}><span>{clarification?"确认并继续":"发送"}</span><Icon name="send" size={17}/></button>}</div>
        </form>
      </div>
    </section>
  </div></div>;
}

function UserMessage({text}:{text:string}){return <article className="chat-user-message" aria-label="你的消息"><p>{text}</p></article>;}
function AssistantMessage({children}:{children:ReactNode}){return <article className="chat-assistant-message" aria-label="OntoQuery 的回复"><div className="chat-assistant-avatar"><Icon name="spark" size={20}/></div><div className="chat-assistant-body"><div className="chat-author">OntoQuery</div>{children}</div></article>;}
function ClarificationHistory({items}:{items?:Array<{question:string;answer:string}>}){return <>{items?.map((item,index)=><Fragment key={`${item.question}-${index}`}><AssistantMessage><span className="chat-ask-label">ASK · 补充确认</span><p className="chat-prose">{item.question}</p></AssistantMessage><UserMessage text={item.answer}/></Fragment>)}</>;}
function ClarificationPrompt({value,answer,onSelect}:{value:QueryClarification;answer:string;onSelect:(answer:string)=>void}){
  const prompt=value.clarification;
  return <div className="chat-ask"><span className="chat-ask-label">ASK · 需要你确认</span><p className="chat-prose" id={`ask-${prompt.pendingId}`}>{prompt.question}</p>{prompt.options.length>0&&<div className="chat-ask-options" role="group" aria-labelledby={`ask-${prompt.pendingId}`}>{prompt.options.map((option,index)=><button type="button" key={option} aria-pressed={answer===option} onClick={()=>onSelect(option)}><span className="chat-option-index">{answer===option?<Icon name="check" size={14}/>:index+1}</span><span>{option}</span></button>)}</div>}</div>;
}

function QueryRefusalMessage({refusal,role,onNavigate,onCreateKnowledge}:{refusal:QueryRefusal;role:string;onNavigate:(id:NavId)=>void;onCreateKnowledge:(prefill:KnowledgePrefill)=>void}){
  const [copied,setCopied]=useState(false);
  const gaps=missingAssetLines(refusal.missingAssets);
  const canEdit=["editor","admin"].includes(role);
  const primaryGap=gaps[0];
  function copyGaps(){navigator.clipboard?.writeText(gaps.map((gap)=>gap.text).join("\n"));setCopied(true);window.setTimeout(()=>setCopied(false),1400);}
  function createFromGap(){if(!primaryGap)return;onCreateKnowledge({pageType:primaryGap.kind==="metric"?"metric":"term",title:primaryGap.label});}
  return <AssistantMessage><QueryTimeline trace={refusal.toolTrace}/><p className="chat-prose">{refusal.reason}</p>{refusal.missingConfiguration&&<p className="chat-secondary">缺少配置：{refusal.missingConfiguration.join("、")}</p>}{gaps.length>0&&<ul className="chat-gap-list">{gaps.map((gap)=><li key={`${gap.kind}:${gap.label}`}>{gap.text}</li>)}</ul>}<div className="chat-message-actions">{primaryGap&&canEdit?<button onClick={createFromGap}><Icon name="plus" size={15}/>补充『{primaryGap.label}』定义</button>:gaps.length?<button onClick={copyGaps}><Icon name={copied?"check":"copy"} size={15}/>{copied?"已复制":"复制缺口描述"}</button>:<button onClick={()=>onNavigate("knowledge")}>查看业务知识<Icon name="arrow" size={15}/></button>}</div></AssistantMessage>;
}

function QueryAnswerMessage({answer,onNavigate}:{answer:QueryAnswer;onNavigate:(id:NavId)=>void}){
  const [copied,setCopied]=useState(false);
  function copySql(){navigator.clipboard?.writeText(answer.evidence.sql);setCopied(true);window.setTimeout(()=>setCopied(false),1400);}
  function exportCsv(){const header=answer.columns.map((column)=>csvCell(column.label)).join(",");const body=answer.rows.map((row)=>answer.columns.map((column)=>csvCell(row[column.key])).join(",")).join("\r\n");const url=URL.createObjectURL(new Blob([`\ufeff${header}\r\n${body}`],{type:"text/csv;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download=`ontoquery-${answer.id}.csv`;link.click();URL.revokeObjectURL(url);}
  const resultSets=answer.resultSets?.length&&answer.resultSets.length>1?answer.resultSets:null;
  const executedSqls=answer.evidence.sqls?.length?answer.evidence.sqls:[{name:"最终执行 SQL",sql:answer.evidence.sql,tables:answer.evidence.tables,joins:answer.evidence.joins||[],scannedRows:answer.evidence.scannedRows,durationMs:answer.evidence.durationMs,rowCount:answer.rows.length}];
  return <AssistantMessage>
    <QueryTimeline trace={answer.evidence.toolTrace}/>
    <p className="chat-prose">{answer.conclusion}</p>{answer.delta&&<p className="chat-prose chat-secondary">{answer.delta}</p>}
    {answer.chart&&<div className="chat-chart"><DataChart answer={answer}/></div>}
    {answer.columns.length>0&&<div className="chat-results"><div className="chat-result-heading"><span>{resultSets?`${resultSets.length} 个结果集`:`${answer.rows.length} 条结果`}</span><button onClick={exportCsv}><Icon name="download" size={15}/>导出 CSV</button></div>{resultSets?resultSets.map((result)=><section className="chat-result-set" key={result.name}><h3>{result.name}<span>{result.rowCount} 行</span></h3><ResultTable columns={result.columns} rows={result.rows}/></section>):<ResultTable columns={answer.columns} rows={answer.rows}/>}</div>}
    <details className="chat-evidence"><summary><Icon name="book" size={15}/><span>查询依据</span><span className="chat-evidence-count">{answer.evidence.pages.length} 项知识 · {answer.evidence.tables.length} 张表</span></summary><div className="chat-evidence-body"><div className="evidence-meta"><EvidenceGroup title="业务知识" items={answer.evidence.pages} color="cyan" emptyText="未命中"/><EvidenceGroup title="业务规则" items={answer.evidence.rules} color="green" emptyText="未命中"/><EvidenceGroup title="数据表" items={answer.evidence.tables} color="violet" emptyText="未记录"/><EvidenceGroup title="关联关系" items={answer.evidence.joins||[]} color="amber" emptyText="单表查询"/></div>{answer.evidence.zeroResultProbe?.findings.length?<p className="chat-secondary">未查询到结果，相关字段可能存在口径差异，请核对业务定义。</p>:null}<SemanticEvidence evidence={answer.evidence}/>{executedSqls.map((item,index)=><div className="sql-card" key={`${item.name}-${index}`}><div><span>{item.name}</span><em>{item.rowCount} 行</em>{index===0&&<button onClick={copySql}><Icon name={copied?"check":"copy"} size={14}/>{copied?"已复制":"复制 SQL"}</button>}</div><pre><code>{item.sql}</code></pre></div>)}<div className="chat-message-actions"><button onClick={()=>onNavigate("knowledge")}><Icon name="plus" size={15}/>补充业务知识</button></div></div></details>
  </AssistantMessage>;
}

type LiveQueryStep={step:number;thought:string;tool?:string;status:"thinking"|"running"|"succeeded"|"failed";summary?:string;durationMs?:number;sql?:string;detail?:string};
function updateLiveSteps(current:LiveQueryStep[],event:Exclude<QueryStreamEvent,{type:"final"|"refused"|"clarification"}>){
  const existing=current.find((item)=>item.step===event.step)||{step:event.step,thought:"正在分析问题",status:"thinking" as const};
  let next={...existing};
  if(event.type==="step")next={...next,status:event.status==="started"?"thinking":event.status==="failed"?"failed":next.status==="failed"?"failed":"succeeded",durationMs:event.durationMs??next.durationMs};
  if(event.type==="thought")next={...next,thought:event.text,status:"thinking"};
  if(event.type==="tool_call")next={...next,tool:event.tool,thought:event.thought||next.thought,status:"running",sql:event.sql,detail:event.detail||event.tables?.join("、")||(event.sample?`${event.sample.table} ${event.sample.columns.join("、")}`:undefined)};
  if(event.type==="tool_result")next={...next,tool:event.tool,thought:event.thought||next.thought,status:event.ok?"succeeded":"failed",summary:event.summary,durationMs:event.durationMs,sql:event.sql||next.sql,detail:event.detail||event.pages?.join("、")||event.tables?.map((item)=>`${item.name}(${item.fieldCount})`).join("、")||(event.sample?`${event.sample.table} ${event.sample.columns.join("、")}`:next.detail)};
  return [...current.filter((item)=>item.step!==event.step),next].sort((left,right)=>left.step-right.step);
}

function traceSteps(trace:QueryToolTrace[]=[]):LiveQueryStep[]{
  return trace.map((item,index)=>({step:item.step??index+1,thought:item.thought||toolLabel(item.tool),tool:item.tool,status:item.ok?"succeeded":"failed",summary:item.summary||item.errorCode,durationMs:item.durationMs,sql:item.sql,detail:item.detail||item.pages?.join("、")||item.tables?.map((table)=>`${table.name}(${table.fieldCount})`).join("、")||(item.sample?`${item.sample.table} ${item.sample.columns.join("、")}`:undefined)}));
}

function QueryTimeline({trace,liveSteps,running=false}:{trace?:QueryToolTrace[];liveSteps?:LiveQueryStep[];running?:boolean}){
  const steps=liveSteps||traceSteps(trace);
  if(!steps.length)return running?<div className="timeline-waiting" role="status"><span className="mini-loader"/>正在理解问题，准备调用工具…</div>:null;
  const duration=steps.reduce((sum,item)=>sum+Number(item.durationMs||0),0);
  const busy=steps.some((item)=>item.status==="thinking"||item.status==="running");
  return <details className={`query-timeline${running?" live":""}`} open><summary>{running?<i className="mini-loader"/>:<Icon name="graph" size={14}/>}<strong>{running?busy?"正在调用工具":"正在继续分析":liveSteps?"等待你补充":"执行过程"}</strong><span>{steps.length} 步{!running&&duration>0?` · 工具用时 ${(duration/1000).toFixed(1)} 秒`:""}<Icon name="arrow" size={14}/></span></summary>
    <div className="query-timeline-list">{steps.map((item)=><article className={`query-timeline-step ${item.status}`} key={item.step}><span className="timeline-status">{item.status==="thinking"||item.status==="running"?<i className="mini-loader"/>:<Icon name={item.status==="failed"?"shield":"check"} size={13}/>}</span><div><small>步骤 {item.step}{item.tool?` · ${item.tool} · ${toolLabel(item.tool)}`:""} · {item.status==="failed"?"失败":item.status==="succeeded"?"完成":"进行中"}</small><strong>{item.thought}</strong>{item.detail&&<em>{item.detail}</em>}{item.sql&&<details open><summary>查询 SQL</summary><code>{item.sql}</code></details>}{item.summary&&<p>{item.summary}</p>}</div>{item.durationMs!=null&&<time>{item.durationMs} ms</time>}</article>)}</div>
  </details>;
}

function toolLabel(tool:string){return ({ontology_read:"查阅业务定义",db_query:"查询数据",search_context:"检索知识",get_schema:"查看结构",sample_data:"采样数据",validate_semantic_plan:"校验语义计划",run_sql:"执行 SQL",ask_user:"澄清口径",submit_answer:"提交答案",refuse:"安全拒答"})[tool]||tool;}

function isQueryResponse(content:QuerySessionDetail["messages"][number]["content"]):content is QueryAnswer|QueryRefusal{return Boolean(content&&typeof content==="object"&&("refused" in content||"conclusion" in content));}
function sessionUserText(content:QuerySessionDetail["messages"][number]["content"]){return "text" in content?String(content.text||""):"";}

function SourcesWorkspace({sources,selectedId,onSelect,onRefresh}:{sources:DataSource[];selectedId?:number;onSelect:(id:number)=>Promise<void>;onRefresh:()=>Promise<void>}){
  const initial:SourceInput={name:"",host:"127.0.0.1",port:3306,dbName:"",userName:"",password:""};const [form,setForm]=useState(initial);const [saving,setSaving]=useState(false);const [testing,setTesting]=useState<number|null>(null);const [rotating,setRotating]=useState<number|null>(null);const [newPassword,setNewPassword]=useState("");const [message,setMessage]=useState<string|null>(null);const [failure,setFailure]=useState<string|null>(null);
  async function submit(event:FormEvent){event.preventDefault();setSaving(true);setFailure(null);try{const source=await createSource(form);setForm(initial);setMessage("数据源已加密保存。请执行只读连接测试后再开始探查。");await onRefresh();await onSelect(source.id);}catch(cause){setFailure(errorMessage(cause));}finally{setSaving(false);}}
  async function runTest(source:DataSource){setTesting(source.id);setFailure(null);try{const result=await testSource(source.id);setMessage(`只读校验通过：${result.server||"MySQL"}，连接耗时 ${result.latencyMs} ms。`);await onRefresh();}catch(cause){setFailure(errorMessage(cause));await onRefresh();}finally{setTesting(null);}}
  async function rotate(event:FormEvent,source:DataSource){event.preventDefault();if(!newPassword)return;setFailure(null);try{await rotateSourceCredential(source.id,newPassword);setMessage("凭据已重新加密保存，旧连接池已关闭；请重新执行只读连接测试。");setRotating(null);setNewPassword("");await onRefresh();}catch(cause){setFailure(errorMessage(cause));}}
  return <div className="content sub-page"><PageHeader eyebrow="只读连接" title="数据源配置" description="凭据只在本地 API 中加密保存；浏览器不会读取已保存密码。"/>{message&&<Notice tone="success" title="操作完成" body={message}/>} {failure&&<Notice tone="danger" title="操作失败" body={failure}/>}<div className="source-layout"><section className="panel source-list-panel"><div className="panel-title"><div><h2>已配置数据源</h2><p>真实源在只读校验通过前不能视为可用。</p></div><span>{sources.length} 个</span></div><div className="source-list">{sources.map((source)=><article className={source.id===selectedId?"selected":""} key={source.id}><button className="source-main" onClick={()=>void onSelect(source.id)}><span className={source.lastTestOk===0?"status-dot offline":"status-dot"}/><div><strong>{source.name}</strong><small>{source.userName}@{source.host}:{source.port}/{source.dbName}</small></div><em>{source.isDemo?"DEMO":source.lastTestOk?"只读已验证":"待验证"}</em></button><div className="source-meta"><span>最近测试：{formatDate(source.lastTestAt,"未测试")}</span><span>最近探查：{formatDate(source.lastDiscoveryAt,"未探查")}</span>{!source.isDemo&&<><button onClick={()=>void runTest(source)} disabled={testing===source.id}>{testing===source.id?"测试中…":"测试只读连接"}</button><button onClick={()=>{setRotating(rotating===source.id?null:source.id);setNewPassword("");}}>轮换凭据</button></>}</div>{rotating===source.id&&<form className="credential-rotate" onSubmit={(event)=>void rotate(event,source)}><input aria-label={`${source.name} 新密码`} type="password" autoComplete="new-password" value={newPassword} onChange={(event)=>setNewPassword(event.target.value)} placeholder="输入新密码"/><button type="submit" disabled={!newPassword}>保存并关闭旧连接</button></form>}{source.lastTestError&&<p className="source-error">{source.lastTestError}</p>}</article>)}</div></section><form className="panel source-form" onSubmit={submit}><span className="section-kicker">新增 MySQL</span><h2>连接只读副本</h2><p>连接测试会尝试创建临时表；如果成功，说明账号权限过大，测试将失败。</p><div className="form-grid"><Field label="名称"><input required value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})} placeholder="生产账单只读副本"/></Field><Field label="主机"><input required value={form.host} onChange={(e)=>setForm({...form,host:e.target.value})}/></Field><Field label="端口"><input required type="number" min="1" max="65535" value={form.port} onChange={(e)=>setForm({...form,port:Number(e.target.value)})}/></Field><Field label="数据库"><input required value={form.dbName} pattern="[A-Za-z0-9_$-]+" onChange={(e)=>setForm({...form,dbName:e.target.value})}/></Field><Field label="用户名"><input required autoComplete="username" value={form.userName} onChange={(e)=>setForm({...form,userName:e.target.value})}/></Field><Field label="密码"><input required type="password" autoComplete="new-password" value={form.password} onChange={(e)=>setForm({...form,password:e.target.value})}/></Field></div><button className="primary-button" type="submit" disabled={saving}>{saving?"保存中…":"加密保存数据源"}</button></form></div></div>;
}

function TableSelectionPanel({source,onLaunch,onClose}:{source:DataSource;onLaunch:()=>Promise<void>;onClose:()=>void}){
  const [rows,setRows]=useState<TableSelectionRow[]|null>(null);const [failure,setFailure]=useState<string|null>(null);const [saving,setSaving]=useState(false);const [search,setSearch]=useState("");
  const [choices,setChoices]=useState<Map<string,boolean>>(new Map());
  useEffect(()=>{let cancelled=false;previewSourceTables(source.id).then((data)=>{if(cancelled)return;setRows(data.tables);setChoices(new Map(data.tables.map((row)=>[row.tableName,Boolean(row.included)])));}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});return()=>{cancelled=true;};},[source.id]);
  const visible=(rows||[]).filter((row)=>!search||row.tableName.toLowerCase().includes(search.toLowerCase())||(row.comment||"").includes(search));
  const includedCount=[...choices.values()].filter(Boolean).length;
  function setAll(value:boolean){setChoices((previous)=>{const next=new Map(previous);for(const row of visible)next.set(row.tableName,value);return next;});}
  async function confirm(){
    if(!rows)return;setSaving(true);setFailure(null);
    try{await saveTableSelections(source.id,rows.map((row)=>({tableName:row.tableName,included:choices.get(row.tableName)!==false})));await onLaunch();onClose();}
    catch(cause){setFailure(errorMessage(cause));}
    finally{setSaving(false);}
  }
  return <div className="editor-backdrop" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!saving)onClose();}}><section className="knowledge-editor table-selection-modal" role="dialog" aria-modal="true" aria-labelledby="table-selection-title"><div className="editor-header"><div><span className="section-kicker">探查范围</span><h2 id="table-selection-title">选择要探查的表</h2></div><button aria-label="关闭" onClick={onClose}><Icon name="close"/></button></div><div className="editor-body">
    <p className="selection-hint">未勾选的表不会被探查，也不会出现在本体、图谱、消歧队列和问数中；已探查过的表取消勾选后，其结构、枚举与待确认项会立即移除。</p>
    {failure&&<Notice tone="danger" title="操作失败" body={failure}/>}
    {!rows?<p className="selection-loading"><span className="mini-loader"/>正在读取数据库表清单…</p>:<>
      <div className="knowledge-tools"><div className="search-input"><Icon name="search"/><input aria-label="搜索表" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="按表名或注释过滤…"/></div><span>共 {rows.length} 张表 · 已选 {includedCount}</span><div className="selection-bulk"><button className="secondary-button" onClick={()=>setAll(true)}>全选可见</button><button className="secondary-button" onClick={()=>setAll(false)}>排除可见</button></div></div>
      <div className="table-responsive selection-scroll"><table className="data-table"><thead><tr><th>探查</th><th>表</th><th>行数估算</th><th>状态</th></tr></thead><tbody>{visible.map((row)=><tr key={row.tableName}><td><input type="checkbox" aria-label={`探查 ${row.tableName}`} checked={choices.get(row.tableName)!==false} onChange={(event)=>setChoices((previous)=>new Map(previous).set(row.tableName,event.target.checked))}/></td><td><strong>{row.tableName}</strong><small>{row.comment||"无表注释"}</small></td><td>{formatInteger(row.rowEstimate)}</td><td>{row.probed?`已探查${row.grade?` · ${row.grade}`:""}`:"未探查"}{row.decidedBy?` · ${row.decidedBy} 决定`:""}</td></tr>)}</tbody></table></div>
    </>}
  </div><div className="editor-actions"><button className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" onClick={()=>void confirm()} disabled={saving||!rows||includedCount===0}>{saving?"保存并启动中…":`保存范围并探查 ${includedCount} 张表`}</button></div></section></div>;
}

function DiscoveryWorkspace({source,discovery,tasks,snapshots,onRefresh}:{source:DataSource|null;discovery:DiscoverySummary|null;tasks:BackgroundTask[];snapshots:SchemaSnapshot[];onRefresh:()=>Promise<void>}){
  const latest=tasks.find((item)=>item.taskType==="discovery")||null;const [task,setTask]=useState<BackgroundTask|null>(latest);const [filter,setFilter]=useState("全部");const [failure,setFailure]=useState<string|null>(null);const [updating,setUpdating]=useState<string|null>(null);const [selecting,setSelecting]=useState(false);const tables=discovery?.tables||[];const filtered=filter==="全部"?tables:tables.filter((table)=>table.grade===filter);const scanning=task?.status==="queued"||task?.status==="running";
  useEffect(()=>{if(!task||!['queued','running'].includes(task.status))return;let cancelled=false;const timer=window.setTimeout(()=>{void getTask(task.id).then(async(next)=>{if(cancelled)return;setTask(next);if(next.status==="succeeded")await onRefresh();if(next.status==="failed")setFailure(next.error||"异步探查失败");}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});},900);return()=>{cancelled=true;window.clearTimeout(timer);};},[task,onRefresh]);
  async function scan(){if(!source)return;setFailure(null);try{setTask(await discoverSource(source.id));}catch(cause){setFailure(errorMessage(cause));}}
  async function changeGrade(tableName:string,grade:"A"|"B"|"C"){if(!source)return;setUpdating(tableName);try{await setTableGrade(source.id,tableName,grade);await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setUpdating(null);}}
  const diff=task?.result&&"schemaDiff" in task.result?task.result.schemaDiff:undefined;
  const relationMeta=discovery?.relationDiscovery;
  const modelStatus=relationMeta?.modelStatus==="completed"?`模型已判断 ${relationMeta.judgedCount}`:relationMeta?.modelStatus==="not_configured"?"模型未配置":relationMeta?.modelStatus==="failed"?"模型判断失败":relationMeta?.modelStatus==="partial"?`模型部分完成 ${relationMeta.judgedCount}`:"尚未模型判断";
  return <div className="content sub-page"><PageHeader eyebrow="数据库体检" title="数据探查与表分级" description={source?`当前数据源：${source.name} / ${source.dbName}`:"请先配置数据源"} action={<button className="primary-button" onClick={()=>setSelecting(true)} disabled={!source||scanning||(!source.isDemo&&source.lastTestOk!==1)}><Icon name="refresh" className={scanning?"spin":""}/>{scanning?"后台探查中…":"选择范围并探查"}</button>}/>{selecting&&source&&<TableSelectionPanel source={source} onLaunch={scan} onClose={()=>setSelecting(false)}/>}{failure&&<Notice tone="danger" title="探查失败" body={failure}/>} {!scanning&&relationMeta?.error&&<Notice tone="danger" title="上次关系模型未完整执行" body={relationMeta.error}/>} {scanning&&task&&<section className="task-progress panel"><div><span className="mini-loader"/><strong>{task.currentStep||"等待执行"}</strong><em>{task.progress}%</em></div><p>任务已持久化，可离开页面或重启本地服务；恢复后会从安全检查点重新执行。</p><span><i style={{width:`${task.progress}%`}}/></span></section>} {task?.status==="succeeded"&&diff&&<section className="schema-diff panel"><div><strong>Schema v{diff.currentVersion||snapshots[0]?.version||1}</strong><span>{diff.changed?"检测到结构变化":"结构无变化"}</span></div><p>新增表 {diff.addedTables.length} · 移除表 {diff.removedTables.length} · 变更表 {diff.changedTables.length} · 新增字段 {diff.addedColumns.length} · 移除字段 {diff.removedColumns.length}</p></section>}<div className="metric-grid"><MetricCard label="已发现表" value={String(discovery?.totalTables||0)} meta={`A ${discovery?.grades.A||0} · B ${discovery?.grades.B||0} · C ${discovery?.grades.C||0}`} tone="cyan"/><MetricCard label="关系" value={String(discovery?.relations||0)} meta={`显式 ${relationMeta?.explicit||0} · 模型建议 ${relationMeta?.modelSuggested||0} · ${modelStatus}`} tone="violet"/><MetricCard label="Schema 版本" value={String(snapshots[0]?.version||diff?.currentVersion||0)} meta={formatDate(source?.lastDiscoveryAt,"尚未探查")} tone="green"/></div><section className="panel"><div className="panel-title"><div><h2>表分级总览</h2><p>人工覆盖写入 grade_override，重跑探针后保留；失效结构保留历史但不进入检索。</p></div><div className="segmented">{["全部","A","B","C"].map((grade)=><button className={filter===grade?"active":""} onClick={()=>setFilter(grade)} key={grade}>{grade}</button>)}</div></div>{filtered.length?<div className="table-responsive"><table className="data-table"><thead><tr><th>表</th><th>级别</th><th>行数估算</th><th>最近活跃</th><th>最近探针</th><th>人工覆盖</th></tr></thead><tbody>{filtered.map((table)=><tr key={table.tableName}><td><strong>{table.tableName}</strong><small>{table.comment||"无表注释"}</small></td><td><span className={`grade grade-${table.grade.toLowerCase()}`}>{table.grade}</span></td><td>{formatInteger(table.rowEstimate)}</td><td>{table.daysSinceWrite==null?"未知":table.daysSinceWrite===0?"今天":`${table.daysSinceWrite} 天前`}</td><td>{formatDate(table.lastProbeAt,"未探针")}</td><td><select aria-label={`覆盖 ${table.tableName} 分级`} value={table.gradeOverride||table.grade} disabled={updating===table.tableName} onChange={(event)=>void changeGrade(table.tableName,event.target.value as "A"|"B"|"C")}><option value="A">A 核心</option><option value="B">B 辅助</option><option value="C">C 排除</option></select>{table.gradeOverride&&<small>已人工覆盖</small>}</td></tr>)}</tbody></table></div>:<EmptyState title="还没有探查结果" body="配置并验证真实 MySQL 后，点击“开始真实探查”。演示源也会从 SQLite 读取其真实样例结构。"/>}</section></div>;
}

function QuestionsWorkspace({items,onRefresh}:{items:OntologyQuestion[];onRefresh:()=>Promise<void>}){const [answering,setAnswering]=useState<number|null>(null);const [failure,setFailure]=useState<string|null>(null);async function choose(item:OntologyQuestion,choice:string){setAnswering(item.id);setFailure(null);try{await answerQuestion(item.id,choice);await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setAnswering(null);}}return <div className="content sub-page"><PageHeader eyebrow="交互式消歧" title="只询问影响 SQL 正确性的歧义" description="每个问题必须携带探针证据；回答会写回关系、规则或枚举知识。"/>{failure&&<Notice tone="danger" title="回答未保存" body={failure}/>}<div className="question-progress"><div><strong>{items.length}</strong><span>个问题待确认</span></div><div><strong>{items.filter((item)=>item.scope==="global").length}</strong><span>个问题支持全局外推</span></div><div className="progress-copy"><span>{items.length?"按价值排序，C 级表不会提问":"本轮已完成"}</span><em><i style={{width:items.length?"18%":"100%"}}/></em></div></div><div className="question-list">{items.length===0?<EmptyState title="没有待决问题" body="探查产生的中低置信 JOIN、枚举、金额单位和废弃表判断会出现在这里。"/>:items.map((item,index)=><article className="question-card" key={item.id}><div className="question-number">{String(index+1).padStart(2,"0")}</div><div className="question-body"><div className="question-tags"><span>{item.kind}</span><em>{[item.tableName,item.columnName].filter(Boolean).join(".")||item.scope}</em></div><h2>{item.question}</h2><div className="evidence-note"><span>探针证据</span><p>{item.evidence}</p></div><div className="option-grid">{item.options.map((option,optionIndex)=><button key={option} className={optionIndex===0?"recommended":""} disabled={answering===item.id} onClick={()=>void choose(item,option)}><span>{optionIndex===0?"建议":"选项"}</span>{option}</button>)}</div></div></article>)}</div></div>;}

function KnowledgeWorkspace({sourceId,pages,role,prefill,onPrefillConsumed,onRefresh}:{sourceId?:number;pages:KnowledgePage[];role:string;prefill?:KnowledgePrefill|null;onPrefillConsumed?:()=>void;onRefresh:()=>Promise<void>}){
  const [search,setSearch]=useState("");const [editor,setEditor]=useState<KnowledgeInput|null>(()=>prefill&&sourceId?{sourceId,pageType:prefill.pageType,title:prefill.title,aliases:[],tables:[],content:"",sqlContent:"",antiExamples:"",verified:false,owner:""}:null);const [failure,setFailure]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const [saving,setSaving]=useState(false);const [syncing,setSyncing]=useState(false);const filtered=pages.filter((page)=>normalize(`${page.pageType}${page.title}${page.aliases.join(" ")}${page.content}`).includes(normalize(search)));const coverage=useMemo(()=>coverageByType(pages),[pages]);
  function openNew(){if(!sourceId)return;setEditor({sourceId,pageType:"term",title:"",aliases:[],tables:[],content:"",sqlContent:"",antiExamples:"",verified:false,owner:""});}
  useEffect(()=>{if(prefill)onPrefillConsumed?.();},[prefill,onPrefillConsumed]);
  const canViewGaps=["editor","admin"].includes(role);
  const [gapBoard,setGapBoard]=useState<CapabilityGapBoard|null>(null);
  useEffect(()=>{
    if(!sourceId||!canViewGaps)return;
    let cancelled=false;
    void listCapabilityGaps(sourceId).then((board)=>{if(!cancelled)setGapBoard(board);}).catch(()=>{/* The gap board is auxiliary; the workspace stays usable without it. */});
    return()=>{cancelled=true;};
  },[sourceId,canViewGaps,pages]);
  function applyRemedy(gap:CapabilityGap){
    if(!sourceId)return;
    // A page-health gap points at a page that already exists: open it for editing so the
    // operator fixes the declaration in place instead of creating a rival definition.
    const existing=gap.remedy.action==="edit_knowledge_page"?pages.find((page)=>page.pageType===gap.remedy.prefill?.pageType&&page.slug===gap.remedy.prefill?.slug):undefined;
    if(existing)return openEdit(existing);
    const pageType=gap.remedy.prefill?.pageType==="metric"?"metric" as const:"term" as const;
    setEditor({sourceId,pageType,title:gap.remedy.prefill?.title||gap.assetLabel,aliases:[],tables:[],content:"",sqlContent:"",antiExamples:"",verified:false,owner:""});
  }
  function openEdit(page:KnowledgePage){if(!sourceId||page.pageType==="table")return;setEditor({sourceId,pageType:page.pageType,title:page.title,slug:page.slug,aliases:page.aliases,tables:page.tables,content:page.content,sqlContent:page.sqlContent||"",antiExamples:page.antiExamples||"",verified:page.verified,owner:page.owner||""});}
  async function save(){if(!editor)return;setSaving(true);setFailure(null);try{await saveKnowledge(editor);setEditor(null);await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setSaving(false);}}
  async function sync(){if(!sourceId)return;setSyncing(true);setFailure(null);setMessage(null);try{const result=await syncKnowledge(sourceId);setMessage(`扫描 ${result.scanned} 个文件，导入 ${result.imported} 个，跳过自动页 ${result.skipped} 个${result.errors.length?`，${result.errors.length} 个文件失败`:""}。`);await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setSyncing(false);}}
  return <div className="content sub-page"><PageHeader eyebrow="Markdown + Wikilink" title="可审阅、可追溯的业务本体" description="这里展示当前数据源的真实表、JOIN、规则、术语和指标；没有资产时保持为空。" action={<div className="header-actions"><button className="secondary-button" onClick={()=>void sync()} disabled={!sourceId||syncing}><Icon name="refresh" className={syncing?"spin":""}/>{syncing?"同步中…":"从 Markdown 同步"}</button><button className="primary-button" onClick={openNew} disabled={!sourceId}><Icon name="plus"/>新建知识页</button></div>}/>{failure&&<Notice tone="danger" title="知识操作失败" body={failure}/>} {message&&<Notice tone="success" title="Markdown 同步完成" body={message}/>}<div className="asset-grid">{([["term","术语","cyan"],["metric","指标","amber"],["join","JOIN","violet"],["rule","规则","green"]] as const).map(([type,label,color])=><div className={`asset-card ${color}`} key={type}><div><span>{label}</span><strong>{coverage[type].total}</strong></div><small className={type==="metric"&&coverage.metric.verified===0?"coverage-alert":undefined}>{coverage[type].verified} 个已验证{type==="metric"&&coverage.metric.verified===0?" · 指标覆盖缺失":""}</small><em><i style={{width:coverage[type].total?`${coverage[type].verified/coverage[type].total*100}%`:"0%"}}/></em></div>)}</div>{canViewGaps&&gapBoard?<CapabilityGapPanel board={gapBoard} onApplyRemedy={applyRemedy}/>:null}<section className="panel"><div className="knowledge-tools"><div className="search-input"><Icon name="search"/><input aria-label="搜索知识资产" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="搜索术语、指标、规则或表…"/></div><span>共 {pages.length} 个条目 · {pages.filter((page)=>page.verified).length} 个已验证</span></div><div className="knowledge-list">{filtered.length?filtered.map((page)=><article key={`${page.pageType}:${page.slug}`}><div className={`page-type type-${typeLabel(page.pageType)}`}>{typeLabel(page.pageType)}</div><div><h3>{page.title}{page.verified&&<span><Icon name="check" size={11}/>已验证</span>}</h3><p>{page.content||"暂无业务描述"}</p><small><Icon name="database" size={12}/>{page.tables.join(" · ")||"未绑定表"}</small></div><button aria-label={`${page.pageType==="table"?"查看":"编辑"}${page.title}`} onClick={()=>openEdit(page)} disabled={page.pageType==="table"}><Icon name="arrow"/></button></article>):<EmptyState title="没有匹配的知识资产" body={search?"清空搜索词后查看全部资产。":"探查会生成表与 JOIN 页；术语和指标需要业务人员确认。"}/>}</div></section>{editor&&<KnowledgeEditor value={editor} onChange={setEditor} onClose={()=>setEditor(null)} onSave={()=>void save()} saving={saving}/>}</div>;
}

function CapabilityGapPanel({board,onApplyRemedy}:{board:CapabilityGapBoard;onApplyRemedy:(gap:CapabilityGap)=>void}){
  const openGaps=board.gaps.filter((gap)=>gap.status==="open");
  const resolvedGaps=board.gaps.filter((gap)=>gap.status==="resolved");
  if(!board.gaps.length)return null;
  return <section className="panel capability-gap-panel"><div className="panel-title"><div><h2>知识缺口</h2><p>基于最近 {board.auditWindow} 条拒答/失败审计实时聚合；补齐资产后缺口自动闭环。</p></div><span className="gap-count">{openGaps.length} 个待处理</span></div>
    {openGaps.length?<div className="gap-list">{openGaps.map((gap)=>{const pageHealth=gap.key.startsWith("PAGE:");return <article key={gap.key}><div className="gap-main"><strong>{gap.assetLabel}</strong><small>{pageHealth?`已验证页面语义${gap.code==="PAGE_SEMANTIC_INVALID"?"不可用":"降级"} · 更新于 ${formatDate(gap.lastAskedAt,"—")}`:`被问 ${gap.count} 次 · 最近 ${formatDate(gap.lastAskedAt,"—")} · ${gap.code.startsWith("CLASS:")?"未分类缺口":gap.code}`}</small>{gap.detail?<p className="gap-detail">{gap.detail}</p>:gap.sampleQuestions.length?<p>{gap.sampleQuestions[0]}</p>:null}</div>{["create_metric_page","create_term_page","edit_knowledge_page"].includes(gap.remedy.action)?<button onClick={()=>onApplyRemedy(gap)}><Icon name={pageHealth?"arrow":"plus"} size={13}/>{pageHealth?"修正声明":"补充定义"}</button>:<span className="gap-action-hint">{gapActionLabel(gap.remedy.action)}</span>}</article>;})}</div>:<p className="gap-empty">没有待处理缺口。</p>}
    {resolvedGaps.length?<details className="gap-resolved"><summary>{resolvedGaps.length} 个已闭环</summary>{resolvedGaps.map((gap)=><article key={gap.key}><div className="gap-main"><strong>{gap.assetLabel}</strong><small>被问 {gap.count} 次 · 已有匹配的已验证资产</small></div><span className="gap-resolved-pill"><Icon name="check" size={12}/>已闭环</span></article>)}</details>:null}
  </section>;
}
function gapActionLabel(action:string){return ({publish_ontology_property:"需发布本体属性",publish_product_registry:"需发布产品注册表",configure_llm:"需在设置中心配置 LLM",review_enum_dictionary:"需复核枚举字典",review_audit:"需人工复核审计"})[action]||"需人工处理";}

function KnowledgeEditor({value,onChange,onClose,onSave,saving}:{value:KnowledgeInput;onChange:(next:KnowledgeInput)=>void;onClose:()=>void;onSave:()=>void;saving:boolean}){return <div className="editor-backdrop" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose();}}><section className="knowledge-editor" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title"><div className="editor-header"><div><span className="section-kicker">知识资产</span><h2 id="knowledge-editor-title">{value.slug?"编辑知识页":"新建知识页"}</h2></div><button aria-label="关闭" onClick={onClose}><Icon name="close"/></button></div><div className="editor-body"><div className="form-grid"><Field label="页面类型"><select value={value.pageType} disabled={Boolean(value.slug)} onChange={(event)=>onChange({...value,pageType:event.target.value as KnowledgeInput["pageType"]})}><option value="term">术语 term</option><option value="metric">指标 metric</option><option value="rule">规则 rule</option><option value="join">JOIN</option></select></Field><Field label="标题"><input value={value.title} onChange={(event)=>onChange({...value,title:event.target.value})}/></Field><Field label="别名（逗号分隔）"><input value={value.aliases.join(", ")} onChange={(event)=>onChange({...value,aliases:splitList(event.target.value)})}/></Field><Field label="关联表（逗号分隔）"><input value={value.tables.join(", ")} onChange={(event)=>onChange({...value,tables:splitList(event.target.value)})}/></Field></div><Field label="业务定义"><textarea rows={4} value={value.content} onChange={(event)=>onChange({...value,content:event.target.value})}/></Field><Field label={value.pageType==="metric"?"完整参考 SQL":"SQL 片段 / ON 条件"}><textarea className="mono-input" rows={6} value={value.sqlContent} onChange={(event)=>onChange({...value,sqlContent:event.target.value})}/></Field><Field label="反例与陷阱"><textarea rows={3} value={value.antiExamples} onChange={(event)=>onChange({...value,antiExamples:event.target.value})}/></Field><div className="verify-row"><label><input type="checkbox" checked={value.verified} onChange={(event)=>onChange({...value,verified:event.target.checked})}/>标记为人工验证</label>{value.verified&&<input placeholder="负责人" value={value.owner} onChange={(event)=>onChange({...value,owner:event.target.value})}/>}</div></div><div className="editor-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving||!value.title||!value.sqlContent||(value.verified&&!value.owner)} onClick={onSave}>{saving?"保存中…":"保存并写入 Markdown"}</button></div></section></div>;}

function EvaluationWorkspace({source,cases,runs,gates,tasks,onRefresh}:{source:DataSource|null;cases:EvalCase[];runs:EvalRun[];gates:EvaluationGate[];tasks:BackgroundTask[];onRefresh:()=>Promise<void>}){
  const empty:EvalInput={sourceId:source?.id||0,setName:"regression",question:"",goldSql:"",category:"核心口径",heldOut:false};
  const [form,setForm]=useState<EvalInput>(empty);const [editing,setEditing]=useState<number|undefined>();const [saving,setSaving]=useState(false);const [failure,setFailure]=useState<string|null>(null);const [selectedSet,setSelectedSet]=useState(cases[0]?.setName||"regression");const [evalMode,setEvalMode]=useState<"off"|"prefer"|"required">("off");const latest=tasks.find((item)=>["evaluation","evaluation_gate","evaluation_agent_gate"].includes(item.taskType))||null;const [task,setTask]=useState<BackgroundTask|null>(latest);const running=task?.status==="queued"||task?.status==="running";const sets=[...new Set(cases.map((item)=>item.setName))];const standardRuns=runs.filter((item)=>!item.comparisonRole);const latestBatch=standardRuns[0]?.batchId;const latestRuns=latestBatch?standardRuns.filter((item)=>item.batchId===latestBatch):[];const passRate=latestRuns.length?Math.round(latestRuns.filter((item)=>item.passed).length/latestRuns.length*100):null;const summary=task?.result&&"failures" in task.result?task.result as EvaluationSummary:null;const latestGate=gates[0]||null;
  useEffect(()=>{if(!task||!['queued','running'].includes(task.status))return;let cancelled=false;const timer=window.setTimeout(()=>{void getTask(task.id).then(async(next)=>{if(cancelled)return;setTask(next);if(next.status==="succeeded")await onRefresh();if(next.status==="failed")setFailure(next.error||"评测任务失败");}).catch((cause)=>{if(!cancelled)setFailure(errorMessage(cause));});},900);return()=>{cancelled=true;window.clearTimeout(timer);};},[task,onRefresh]);
  async function save(event:FormEvent){event.preventDefault();if(!source)return;setSaving(true);setFailure(null);try{await saveEvalCase({...form,sourceId:source.id},editing);setEditing(undefined);setForm({...empty,sourceId:source.id,setName:form.setName});await onRefresh();}catch(cause){setFailure(errorMessage(cause));}finally{setSaving(false);}}
  function edit(item:EvalCase){setEditing(item.id);setForm({sourceId:source?.id||0,setName:item.setName,question:item.question,goldSql:item.goldSql||"",category:item.category,heldOut:Boolean(item.heldOut)});}
  async function archive(id:number){setFailure(null);try{await archiveEvalCase(id);if(editing===id){setEditing(undefined);setForm(empty);}await onRefresh();}catch(cause){setFailure(errorMessage(cause));}}
  async function run(){if(!source||!selectedSet)return;setFailure(null);try{setTask(await runEvaluation(source.id,selectedSet,evalMode));}catch(cause){setFailure(errorMessage(cause));}}
  async function runGate(){if(!source||!selectedSet)return;setFailure(null);try{setTask(await runEvaluationGate(source.id,selectedSet));}catch(cause){setFailure(errorMessage(cause));}}
  async function runAgentGate(){if(!source||!selectedSet)return;setFailure(null);try{setTask(await runAgentEvaluationGate(source.id,selectedSet));}catch(cause){setFailure(errorMessage(cause));}}
  return <div className="content sub-page"><PageHeader eyebrow="评测驱动闭环" title="用结果集等价检验每一次改进" description="Gold SQL 先通过同一套只读护栏，再与问数结果做顺序无关、数值容差等价判定。" action={<div className="eval-run-action"><select aria-label="选择评测集" value={selectedSet} onChange={(event)=>setSelectedSet(event.target.value)}>{sets.length?sets.map((name)=><option key={name}>{name}</option>):<option>regression</option>}</select><select aria-label="评测 Agent 模式" value={evalMode} onChange={(event)=>setEvalMode(event.target.value as "off"|"prefer"|"required")}><option value="off">单发 off</option><option value="prefer">Agent prefer</option><option value="required">Agent required</option></select><button className="secondary-button" onClick={()=>void runAgentGate()} disabled={!source||source.isDemo||!cases.length||running}><Icon name="graph"/>运行 Agent 门禁</button><button className="secondary-button" onClick={()=>void runGate()} disabled={!source||source.isDemo||!cases.length||running}><Icon name="shield"/>运行语义门禁</button><button className="primary-button" onClick={()=>void run()} disabled={!source||source.isDemo||!cases.length||running}><Icon name="target"/>{running?"后台评测中…":"运行评测集"}</button></div>}/>{failure&&<Notice tone="danger" title="评测操作失败" body={failure}/>} {running&&task&&<section className="task-progress panel"><div><span className="mini-loader"/><strong>{task.currentStep||"等待执行"}</strong><em>{task.progress}%</em></div><p>评测在后台持久化运行；每条失败会分类并生成知识修复建议。</p><span><i style={{width:`${task.progress}%`}}/></span></section>}{latestGate&&<EvaluationGatePanel gate={latestGate}/>}<div className="metric-grid"><MetricCard label="评测用例" value={String(cases.length)} meta={`${sets.length} 个评测集`} tone="cyan"/><MetricCard label="Held-out" value={String(cases.filter((item)=>item.heldOut).length)} meta="Gold SQL 不通过读取 API 暴露" tone="violet"/><MetricCard label="带 Gold SQL" value={String(cases.filter((item)=>item.hasGoldSql||item.goldSql).length)} meta="全部经过 AST 安全校验" tone="green"/><MetricCard label="最近通过率" value={passRate==null?"—":`${passRate}%`} meta={latestRuns.length?`${latestRuns.filter((item)=>item.passed).length}/${latestRuns.length} 结果等价`:"尚未运行"} tone="amber"/></div><div className="evaluation-layout"><form className="panel eval-form" onSubmit={save}><span className="section-kicker">{editing?"编辑用例":"新增用例"}</span><h2>回归问题与 Gold SQL</h2><div className="form-grid"><Field label="评测集"><input required value={form.setName} onChange={(event)=>setForm({...form,setName:event.target.value})}/></Field><Field label="分类"><input required value={form.category} onChange={(event)=>setForm({...form,category:event.target.value})}/></Field></div><Field label="自然语言问题"><textarea required rows={3} value={form.question} onChange={(event)=>setForm({...form,question:event.target.value})}/></Field><Field label="Gold SQL（单条只读 SELECT）"><textarea required className="mono-input" rows={7} value={form.goldSql} onChange={(event)=>setForm({...form,goldSql:event.target.value})}/></Field><label className="held-out-toggle"><input type="checkbox" checked={form.heldOut} onChange={(event)=>setForm({...form,heldOut:event.target.checked})}/>Held-out：保存后读取接口不返回 Gold SQL</label><div className="editor-actions">{editing&&<button type="button" className="secondary-button" onClick={()=>{setEditing(undefined);setForm(empty);}}>取消编辑</button>}<button type="submit" className="primary-button" disabled={saving||!source}>{saving?"保存中…":editing?"更新用例":"添加用例"}</button></div></form><section className="panel"><div className="panel-title"><div><h2>评测集</h2><p>归档是软删除；历史运行结果仍可审计。</p></div></div>{cases.length?<div className="table-responsive"><table className="data-table"><thead><tr><th>集合 / 分类</th><th>问题</th><th>Gold</th><th>操作</th></tr></thead><tbody>{cases.map((item)=><tr key={item.id}><td><strong>{item.setName}</strong><small>{item.category}{item.heldOut?" · Held-out":""}</small></td><td><strong>{item.question}</strong></td><td>{item.hasGoldSql||item.goldSql?"已配置":"缺失"}</td><td><div className="row-actions"><button onClick={()=>edit(item)}>编辑</button><button onClick={()=>void archive(item.id)}>归档</button></div></td></tr>)}</tbody></table></div>:<EmptyState title="尚未录入评测用例" body="先为真实 MySQL 数据源添加问题与经审核的 Gold SQL。"/>}</section></div>{(summary?.failures.length||latestRuns.some((item)=>!item.passed))?<section className="panel eval-failures"><div className="panel-title"><div><h2>失败样本知识闭环</h2><p>按失败类型定位到对象、属性和关系，并给出可执行修复建议。</p></div></div>{(summary?.failures||latestRuns.filter((item)=>!item.passed).map((item)=>({evalId:item.evalId,question:item.question,failureClass:item.failureClass||"unknown",reason:item.failReason||"未知失败",suggestion:item.suggestion||"检查本体知识后重跑。",repairHints:item.repairHints||[]}))).map((item)=><article key={`${item.evalId}-${item.failureClass}`}><span>{item.failureClass}</span><div><strong>{item.question}</strong><p>{item.reason}</p><small>{item.suggestion}</small>{item.repairHints?.length?<div className="repair-hints">{item.repairHints.map((hint)=><div key={`${hint.targetType}-${hint.target}`}><em>{repairTypeLabel(hint.targetType)}</em><span><b>{hint.label}</b>{hint.action}</span></div>)}</div>:null}</div></article>)}</section>:null}</div>;
}

function EvaluationGatePanel({gate}:{gate:EvaluationGate}){
  const agent=gate.candidate.gateKind==="agent"||gate.candidate.requestedMode==="agent_required";
  const rows=agent?[
    {label:"结果等价率",baseline:gate.baseline.passRate,candidate:gate.candidate.passRate,format:"percent" as const},
    {label:"P95 延迟",baseline:gate.baseline.p95DurationMs||0,candidate:gate.candidate.p95DurationMs||0,format:"ms" as const},
    {label:"平均 Token",baseline:gate.baseline.averageTokens||0,candidate:gate.candidate.averageTokens||0,format:"number" as const},
    {label:"平均迭代",baseline:gate.baseline.averageIterations||0,candidate:gate.candidate.averageIterations||0,format:"number" as const},
    {label:"工具成功率",baseline:gate.baseline.toolSuccessRate||1,candidate:gate.candidate.toolSuccessRate||0,format:"percent" as const},
    {label:"澄清率",baseline:gate.baseline.clarificationRate||0,candidate:gate.candidate.clarificationRate||0,format:"percent" as const},
    {label:"超预算兜底率",baseline:gate.baseline.budgetFallbackRate||0,candidate:gate.candidate.budgetFallbackRate||0,format:"percent" as const},
  ]:[
    {label:"结果等价率",baseline:gate.baseline.passRate,candidate:gate.candidate.passRate,format:"percent" as const},
    {label:"JOIN 失败率",baseline:gate.baseline.joinFailureRate||0,candidate:gate.candidate.joinFailureRate||0,format:"percent" as const},
    {label:"拒答率",baseline:gate.baseline.refusalRate,candidate:gate.candidate.refusalRate,format:"percent" as const},
    {label:"平均上下文表数",baseline:gate.baseline.averageContextTables||0,candidate:gate.candidate.averageContextTables||0,format:"number" as const},
    {label:"平均规划次数",baseline:gate.baseline.averagePlanningAttempts||0,candidate:gate.candidate.averagePlanningAttempts||0,format:"number" as const},
  ];
  const display=(value:number,format:"percent"|"number"|"ms")=>format==="percent"?`${Math.round(value*100)}%`:format==="ms"?`${Math.round(value)} ms`:value.toFixed(1);
  return <section className={`panel eval-gate ${gate.passed?"passed":"blocked"}`}><div className="eval-gate-title"><div><span className="section-kicker">{agent?"Agent 启用门禁":"语义启用门禁"} · {gate.setName}</span><h2>{gate.passed?"建议启用 prefer":"保持 off"}</h2><p>{gate.reason}</p></div><span className="gate-decision"><Icon name={gate.passed?"check":"shield"}/>{gate.passed?"通过":"未通过"}</span></div><div className="eval-gate-grid"><div className="gate-column-label"><span>指标</span><strong>{agent?"单发基线":"兼容基线 off"}</strong><strong>{agent?"Agent required":"语义候选 prefer"}</strong></div>{rows.map((row)=><div key={row.label}><span>{row.label}</span><strong>{display(row.baseline,row.format)}</strong><strong>{display(row.candidate,row.format)}</strong></div>)}{!agent&&<div><span>实际语义执行</span><strong>—</strong><strong>{Math.round((gate.candidate.semanticExecutionRate||0)*100)}%</strong></div>}</div></section>;
}

function AuditWorkspace({rows,stats}:{rows:AuditRecord[];stats:BootstrapData["auditStats"]}){const [search,setSearch]=useState("");const filtered=rows.filter((row)=>normalize(`${row.question}${row.userName}${row.verdict}${row.planningMode||""}`).includes(normalize(search)));function exportCsv(){const csv=["时间,执行人,问题,结论,规划模式,模型版本,耗时,结果行数",...filtered.map((row)=>[row.createdAt,row.userName,row.question,row.verdict,row.planningMode??"",row.ontologySchemaVersion??"",row.durationMs??"",row.rowCount??""].map(csvCell).join(","))].join("\n");const url=URL.createObjectURL(new Blob([`\ufeff${csv}`],{type:"text/csv;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download="ontoquery-audit.csv";link.click();URL.revokeObjectURL(url);}return <div className="content sub-page"><PageHeader eyebrow="全链路追溯" title="每一个数字都有来路" description="这些记录直接来自 SQLite 审计表；没有查询时不会显示样例活动。" action={<button className="secondary-button" onClick={exportCsv} disabled={!rows.length}><Icon name="download"/>导出审计</button>}/><div className="metric-grid"><MetricCard label="查询总数" value={String(stats?.total||0)} meta="当前数据源" tone="cyan"/><MetricCard label="执行通过" value={String(stats?.passed||0)} meta="已通过全部护栏" tone="green"/><MetricCard label="拒绝 / 失败" value={String(stats?.blocked||0)} meta="未执行或执行失败" tone="amber"/><MetricCard label="平均耗时" value={stats?.averageMs?`${Math.round(stats.averageMs)}ms`:"—"} meta="有耗时记录的查询" tone="violet"/></div><section className="panel"><div className="panel-title"><div><h2>最近活动</h2><p>问题、Query Plan、模型版本、SQL、失败原因和结果规模均保留。</p></div><div className="search-input compact"><Icon name="search"/><input aria-label="搜索审计记录" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="搜索问题或规划模式…"/></div></div>{filtered.length?<div className="table-responsive"><table className="data-table audit-table"><thead><tr><th>时间</th><th>执行人</th><th>问题 / 任务</th><th>规划</th><th>结论</th><th>耗时</th><th>规模</th></tr></thead><tbody>{filtered.map((row)=><tr key={row.id}><td className="mono">{formatDate(row.createdAt,"—")}</td><td>{row.userName}</td><td><strong>{row.question}</strong>{row.failReason&&<small>{row.failReason}</small>}{row.semanticFallbackReason&&<small>语义回退：{row.semanticFallbackReason}</small>}</td><td><span className={`planning-pill ${row.planningMode||"legacy"}`}>{planningModeLabel(row.planningMode)}</span>{row.ontologySchemaVersion&&<small>Ontology v{row.ontologySchemaVersion}</small>}{row.semanticPath?.objects.length?<small>{row.semanticPath.objects.join(" → ")}</small>:null}</td><td><span className={row.verdict==="passed"?"verdict":"verdict denied"}>{verdictLabel(row.verdict)}</span></td><td>{row.durationMs==null?"—":`${row.durationMs} ms`}</td><td>{row.rowCount==null?"—":`${row.rowCount} 行`}</td></tr>)}</tbody></table></div>:<EmptyState title="没有审计记录" body="第一次问数、拒答或评测运行后，记录会出现在这里。"/>}</section><section className="audit-safety"><Icon name="shield" size={24}/><div><strong>语义 Query Plan + 确定性编译 + AST 校验 + 物理只读</strong><span>规划模型只看到业务对象与属性；物理映射、JOIN 和最终 SQL 由服务端解析并审计。</span></div></section></div>;}

function ResultTable({columns,rows}:{columns:QueryAnswer["columns"];rows:QueryAnswer["rows"]}){return <div className="result-table-wrap"><table className="result-table"><thead><tr>{columns.map((column)=><th key={column.key} className={column.type!=="text"?"number":""}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{columns.map((column)=><td key={column.key} className={column.type!=="text"?"number":""}>{column.type==="number"?new Intl.NumberFormat("zh-CN").format(Number(row[column.key])):column.type==="percent"?`${row[column.key]}%`:String(row[column.key]??"")}</td>)}</tr>)}</tbody></table></div>;}
function SemanticEvidence({evidence}:{evidence:QueryAnswer["evidence"]}){if(!evidence.planningMode)return null;const plan=evidence.queryPlan;const path=evidence.semanticPath;if(evidence.planningMode==="agent")return <div className="semantic-evidence agent"><div className="semantic-evidence-heading"><span><Icon name="graph" size={15}/>{planningModeLabel(evidence.planningMode)}</span><em>{evidence.iterations||evidence.planningAttempts||0} 步</em></div>{evidence.clarifications?.length?<div className="clarification-evidence"><small>本轮确认的业务口径</small>{evidence.clarifications.map((item)=><span key={`${item.question}-${item.answer}`}><b>{item.question}</b>{item.answer}</span>)}</div>:null}<div className="legacy-path"><small>Harness 工具轨迹</small><strong>{evidence.toolTrace?.map((item)=>item.tool).join(" → ")||"未记录"}</strong><span>{evidence.toolTrace?.map((item,index)=>`${index+1}. ${item.ok?"通过":"拦截"} · ${item.summary}`).join("\n")}</span></div>{evidence.budgetFallback&&<p>预算到期后使用最后一次成功 SQL 的确定性结果收尾。</p>}</div>;if(evidence.planningMode==="claude")return <div className="semantic-evidence claude"><div className="semantic-evidence-heading"><span><Icon name="spark" size={15}/>{planningModeLabel(evidence.planningMode)}</span><em>{evidence.iterations||evidence.planningAttempts||0} turns</em></div><div className="legacy-path"><small>受限工具轨迹</small><strong>{evidence.toolTrace?.map((item)=>item.tool).join(" → ")||"未记录"}</strong><span>{evidence.toolTrace?.map((item,index)=>`${index+1}. ${item.ok?"通过":"拦截"} · ${item.summary}`).join("\n")}</span></div>{evidence.tokenUsage?.available&&<p>本轮 token：{evidence.tokenUsage.totalTokens}</p>}{evidence.agentFallbackReason&&<p>回退原因：{evidence.agentFallbackReason}</p>}</div>;if(evidence.planningMode==="legacy")return <div className="semantic-evidence legacy"><div className="semantic-evidence-heading"><span><Icon name="graph" size={15}/>{planningModeLabel(evidence.planningMode)}</span><em>{evidence.planningAttempts||1} 次规划</em></div><div className="legacy-path"><small>可追溯执行路径</small><strong>结构检索 → SQL 规划 → JOIN / 字段白名单校验 → EXPLAIN 扫描检查 → 只读执行</strong><span>参与数据表：{evidence.tables.join(" → ")||"未记录"}<br/>JOIN：{evidence.joins?(evidence.joins.join("；")||"单表查询"):"历史结果未记录"}</span></div>{evidence.semanticFallbackReason&&<p>语义回退：{evidence.semanticFallbackReason}</p>}{evidence.agentFallbackReason&&<p>Agent 回退：{evidence.agentFallbackReason}</p>}</div>;return <div className={`semantic-evidence ${evidence.planningMode}`}><div className="semantic-evidence-heading"><span><Icon name="graph" size={15}/>{planningModeLabel(evidence.planningMode)}</span>{evidence.ontologySchemaVersion&&<em>Ontology v{evidence.ontologySchemaVersion}</em>}</div>{path&&<div className="semantic-path"><small>语义路径</small><strong>{path.objects.join(" → ")}</strong>{path.links.length?<span>Link：{path.links.join("、")}</span>:<span>单对象查询</span>}</div>}{plan&&<div className="semantic-plan-grid"><div><small>根对象</small><span>{plan.rootObject}</span></div><div><small>维度</small><span>{[...plan.dimensions.map((item)=>item.property),...(plan.timeDimension?[`${plan.timeDimension.property} / ${plan.timeDimension.grain}`]:[])].join("、")||"无"}</span></div><div><small>指标</small><span>{plan.metrics.map((item)=>`${item.alias} = ${item.aggregation}(${item.property||"*"})`).join("、")||"无"}</span></div><div><small>过滤</small><span>{plan.filters.map((item)=>`${item.property} ${item.operator}`).join("、")||"无"}</span></div></div>}{evidence.semanticFallbackReason&&<p>语义回退：{evidence.semanticFallbackReason}</p>}</div>;}
function EvidenceGroup({title,items,color,emptyText="无"}:{title:string;items:string[];color:string;emptyText?:string}){return <div className="evidence-group"><small>{title}</small><div>{items.length?items.map((item)=><span key={item} className={`evidence-chip ${color}`}><Icon name="link" size={12}/>{item}</span>):<span className="muted-copy">{emptyText}</span>}</div></div>;}
function PageHeader({eyebrow,title,description,action}:{eyebrow:string;title:string;description:string;action?:React.ReactNode}){return <div className="page-header"><div><span className="section-kicker">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;}
function MetricCard({label,value,meta,tone}:{label:string;value:string;meta:string;tone:string}){return <div className={`metric-card ${tone}`}><small>{label}</small><strong>{value}</strong><span>{meta}</span></div>;}
function EmptyState({title,body}:{title:string;body:string}){return <div className="empty-state"><Icon name="database" size={30}/><h2>{title}</h2><p>{body}</p></div>;}
function Notice({tone,title,body}:{tone:"success"|"danger";title:string;body:string}){return <div className={`notice ${tone}`}><Icon name={tone==="success"?"check":"shield"}/><div><strong>{title}</strong><span>{body}</span></div></div>;}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="form-field"><span>{label}</span>{children}</label>;}

function errorMessage(error:unknown){return error instanceof ApiError&&error.detail?`${error.message}：${error.detail}`:error instanceof Error?error.message:"发生未知错误";}
function normalize(value:string){return value.toLowerCase().replace(/\s+/g,"");}
function repairTypeLabel(type:"object"|"property"|"link"){return type==="object"?"对象":type==="property"?"属性":"关系";}
function splitList(value:string){return value.split(/[,，]/).map((item)=>item.trim()).filter(Boolean);}
function formatInteger(value:number){return new Intl.NumberFormat("zh-CN").format(value||0);}
function formatDate(value:string|null|undefined,fallback:string){if(!value)return fallback;const date=new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(date);}
function typeLabel(type:KnowledgePage["pageType"]){return ({term:"术语",metric:"指标",join:"JOIN",rule:"规则",table:"表"})[type];}
function verdictLabel(value:string){return ({passed:"通过",refused:"已拒绝",failed:"失败"})[value]||value;}
function planningModeLabel(value:string|null|undefined){return ({semantic:"语义计划",legacy:"兼容链路",agent:"Agent Loop",claude:"Claude Code",demo:"演示链路"})[value||""]||"未记录";}
function csvCell(value:unknown){return `"${String(value??"").replaceAll('"','""')}"`;}
