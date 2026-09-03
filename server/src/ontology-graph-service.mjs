export function createOntologyGraphService({store,knowledge}) {
  function build(sourceId) {
    // Respect the data source's table selection: only tables the user opted
    // into (included != 0) are part of the ontology. Excluded tables must not
    // appear as nodes nor anchor object/term mappings.
    const excluded=store.excludedTableNames(sourceId);
    const tables=store.listTables(sourceId).filter((table)=>table.active&&table.grade!=="C"&&!excluded.has(table.tableName));
    const tableNames=new Set(tables.map((table)=>table.tableName));
    const pages=knowledge.list(sourceId).filter((page)=>["term","metric","rule"].includes(page.pageType));
    const ontology=store.getPublishedOntologySchema(sourceId);
    const objectTypes=ontology?.schema?.objectTypes||[];
    const linkTypes=ontology?.schema?.linkTypes||[];
    const objectByName=new Map(objectTypes.map((object)=>[object.apiName,object]));
    const effectiveProperties=new Map(objectTypes.map((object)=>[object.apiName,effectiveObjectProperties(object,objectByName)]));
    const objectTables=new Map(objectTypes.map((objectType)=>[objectType.apiName,[...new Set(effectiveProperties.get(objectType.apiName).map((property)=>property.mapping?.table).filter((table)=>tableNames.has(table)))]]));
    const nodes=[
      ...tables.map((table)=>({id:`table:${table.tableName}`,kind:"table",title:table.tableName,subtitle:table.comment||"数据库表",verified:Boolean(table.gradeOverride),grade:table.grade,tables:[table.tableName],content:table.comment||"由数据库结构探查生成"})),
      ...objectTypes.map((objectType)=>({id:`object:${objectType.apiName}`,kind:"object",title:objectType.displayName||objectType.apiName,subtitle:`${objectType.apiName} · ${effectiveProperties.get(objectType.apiName).length} 个属性`,verified:true,tables:objectTables.get(objectType.apiName)||[],content:objectType.description||"已发布的业务对象",...(objectType.parent?{parent:objectType.parent}:{}),properties:effectiveProperties.get(objectType.apiName).map((property)=>({apiName:property.apiName,displayName:property.displayName||property.apiName,type:property.type,required:Boolean(property.required),mapping:property.mapping,inherited:!objectType.properties.some((item)=>item.apiName===property.apiName)}))})),
      ...pages.map((page)=>({id:`${page.pageType}:${page.slug}`,kind:page.pageType,title:page.title,subtitle:page.aliases?.length?`别名：${page.aliases.join("、")}`:page.verified?"已验证知识":"待验证知识",verified:Boolean(page.verified),tables:page.tables||[],content:page.content||""})),
    ];
    const nodeIds=new Set(nodes.map((node)=>node.id));const edges=[];const edgeIds=new Set();
    for(const relation of store.listRelations(sourceId)) {
      const source=`table:${relation.fromTable}`,target=`table:${relation.toTable}`;if(!nodeIds.has(source)||!nodeIds.has(target))continue;
      pushEdge(edges,edgeIds,{id:`join:${relation.id}`,source,target,kind:"join",label:`${relation.fromCol} = ${relation.toCol} · ${relation.cardinality||"?"}`,confirmed:["confirmed","accepted"].includes(relation.status)});
    }
    for(const objectType of objectTypes) {
      const source=`object:${objectType.apiName}`;
      const mappings=Object.groupBy(effectiveProperties.get(objectType.apiName).filter((property)=>tableNames.has(property.mapping?.table)),(property)=>property.mapping.table);
      for(const [table,properties] of Object.entries(mappings)) pushEdge(edges,edgeIds,{id:`mapping:${objectType.apiName}:${table}`,source,target:`table:${table}`,kind:"mapping",label:`映射 ${properties.length} 个属性`,confirmed:true});
      if(objectType.parent&&nodeIds.has(`object:${objectType.parent}`))pushEdge(edges,edgeIds,{id:`subclass:${objectType.apiName}`,source,target:`object:${objectType.parent}`,kind:"subclass",label:"子类型",confirmed:true});
    }
    for(const linkType of linkTypes) {
      const source=`object:${linkType.source}`,target=`object:${linkType.target}`;
      if(!nodeIds.has(source)||!nodeIds.has(target))continue;
      const inverse=linkType.inverseDisplayName||linkType.inverseApiName;
      pushEdge(edges,edgeIds,{id:`semantic:${linkType.apiName}`,source,target,kind:"semantic",label:`${linkType.displayName||linkType.apiName}${inverse?` / ${inverse}`:""} · ${cardinalityLabel(linkType.cardinality)}`,forwardLabel:linkType.displayName||linkType.apiName,inverseLabel:inverse||null,confirmed:true});
    }
    const lookup=new Map();
    for(const node of nodes){lookup.set(normalize(node.id),node.id);lookup.set(normalize(node.title),node.id);if(node.kind==="table")lookup.set(normalize(node.tables[0]),node.id);}
    for(const page of pages) {
      const source=`${page.pageType}:${page.slug}`;
      for(const table of page.tables||[])if(tableNames.has(table))pushEdge(edges,edgeIds,{id:`binding:${source}:${table}`,source,target:`table:${table}`,kind:"binding",label:"绑定表",confirmed:Boolean(page.verified)});
      for(const objectType of objectTypes)if(intersects(page.tables||[],objectTables.get(objectType.apiName)||[]))pushEdge(edges,edgeIds,{id:`object-binding:${source}:${objectType.apiName}`,source,target:`object:${objectType.apiName}`,kind:"binding",label:"对象知识",confirmed:Boolean(page.verified)});
      for(const link of extractWikiLinks(`${page.content||""}\n${page.antiExamples||""}`)){
        const target=lookup.get(normalize(link));if(target&&target!==source)pushEdge(edges,edgeIds,{id:`wikilink:${source}:${target}`,source,target,kind:"wikilink",label:"语义引用",confirmed:Boolean(page.verified)});
      }
    }
    const stats={tables:tables.length,objects:objectTypes.length,semanticLinks:linkTypes.length,schemaVersion:ontology?.version||null,terms:pages.filter((page)=>page.pageType==="term").length,metrics:pages.filter((page)=>page.pageType==="metric").length,rules:pages.filter((page)=>page.pageType==="rule").length,joins:edges.filter((edge)=>edge.kind==="join").length,confirmedJoins:edges.filter((edge)=>edge.kind==="join"&&edge.confirmed).length};
    return {sourceId:Number(sourceId),nodes,edges,stats};
  }
  return {build};
}

function extractWikiLinks(value){return [...String(value).matchAll(/\[\[([^\]]+)\]\]/g)].map((match)=>match[1].split("|")[0].trim()).filter(Boolean);}
function normalize(value){return String(value).trim().toLowerCase();}
function pushEdge(edges,ids,edge){if(ids.has(edge.id))return;ids.add(edge.id);edges.push(edge);}
function intersects(left,right){const values=new Set(left);return right.some((item)=>values.has(item));}
function cardinalityLabel(value){return ({one_to_one:"1:1",one_to_many:"1:N",many_to_one:"N:1",many_to_many:"N:N"})[value]||value||"?";}
function effectiveObjectProperties(object,objectByName){const chain=[];const seen=new Set();let current=object;while(current&&!seen.has(current.apiName)){seen.add(current.apiName);chain.unshift(current);current=current.parent?objectByName.get(current.parent):null;}const properties=new Map();for(const item of chain)for(const property of item.properties||[])if(!properties.has(property.apiName))properties.set(property.apiName,property);return [...properties.values()];}
