"use client";

import { useState } from "react";
import { Icon } from "./icons";
import type { SemanticSchemaVersion } from "./types";

export type DefinitionEdit = { objectName: string; propertyName?: string; displayName: string; description: string };

export function OntologyDefinitionList({record,busy=false,onSave}:{record:SemanticSchemaVersion;busy?:boolean;onSave?:(edit:DefinitionEdit)=>Promise<boolean>}) {
  const [search,setSearch]=useState("");
  const [edit,setEdit]=useState<DefinitionEdit|null>(null);
  const query=search.trim().toLowerCase();
  const objects=(record.schema?.objectTypes||[]).filter((object)=>!query||[object.apiName,object.displayName,object.description,...object.properties.flatMap((property)=>[property.apiName,property.displayName,property.description,property.mapping.table,property.mapping.column])].join(" ").toLowerCase().includes(query));
  const names=new Map((record.schema?.objectTypes||[]).map((object)=>[object.apiName,object.displayName||object.apiName]));
  async function save(){if(edit&&onSave&&await onSave(edit))setEdit(null);}
  const editor=edit&&<form className="ontology-definition-editor" onSubmit={(event)=>{event.preventDefault();void save();}}>
    <label>业务名称<input maxLength={120} value={edit.displayName} disabled={busy} onChange={(event)=>setEdit({...edit,displayName:event.target.value})}/></label>
    <label>业务说明<textarea rows={3} maxLength={3000} value={edit.description} disabled={busy} onChange={(event)=>setEdit({...edit,description:event.target.value})}/></label>
    <p>保存后自动检查并用于问数，更新记录会保留。</p>
    <div><button className="primary-button" disabled={busy||!edit.displayName.trim()||!edit.description.trim()}>{busy?"正在保存…":"保存说明"}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEdit(null)}>取消</button></div>
  </form>;
  return <>
    <label className="ontology-object-search"><Icon name="search" size={17}/><input aria-label="搜索业务对象、表或字段" placeholder="搜索业务对象、表或字段" value={search} onChange={(event)=>setSearch(event.target.value)}/><span>{objects.length} 个</span></label>
    <div className="ontology-object-list">{objects.map((object)=>{
      const links=(record.schema?.linkTypes||[]).filter((link)=>link.source===object.apiName||link.target===object.apiName);
      return <details key={object.apiName} className="ontology-object-row">
        <summary><span className="ontology-object-icon"><Icon name="graph" size={19}/></span><span><strong>{object.displayName||object.apiName}</strong><span>{object.description||"尚未补充业务说明"}</span></span><small>{object.properties.length} 个字段</small><Icon name="down" size={16}/></summary>
        <div className="ontology-object-body">
          <div className="ontology-object-source"><span>来源：{[...new Set(object.properties.map((property)=>property.mapping.table))].join("、")}</span>{onSave&&<button className="ontology-text-button" disabled={busy} onClick={()=>setEdit({objectName:object.apiName,displayName:object.displayName||object.apiName,description:object.description||""})}>修改说明</button>}</div>
          {edit?.objectName===object.apiName&&!edit.propertyName&&editor}
          <div className="ontology-field-list">{object.properties.map((property)=><div key={property.apiName} className="ontology-field-row">
            <div><strong>{property.displayName||property.apiName}</strong><p>{property.description||"尚未补充业务说明"}</p><code>{property.mapping.table}.{property.mapping.column}</code></div>
            {onSave&&<button className="ontology-text-button" disabled={busy} aria-label={`修改${property.displayName||property.apiName}的说明`} onClick={()=>setEdit({objectName:object.apiName,propertyName:property.apiName,displayName:property.displayName||property.apiName,description:property.description||""})}>修改</button>}
            {edit?.objectName===object.apiName&&edit.propertyName===property.apiName&&editor}
          </div>)}</div>
          {!!links.length&&<div className="ontology-object-links"><strong>关联业务</strong>{links.map((link)=><p key={link.apiName}><span>{names.get(link.source)||link.source} → {names.get(link.target)||link.target}</span>{link.description||link.displayName}</p>)}</div>}
        </div>
      </details>;
    })}</div>
    {!objects.length&&<p className="ontology-simple-empty">没有匹配的业务对象，试试其他名称或字段。</p>}
  </>;
}
