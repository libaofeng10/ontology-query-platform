import type { SemanticSchema, SemanticSchemaDiff } from "./types";

export function ChangeList({diff,from,to}:{diff:SemanticSchemaDiff|null;from?:SemanticSchema;to?:SemanticSchema}) {
  if(!diff?.changes.length)return <p>业务定义没有变化。</p>;
  const previous=definitionIndex(from),next=definitionIndex(to);
  return <ul className="ontology-change-list">{diff.changes.map((change,index)=>{
    const before=previous.get(change.path),after=next.get(change.path);
    const textChanged=before&&after&&(before.description!==after.description||before.displayName!==after.displayName);
    return <li key={index}><span>{({added:"新增",removed:"移除",changed:"调整"})[change.change]}</span><div><strong>{after?.label||before?.label||change.label}</strong><p>{change.detail}</p>
      {textChanged&&<dl className="ontology-description-diff"><div><dt>当前</dt><dd>{before.displayName}：{before.description||"尚未填写说明"}</dd></div><div><dt>此版本</dt><dd>{after.displayName}：{after.description||"尚未填写说明"}</dd></div></dl>}
    </div></li>;
  })}</ul>;
}
function definitionIndex(schema?:SemanticSchema){
  const entries=new Map<string,{label:string;displayName:string;description:string}>();
  for(const object of schema?.objectTypes||[]){
    entries.set(`objectTypes.${object.apiName}`,{label:object.displayName||object.apiName,displayName:object.displayName||object.apiName,description:object.description||""});
    for(const property of object.properties)entries.set(`objectTypes.${object.apiName}.properties.${property.apiName}`,{label:`${object.displayName||object.apiName} · ${property.displayName||property.apiName}`,displayName:property.displayName||property.apiName,description:property.description||""});
  }
  for(const link of schema?.linkTypes||[])entries.set(`linkTypes.${link.apiName}`,{label:link.displayName||link.apiName,displayName:link.displayName||link.apiName,description:link.description||""});
  return entries;
}
export function phaseLabel(phase:string){return ({legacy:"历史生成记录",queued:"等待整理",discovering:"读取数据结构",generating:"整理业务定义",repairing:"补充与修正",merging:"合并业务定义",checking:"检查更新",evaluating:"验证业务问法",activating:"启用更新",needs_input:"需要审核或补充信息",awaiting_change:"等待确认业务变化",failed:"本次整理未完成",ready:"已用于问数",unchanged:"沿用当前业务定义"} as Record<string,string>)[phase]||"本体更新";}
export function formatDate(value:string|null){if(!value)return "—";const date=new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(date);}
