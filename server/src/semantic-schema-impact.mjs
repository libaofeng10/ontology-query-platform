import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";

export function analyzeSemanticSchemaImpact(currentSchema,baseSchema,{cases=[],relations=[],availableTables=null}={}) {
  const diff=diffSemanticSchemas(currentSchema,baseSchema);
  const current=model(currentSchema),base=model(baseSchema);
  const relationById=new Map(relations.map((item)=>[Number(item.id),item]));
  // A removal whose every physical mapping points at a table that is no longer
  // in the catalog (dropped or excluded from the data source) cannot have any
  // still-working behaviour to protect: no eval case could execute against it.
  // Demanding evaluation coverage for those removals would deadlock publishing,
  // so they stay in the diff but are exempt from the coverage gate.
  const tableSet=availableTables instanceof Set?availableTables:availableTables?new Set(availableTables):null;
  const staleRemoval=(change)=>{
    if(!tableSet||change.change!=="removed")return false;
    if(change.kind==="object"||change.kind==="property"){
      const [,objectName]=change.path.split(".");
      const object=base.objects.get(objectName);
      if(!object)return false;
      const mappedTables=[...object.properties.values()].map((property)=>property.mapping?.table).filter(Boolean);
      return mappedTables.length>0&&mappedTables.every((table)=>!tableSet.has(table));
    }
    if(change.kind==="link"){
      const link=base.links.get(change.path.split(".").at(-1));
      if(!link)return false;
      // A link is stale when either endpoint object no longer exists in the
      // current schema because its tables were dropped from the catalog.
      return [link.source,link.target].some((name)=>{
        const object=base.objects.get(name);
        if(!object||current.objects.has(name))return false;
        const mappedTables=[...object.properties.values()].map((property)=>property.mapping?.table).filter(Boolean);
        return mappedTables.length>0&&mappedTables.every((table)=>!tableSet.has(table));
      });
    }
    return false;
  };
  const relevant=diff.changes.filter((change)=>change.impact!=="compatible"&&!staleRemoval(change));
  const dependencies=relevant.map((change)=>dependencyForChange(change,current,base,relationById));
  const affectedCases=[];
  const matchedPaths=new Set();
  for(const item of cases) {
    const reasons=[];const paths=[];
    for(const dependency of dependencies) {
      const matches=[];
      if(dependency.affectsAll) matches.push("本体根契约变化");
      const semanticMatch=dependency.semanticTokens.find((token)=>containsText(item.question,token));
      if(semanticMatch) matches.push(`问题命中语义 ${semanticMatch}`);
      const physicalMatch=dependency.physicalTokens.find((token)=>containsIdentifier(item.goldSql,token));
      if(physicalMatch) matches.push(`Gold SQL 依赖 ${physicalMatch}`);
      if(matches.length) { reasons.push(...matches);paths.push(dependency.change.path);matchedPaths.add(dependency.change.path); }
    }
    if(reasons.length) affectedCases.push({id:item.id,setName:item.setName,question:item.question,category:item.category,reasons:[...new Set(reasons)],changePaths:[...new Set(paths)]});
  }
  const uncoveredChanges=dependencies.filter((item)=>!matchedPaths.has(item.change.path)).map((item)=>({path:item.change.path,label:item.change.label,impact:item.change.impact,detail:item.change.detail}));
  return {
    diff,
    summary:{breakingChanges:diff.summary.breaking,reviewChanges:diff.summary.review,affectedCases:affectedCases.length,affectedSets:new Set(affectedCases.map((item)=>item.setName)).size,uncoveredChanges:uncoveredChanges.length,requiresEvaluation:relevant.length>0},
    affectedCases,
    affectedSets:[...new Set(affectedCases.map((item)=>item.setName))],
    uncoveredChanges,
  };
}

function dependencyForChange(change,current,base,relationById) {
  const semanticTokens=new Set([change.label]);const physicalTokens=new Set();let affectsAll=change.kind==="schema"&&change.impact==="breaking";
  if(change.kind==="object"||change.kind==="property") {
    const [,objectName,,propertyName]=change.path.split(".");
    for(const source of [current,base]) {
      const object=source.objects.get(objectName);if(!object)continue;
      semanticTokens.add(object.apiName);semanticTokens.add(object.displayName);
      const properties=propertyName?[object.properties.get(propertyName)].filter(Boolean):[...object.properties.values()];
      for(const property of properties) { semanticTokens.add(property.apiName);semanticTokens.add(property.displayName);addMapping(physicalTokens,property.mapping); }
      if(change.kind==="object")for(const descendant of source.objects.values())if(isDescendant(descendant,objectName,source.objects)){
        semanticTokens.add(descendant.apiName);semanticTokens.add(descendant.displayName);
        for(const property of descendant.properties.values())addMapping(physicalTokens,property.mapping);
      }
    }
  }
  if(change.kind==="link") {
    const linkName=change.path.split(".").at(-1);
    for(const source of [current,base]) {
      const link=source.links.get(linkName);if(!link)continue;
      for(const token of [link.apiName,link.displayName,link.source,link.target])semanticTokens.add(token);
      for(const mapping of link.relationMappings||[]) {
        const relation=relationById.get(Number(mapping.relationId));
        if(relation) for(const token of [relation.fromTable,relation.fromCol,relation.toTable,relation.toCol])physicalTokens.add(token);
      }
    }
  }
  return {change,affectsAll,semanticTokens:[...semanticTokens].filter(usefulToken),physicalTokens:[...physicalTokens].filter(usefulToken)};
}
function model(schema) {
  const objects=new Map();const links=new Map();
  for(const input of schema?.objectTypes||[]) { const object={...input,properties:new Map((input.properties||[]).map((item)=>[item.apiName,item]))};objects.set(input.apiName,object); }
  for(const link of schema?.linkTypes||[])links.set(link.apiName,link);
  return {objects,links};
}
function isDescendant(object,ancestorName,objects){const seen=new Set();let current=object;while(current?.parent&&!seen.has(current.apiName)){seen.add(current.apiName);if(current.parent===ancestorName)return true;current=objects.get(current.parent);}return false;}
function addMapping(tokens,mapping) { if(mapping?.column)tokens.add(mapping.column);if(mapping?.table)tokens.add(mapping.table); }
function containsText(value,token) { return String(value||"").toLowerCase().includes(String(token||"").toLowerCase()); }
function containsIdentifier(value,token) { if(!value||!token)return false;return new RegExp(`(^|[^a-z0-9_])${escapeRegex(String(token).toLowerCase())}([^a-z0-9_]|$)`,"i").test(String(value)); }
function usefulToken(value) { return typeof value==="string"&&value.trim().length>1; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
