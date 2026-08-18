import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";

export function analyzeSemanticSchemaImpact(currentSchema,baseSchema,{cases=[],relations=[]}={}) {
  const diff=diffSemanticSchemas(currentSchema,baseSchema);
  const current=model(currentSchema),base=model(baseSchema);
  const relationById=new Map(relations.map((item)=>[Number(item.id),item]));
  const relevant=diff.changes.filter((change)=>change.impact!=="compatible");
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
