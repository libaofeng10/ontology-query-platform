import { normalizeOntologyNamespace } from "./ontology-candidate-score.mjs";

const APPLICABLE_STATUSES=new Set(["auto_confirmed","confirmed"]);

export function assembleOntologyDraft({run,candidates,baseSchema=null,excludeCandidateIds=[],conflictResolutions={},applicableStatuses=APPLICABLE_STATUSES}={}) {
  const excluded=new Set(excludeCandidateIds||[]);const conflicts=[];const includedCandidates=[];
  const schema=baseSchema?structuredClone(baseSchema):{name:normalizeOntologyNamespace(run?.scope?.namespace||run?.scope?.domainName),displayName:String(run?.scope?.domainName||"AI 生成业务本体").trim()||"AI 生成业务本体",description:String(run?.scope?.domainDescription||"").trim(),objectTypes:[],linkTypes:[]};
  schema.objectTypes=Array.isArray(schema.objectTypes)?schema.objectTypes:[];schema.linkTypes=Array.isArray(schema.linkTypes)?schema.linkTypes:[];
  const allowedStatuses=applicableStatuses instanceof Set?applicableStatuses:new Set(applicableStatuses||[]);
  const eligible=(candidates||[]).filter((candidate)=>candidate.runId===run.id&&Number(candidate.sourceId)===Number(run.sourceId)&&allowedStatuses.has(candidate.status)&&!excluded.has(candidate.id));
  const objects=eligible.filter((candidate)=>candidate.candidateType==="object").sort(byStableKey);const links=eligible.filter((candidate)=>candidate.candidateType==="link").sort(byStableKey);
  const objectByApi=new Map(schema.objectTypes.map((object)=>[object.apiName,object]));const objectByTable=new Map();
  for(const object of schema.objectTypes)for(const table of mappedTables(object))if(!objectByTable.has(table))objectByTable.set(table,object);
  for(const candidate of objects) {
    const payload=structuredClone(candidate.payload);const table=mappedTables(payload)[0]||null;const byApi=objectByApi.get(payload.apiName);const byTable=table?objectByTable.get(table):null;const existing=byApi||byTable;
    if(existing) {
      if(equalJson(objectCore(existing),objectCore(payload))){includedCandidates.push(candidate);continue;}
      const collisions=[...new Set([byApi,byTable].filter(Boolean))];const allowedResolutions=collisions.length===1?["keep_existing","use_candidate"]:["keep_existing"];
      const conflict=resolvedConflict({candidate,candidateType:"object",reason:collisions.length>1?"object_multiple_conflicts":byApi?"object_api_name_exists":"object_physical_mapping_exists",existingApiName:existing.apiName,allowedResolutions,conflictResolutions});conflicts.push(conflict);
      if(conflict.resolution!=="use_candidate")continue;
      replaceItem(schema.objectTypes,existing,payload);rebuildObjectIndexes(schema.objectTypes,objectByApi,objectByTable);includedCandidates.push(candidate);continue;
    }
    schema.objectTypes.push(payload);objectByApi.set(payload.apiName,payload);if(table)objectByTable.set(table,payload);includedCandidates.push(candidate);
  }

  const linkByApi=new Map(schema.linkTypes.map((link)=>[link.apiName,link]));const linkByRelation=new Map();
  for(const link of schema.linkTypes)for(const id of relationIds(link))if(!linkByRelation.has(id))linkByRelation.set(id,link);
  for(const candidate of links) {
    const payload=structuredClone(candidate.payload);
    if(!objectByApi.has(payload.source)||!objectByApi.has(payload.target)){conflicts.push(resolvedConflict({candidate,candidateType:"link",reason:"link_endpoint_missing",source:payload.source,target:payload.target,allowedResolutions:["keep_existing"],conflictResolutions}));continue;}
    const relationId=relationIds(payload)[0]||null;const byApi=linkByApi.get(payload.apiName);const byRelation=relationId?linkByRelation.get(relationId):null;const existing=byApi||byRelation;
    if(existing) {
      if(equalJson(linkCore(existing),linkCore(payload))){includedCandidates.push(candidate);continue;}
      const collisions=[...new Set([byApi,byRelation].filter(Boolean))];const allowedResolutions=collisions.length===1?["keep_existing","use_candidate"]:["keep_existing"];
      const conflict=resolvedConflict({candidate,candidateType:"link",reason:collisions.length>1?"link_multiple_conflicts":byApi?"link_api_name_exists":"link_physical_relation_exists",existingApiName:existing.apiName,allowedResolutions,conflictResolutions});conflicts.push(conflict);
      if(conflict.resolution!=="use_candidate")continue;
      replaceItem(schema.linkTypes,existing,payload);rebuildLinkIndexes(schema.linkTypes,linkByApi,linkByRelation);includedCandidates.push(candidate);continue;
    }
    schema.linkTypes.push(payload);linkByApi.set(payload.apiName,payload);if(relationId)linkByRelation.set(relationId,payload);includedCandidates.push(candidate);
  }
  const renamedLinks=ensureUniqueLinkNames(schema.linkTypes);
  const baseObjectCount=baseSchema?.objectTypes?.length||0;const baseLinkCount=baseSchema?.linkTypes?.length||0;const basePropertyCount=propertyCount(baseSchema?.objectTypes);
  return {schema,includedCandidates,conflicts,renamedLinks,excludedCandidateIds:[...excluded],summary:{objectsAdded:Math.max(0,schema.objectTypes.length-baseObjectCount),propertiesAdded:Math.max(0,propertyCount(schema.objectTypes)-basePropertyCount),linksAdded:Math.max(0,schema.linkTypes.length-baseLinkCount),renamedLinkCount:renamedLinks.length,candidateCount:includedCandidates.length,conflictCount:conflicts.length,resolvedConflictCount:conflicts.filter((item)=>item.resolution!=="unresolved").length,unresolvedConflictCount:conflicts.filter((item)=>item.resolution==="unresolved").length,excludedCount:excluded.size}};
}

