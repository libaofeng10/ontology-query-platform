"use client";

import { useState } from "react";
import { correctSourceOntology, resumeSourceOntology } from "./api";
import { Icon } from "./icons";
import { OntologyExecutionRecords } from "./ontology-ai-workbench";
import { OntologyActivationPanel } from "./ontology-activation-panel";
import { OntologyVersionRecords } from "./semantic-modeling";
import { OntologyDefinitionList, type DefinitionEdit } from "./ontology-definition-list";
import { ChangeList, formatDate } from "./ontology-workspace-shared";
import type { OntologyActivationStatus, OntologyBuildAnswer, OntologyBuildIssue, SourceOntologyBuildStatus } from "./types";
import "./ontology-result-workspace.css";

type Role="viewer"|"analyst"|"editor"|"admin";
type Panel="result"|"execution"|"versions";

export function OntologyResultWorkspace({sourceId,status,role,onRefresh,onQuery,onSelectTables,onEvaluation}:{sourceId?:number;status:SourceOntologyBuildStatus|null;role:Role;onRefresh:()=>Promise<void>;onQuery:()=>void;onSelectTables:()=>void;onEvaluation:(activation:OntologyActivationStatus)=>void}) {
  const [panel,setPanel]=useState<Panel>("result");
  const [working,setWorking]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [versionId,setVersionId]=useState<number|null>(null);
  const canEdit=role==="editor"||role==="admin",update=status?.update,record=status?.activeVersion;
  const busy=working||Boolean(update?.busy),questions=update?.questions||[];
  const isSystem=(item:OntologyBuildIssue)=>!["relation","definition","candidate_review","conflict"].includes(item.kind);
  const activationDraft=status?.versions.find(item=>item.id===update?.draftVersionId&&item.status==="draft");
  const systemQuestions=questions.filter(item=>isSystem(item)&&!(activationDraft&&item.kind==="evaluation")),reviewQuestions=questions.filter(item=>!isSystem(item));
  const linkReview=reviewQuestions.length>0&&reviewQuestions.every(item=>item.kind==="candidate_review"&&item.candidateType==="link");
  const openPanel=(next:Panel)=>{setPanel(next);setError(null);setNotice(null);};
  async function perform(action:()=>Promise<unknown>,message?:string) {
    setWorking(true);setError(null);setNotice(null);
    try{await action();await onRefresh();if(message)setNotice(message);return true;}
    catch(cause){setError(cause instanceof Error?cause.message:"操作未完成，请重试");return false;}
    finally{setWorking(false);}
  }
  async function continueBuild(answers?:OntologyBuildAnswer[],approve=false,retryLinks=false,retryVerification=false) {
    if(!sourceId||!update)return;
    await perform(()=>resumeSourceOntology(sourceId,{taskId:update.id,answers,...(retryLinks?{retryLinkGeneration:true}:{}),...(retryVerification?{retryVerification:true}:{}),...(approve&&update.changeChecksum?{approveChangeChecksum:update.changeChecksum}:{})}),"已提交检查，处理结果会在此页面更新。");
  }
  async function saveEdit(edit:DefinitionEdit) {
    if(!sourceId||!record)return false;
    return perform(()=>correctSourceOntology(sourceId,{versionId:record.id,...edit}),"修改已提交，系统会检查并更新可用结果。");
  }
  if(!status)return <div className="ontology-simple-empty" role="status">正在读取业务定义…</div>;
  return <div className="ontology-simple">
    <nav className="ontology-workspace-nav" aria-label="本体工作区">
      {([["result","本体结果","查看与修改业务说明"],["execution","执行记录","进度、问题与模型调用"],["versions","版本记录","查看变化与恢复"]] as const).map(([value,label,description])=><button key={value} aria-current={panel===value?"page":undefined} onClick={()=>openPanel(value)}><strong>{label}</strong><span>{description}</span>{value==="execution"&&update?.busy&&<i className="mini-loader"/>}</button>)}
    </nav>
    {error&&<p className="ontology-inline-error" role="alert">{error}</p>}
    {notice&&<p className="ontology-inline-notice" role="status">{notice}</p>}
    {panel==="result"&&<>
      <section className={`ontology-availability ${record?"ready":"empty"}`}>
        <span className="ontology-availability-icon"><Icon name={record?"check":"graph"} size={23}/></span>
        <div><span className="ontology-eyebrow">{record?"当前可用":"开始使用"}</span><h3>{record?"业务定义已用于问数":"选择数据，AI 帮你整理业务含义"}</h3>
          <p>{record?`${record.schema?.objectTypes.length||0} 个业务对象 · ${status.availability.tableNames.length} 张数据表 · ${record.schema?.linkTypes?.length||0} 条业务关系`:"选表后，系统自动整理、检查并启用。你只需补充确实不明确的业务信息。"}</p>
          {record&&<small>当前版本 v{record.version} · {formatDate(record.publishedAt)}</small>}
        </div>
        {record?<button className="primary-button" onClick={onQuery}>开始问数 <Icon name="arrow" size={15}/></button>:<button className="primary-button" disabled={!sourceId||!canEdit||busy||!status.modelingEnabled} onClick={onSelectTables}>选择数据表</button>}
      </section>
      {update?.busy&&<section className="ontology-update-progress" role="status"><div><span className="mini-loader"/><strong>{status.task?.currentStep||"正在准备本次更新"}</strong><span>{status.task?.progress||0}%</span></div><progress max={100} value={status.task?.progress||0}/><p>可离开页面，后台会继续整理、检查和启用。{record&&"当前结果仍可用于问数。"}</p></section>}
      {!update?.busy&&update?.phase==="awaiting_change"&&<section className="ontology-clarifications">
        <h3>这次更新会改变已有业务定义</h3><p>请查看下面的变化。确认后，系统继续检查并启用；当前结果继续保留。</p>
        <ChangeList diff={update.changes}/>
        {canEdit&&<button className="primary-button" disabled={busy} onClick={()=>void continueBuild(undefined,true)}>确认这次变化并继续</button>}
      </section>}
      {sourceId&&activationDraft&&update?.phase!=="awaiting_change"&&<OntologyActivationPanel key={activationDraft.id} sourceId={sourceId} versionId={activationDraft.id} canEdit={canEdit} busy={busy} revision={`${update?.phase}:${status.task?.finishedAt}`} onRefresh={onRefresh} onEvaluation={onEvaluation} onVersion={id=>{setVersionId(id);openPanel("versions");}}/>}
      {!update?.busy&&systemQuestions.length>0&&<section className="ontology-clarifications">
        <h3>系统处理任务</h3>
        {systemQuestions.map(issue=><article className="ontology-clarification" key={issue.id}><h4>{issue.title}</h4><p>{issue.detail}</p>
          {issue.kind==="verification"&&(issue.definitions||[]).length>0&&<details><summary>查看待处理原因</summary>{[...new Set((issue.definitions||[]).map(item=>item.description))].map(reason=><p key={reason}>{reason}</p>)}</details>}
          {canEdit&&issue.retryable&&<button className="secondary-button" disabled={busy} onClick={()=>void continueBuild(undefined,false,issue.id==="link-generation",issue.kind==="verification")}>{issue.kind==="verification"?"继续自动核验":issue.id==="link-generation"?"重试补齐关系定义":"重试系统检查"}</button>}
        </article>)}
      </section>}
      {!update?.busy&&reviewQuestions.length>0&&<section className="ontology-clarifications">
        <div className="ontology-section-heading"><h3>{linkReview?"需要核实的关系业务问题":"需要你处理的业务问题"}</h3><span>{reviewQuestions.length} 项</span></div>
        {linkReview&&<p>以下业务口径仍需要核实；已确认的内容会继续保留。</p>}
        {record&&<p>这些问题属于本次更新，当前可用版本继续保留。</p>}
        {reviewQuestions.map((issue)=><Clarification key={`${issue.id}:${issue.reviewChecksum||""}`} issue={issue} disabled={!canEdit||busy} onAnswer={(answer)=>continueBuild([answer])}/>)}
        {update?.canResume&&canEdit&&!reviewQuestions.some((item)=>["definition","conflict","relation","candidate_review"].includes(item.kind))&&<button className="secondary-button" disabled={busy} onClick={()=>void continueBuild()}>继续未完成部分</button>}
      </section>}
      {update?.relationCoverage&&<p className="ontology-update-note">本次已确认关系：{update.relationCoverage.coveredRelationCount} / {update.relationCoverage.confirmedRelationCount} 条已有业务定义{Boolean(update.relationCoverage.bridgePathCount)&&`；中间表业务关系 ${update.relationCoverage.coveredBridgePathCount||0} / ${update.relationCoverage.bridgePathCount}`}{update.relationCoverage.bridgePathLimitReached&&"；业务路径已达到本轮预算，仍有路径未纳入"}</p>}
      {!update?.busy&&update?.summary&&["ready","unchanged"].includes(update.phase)&&<p className="ontology-update-note"><Icon name="check" size={14}/>{update.summary}</p>}
      {record&&<>
        <div className="ontology-section-heading"><h3>业务对象</h3><button className="ontology-text-button" disabled={!canEdit||busy||!status.modelingEnabled} onClick={onSelectTables}>更新数据范围 <Icon name="plus" size={14}/></button></div>
        <OntologyDefinitionList key={sourceId} record={record} busy={busy} onSave={canEdit?saveEdit:undefined}/>
      </>}
    </>}
    {panel==="execution"&&sourceId&&<OntologyExecutionRecords sourceId={sourceId} status={status} canInspect={canEdit} onResolve={()=>openPanel("result")} onVersion={(id)=>{setVersionId(id);openPanel("versions");}}/>}
    {panel==="versions"&&<OntologyVersionRecords status={status} canEdit={canEdit} busy={busy} selectedId={versionId} onSelect={setVersionId} onRefresh={onRefresh} onEdit={()=>openPanel("result")} onExecution={()=>openPanel("execution")} onEvaluation={onEvaluation}/>}
  </div>;
}