function ensureUniqueLinkNames(links) {
  const used=new Map();const renamed=[];
  for(const [index,link] of (links||[]).entries())for(const field of ["apiName","inverseApiName"]) {
    const original=String(link?.[field]||"").trim();if(!original)continue;
    if(!used.has(original)){used.set(original,{index,field});continue;}
    const direction=field==="inverseApiName"?`${link.target}_to_${link.source}`:`${link.source}_to_${link.target}`;
    const base=`${original}_${direction}`.replace(/[^a-z0-9_]/g,"_").replace(/_+/g,"_").replace(/^_+|_+$/g,"")||`${original}_link`;
    let value=base,suffix=2;while(used.has(value))value=`${base}_${suffix++}`;
    link[field]=value;used.set(value,{index,field});renamed.push({index,field,from:original,to:value,conflictsWith:used.get(original)});
  }
  return renamed;
}

function resolvedConflict({candidate,candidateType,reason,existingApiName,source,target,allowedResolutions,conflictResolutions}) {
  const requested=conflictResolutions?.[candidate.id];const resolution=allowedResolutions.includes(requested)?requested:"unresolved";
  return {candidateId:candidate.id,candidateType,stableKey:candidate.stableKey,reason,...(existingApiName?{existingApiName}:{}),...(source?{source}:{}),...(target?{target}:{}),allowedResolutions,resolution};
}

function replaceItem(items,existing,replacement){const index=items.indexOf(existing);if(index>=0)items.splice(index,1,replacement);}
function rebuildObjectIndexes(objects,byApi,byTable){byApi.clear();byTable.clear();for(const object of objects){byApi.set(object.apiName,object);for(const table of mappedTables(object))if(!byTable.has(table))byTable.set(table,object);}}
function rebuildLinkIndexes(links,byApi,byRelation){byApi.clear();byRelation.clear();for(const link of links){byApi.set(link.apiName,link);for(const id of relationIds(link))if(!byRelation.has(id))byRelation.set(id,link);}}
function propertyCount(objects){return (objects||[]).reduce((sum,object)=>sum+(object?.properties?.length||0),0);}

function objectCore(object) { return {apiName:object?.apiName,displayName:object?.displayName||object?.apiName,description:object?.description||"",namespace:object?.namespace||null,freshness:object?.freshness||null,parent:object?.parent||null,discriminator:object?.discriminator||null,termBinding:object?.termBinding||null,primaryKey:object?.primaryKey,properties:(object?.properties||[]).map((property)=>({apiName:property.apiName,displayName:property.displayName||property.apiName,description:property.description||"",type:property.type,required:Boolean(property.required),freshness:property.freshness||null,termBinding:property.termBinding||null,constraints:property.constraints||{},mapping:{table:property.mapping?.table,column:property.mapping?.column}})).sort((left,right)=>String(left.apiName).localeCompare(String(right.apiName)))}; }
function linkCore(link) { return {apiName:link?.apiName,displayName:link?.displayName||link?.apiName,description:link?.description||"",source:link?.source,target:link?.target,cardinality:link?.cardinality,sourceLabel:link?.sourceLabel||"",targetLabel:link?.targetLabel||"",inverseApiName:link?.inverseApiName||null,inverseDisplayName:link?.inverseDisplayName||null,relationKind:link?.relationKind||null,relationMappings:relationIds(link)}; }
function mappedTables(object) { return [...new Set((object?.properties||[]).map((property)=>String(property?.mapping?.table||"").trim()).filter(Boolean))].sort(); }
function relationIds(link) { return [...new Set((link?.relationMappings||[]).map((mapping)=>Number(mapping?.relationId??mapping)).filter((id)=>Number.isInteger(id)&&id>0))].sort((left,right)=>left-right); }
function byStableKey(left,right) { return String(left.stableKey).localeCompare(String(right.stableKey)); }
function equalJson(left,right) { return JSON.stringify(left)===JSON.stringify(right); }

export const ontologyDraftAssemblerInternal={objectCore,linkCore,mappedTables,relationIds,ensureUniqueLinkNames};