function Clarification({issue,disabled,onAnswer}:{issue:OntologyBuildIssue;disabled:boolean;onAnswer:(answer:OntologyBuildAnswer)=>Promise<void>}) {
  const [text,setText]=useState(""),[resolution,setResolution]=useState<OntologyBuildAnswer["resolution"]>();
  const needsExplanation=issue.kind==="definition"||issue.kind==="candidate_review"&&resolution==="supplement_definition";
  const actionable=["definition","conflict","relation","candidate_review"].includes(issue.kind);
  const identifier=(value:string|string[]|null)=>Array.isArray(value)?value.join(" + "):value||"未指定";
  return <article className="ontology-clarification"><h4>{issue.title}</h4><p>{issue.detail}</p>
    {!!issue.tables.length&&<small>数据来源：{issue.tables.join("、")}</small>}
    {!!issue.domains?.length&&<small>涉及 {issue.domains.length} 个范围：{issue.domains.join("、")}</small>}
    {issue.definitions?.map((definition,index)=><blockquote key={index}><strong>{definition.name}</strong><p>{definition.description}</p>{!!definition.reasons?.length&&<small>{definition.reasons.join("；")}</small>}</blockquote>)}
    {!!issue.evidenceSummary?.length&&<ul className="ontology-review-evidence">{issue.evidenceSummary.map((item,index)=><li key={index}>{item}</li>)}</ul>}
    {issue.comparison&&<div className="ontology-review-comparison"><strong>与 v{issue.comparison.baseVersion} 比较</strong>
      {issue.comparison.previousFieldCount!==null&&<p>字段数量：{issue.comparison.previousFieldCount} → {issue.comparison.currentFieldCount}</p>}
      {issue.comparison.previousPrimaryKey!==null&&<p>唯一标识：{identifier(issue.comparison.previousPrimaryKey)} → {identifier(issue.comparison.currentPrimaryKey)}</p>}
    </div>}
    {issue.changes&&<ChangeList diff={issue.changes}/>}
    {["conflict","relation","candidate_review"].includes(issue.kind)&&<fieldset disabled={disabled}><legend>此次更新如何处理？</legend>{issue.options?.map((option)=><label key={option.value}><input type="radio" name={issue.id} checked={resolution===option.value} onChange={()=>setResolution(option.value)}/>{option.label}</label>)}</fieldset>}
    {needsExplanation&&<label>补充业务说明{issue.clarificationPrompt&&<small>{issue.clarificationPrompt}</small>}<textarea rows={3} maxLength={3000} value={text} disabled={disabled} onChange={(event)=>setText(event.target.value)} placeholder="例如：此表按用户和自然日汇总消耗，单位为次；累计消耗使用另一张表。"/></label>}
    {actionable&&<button className="primary-button" disabled={disabled||(needsExplanation?!text.trim():!resolution)} onClick={()=>void onAnswer({questionId:issue.id,text:needsExplanation?text:undefined,resolution,reviewChecksum:issue.reviewChecksum})}>{needsExplanation?"保存说明并继续":"确认选择并继续"}</button>}
  </article>;
}
