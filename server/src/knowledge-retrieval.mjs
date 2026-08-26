import { buildIntentRetrievalFacets } from "./query-intent.mjs";

const TYPE_BOOST={metric:5,term:4,rule:2.5,join:2,table:1};
const NOISE_TABLE=/(?:^|_)(?:copy\d*|bak\d*|backup|archive|history|tmp|temp|test)(?:_|$)|_20\d{6}(?:_|$)/i;
const SUBJECT_AUXILIARY_NAME=/(?:^|_)(?:config|configuration|log|logs|stat|stats|statistics|summary|aggregate|agg|rel|relation|mapping|map|bridge|link|join|detail|details|item|items|record|records|history|snapshot|event|track|audit|archive|backup|allocation|allocate|assignment|pool|queue)(?:_|$)/i;
const SUBJECT_AUXILIARY_COMMENT=/配置|日志|统计|汇总|关系|关联|映射|桥接|明细|记录|历史|快照|事件|轨迹|审计|备份|副本|临时|分配|归属|池|飞书群|群组|队列/i;
const SUBJECT_MAIN_COMMENT=/(?:主表|主档|主数据|主体表|业务对象|核心表|基础表|事实表|一(?:条|个|行)?.{0,8}一行)|(?:^|[_\s-])(?:master|entity|fact|core)(?:[_\s-]|$)/i;
const SUBJECT_ROOT_IDENTIFIERS={
  clue:["clue","lead"],account:["account","user"],customer:["customer","client"],order:["order","purchase"],case:["case","matter"],revenue:["revenue","income"],
  seller:["seller","salesperson"],product:["product","sku"],channel:["channel"],region:["region"],organization:["organization","office"],
};
const QUERY_STOP_TOKENS=new Set(["查询","一下","情况","帮我","看下","看看","请问"]);
const GENERIC_AUTHORITY_PHRASES=new Set(["账号","账户","用户","客户","线索","订单","销售","负责人","名称","状态","时间","account","user","customer","clue","lead","order","sales","seller","owner","name","status","time"]);
export const RETRIEVAL_VERSION="retrieval-v2.5";

export function retrieveKnowledge({question,pages,tables,columnsByTable,relations,maxPages=8,maxTables=12,vector=null,conceptAliases=[],termAliases=[],intent=null,ontologySchema=null,enumItemsByColumn={}}) {
  const expandedTerms=expandTermAliases(question,termAliases);
  const rawQuery=`${question||""} ${expandedTerms.join(" ")}`;
  const query=normalize(rawQuery);
  const tokens=tokenize(rawQuery);
  const signals=[...new Set([...semanticSignals(query,conceptAliases),...expandedTerms.map(normalize)])];
  const fusion=vector?.queryVector?{
    queryVector:vector.queryVector,
    pageVectors:vector.pageVectors||new Map(),
    tableVectors:vector.tableVectors||new Map(),
    vectorWeight:clampRatio(vector.vectorWeight,0.4),
    minSimilarity:clampRatio(vector.minSimilarity,0.35),
    semanticThreshold:clampRatio(vector.semanticThreshold,0.55),
  }:null;
  const lexScored=pages.map((page)=>({page,lex:scorePage(page,query,tokens),cos:fusion?cosine(fusion.queryVector,fusion.pageVectors.get(`${page.pageType}:${page.slug}`)):0}));
  const scored=fuseAndFilter(lexScored,fusion).sort((a,b)=>b.score-a.score);
  const requiredPageKeys=new Set((intent?.requirements||[]).map((item)=>item.evidence?.page).filter(Boolean));
  const requiredPages=pages.filter((page)=>requiredPageKeys.has(`${page.pageType}:${page.slug}`));
  const direct=scored.slice(0,maxPages).map((entry)=>entry.page);
  const titles=new Map(pages.map((page)=>[normalize(page.title),page]));
  const expanded=[];
  for(const page of direct) for(const link of wikiLinks(`${page.content||""}\n${page.antiExamples||""}`)) { const linked=titles.get(normalize(link)); if(linked&&!direct.includes(linked)&&!expanded.includes(linked)) expanded.push(linked); }
  const selectedPages=[...new Map([...requiredPages,...direct,...expanded].map((page)=>[`${page.pageType}:${page.slug}`,page])).values()].slice(0,maxPages);
  const selectedNames=[];
  const tableByName=new Map(tables.map((table)=>[table.tableName,table]));
  const ontologyIndex=ontologySchema?buildOntologyIndex(ontologySchema):null;
  // Rejected relationships are never retrieval edges. Published ontology
  // bindings are stricter still: every edge must carry an accepted/confirmed
  // status, while the no-schema branch keeps compatibility with older callers
  // whose in-memory relation fixtures predate relation statuses.
  const usableRelations=(relations||[]).filter((relation)=>usableRelation(relation,{strict:Boolean(ontologyIndex)}));
  const relationGraph=buildRelationGraph(usableRelations,tableByName);
  // Cross-table row-domain predicates are more sensitive than structural
  // recall. They may only reuse an already retrieved closure whose every edge
  // has been explicitly accepted/confirmed; legacy status-less relations must
  // never authorize a verified predicate on another table.
  const confirmedRelationGraph=buildRelationGraph(usableRelations.filter(confirmedRelation),tableByName);

  const lexTables=tables.map((table)=>({table,lex:scoreStructure(table,columnsByTable[table.tableName]||[],query,tokens,signals),cos:fusion?cosine(fusion.queryVector,fusion.tableVectors.get(table.tableName)):0}));
  const structural=fuseAndFilter(lexTables,fusion).sort((a,b)=>b.score-a.score||a.table.tableName.localeCompare(b.table.tableName));

  const retrievalFacets=orderedFacets(buildIntentRetrievalFacets(intent));
  const productScopeValues=retrievalFacets.filter((facet)=>facet.kind==="product"&&facet.required).map((facet)=>facet.value);
  const productSubjectTerms=retrievalFacets.filter((facet)=>facet.kind==="subject"&&facet.required).flatMap((facet)=>[...(facet.terms||[]),...(facet.anchorTerms||[])]);
  const facetEntries=retrievalFacets.map((facet)=>{
    // A verified page is authoritative only for the facet it actually matches.
    // Treating every selected page binding as a boost for every facet lets an
    // unrelated table with no matching field consume the reserved capability
    // slot (for example a law-firm account page suppressing order_time).
    const authoritativePages=facetAuthoritativePages(facet,selectedPages,{productScopeValues});
    const authoritativeNames=new Set(authoritativePages.flatMap((page)=>page.tables||[]));
    // A product facet must identify the product-specific implementation of the
    // requested business object. Product-name evidence alone would otherwise
    // rank every Alpha-prefixed table equally (account, clue, order, ...).
    const rankingFacet=facet.kind==="product"?{
      ...facet,
      terms:[...new Set([...(facet.terms||[]),...productSubjectTerms])],
      productScopeValues,
    }:facet;
    const structuralCandidates=rankFacetTables(rankingFacet,tables,columnsByTable,authoritativeNames);
    const ontologyCandidates=ontologyIndex?rankOntologyFacetTables(facet,ontologyIndex,tableByName):[];
    return {facet,authoritativeNames,authoritativePageKeys:authoritativePages.map(knowledgePageKey),candidates:mergeFacetCandidates(structuralCandidates,ontologyCandidates),selected:[],paths:[],productPaths:new Map(),attributionBinding:null,attributionSubjectTable:null};
  });
  const connectSubjectFacets=new Set(["aggregate","ranking","trend","comparison"]).has(intent?.shape?.kind)
    &&facetEntries.filter((entry)=>entry.facet.kind==="subject"&&entry.facet.required).length>1;
  const selectFacetCandidate=(facetEntry,candidate,{requirePath=false,path:boundPath=null,attributionBinding=null,productScopeId=null}={})=>{
    if(!candidate)return false;
    const name=candidate.table.tableName;
    const path=boundPath||(requirePath&&selectedNames.length?bestPathToSelected(name,selectedNames,relationGraph):[name]);
    if(!path)return false;
    const additions=[...path].reverse().filter((table)=>!selectedNames.includes(table));
    if(selectedNames.length+additions.length>maxTables)return false;
    for(const table of additions)addUnique(selectedNames,table);
    addUnique(facetEntry.selected,name);
    if(!facetEntry.paths.some((item)=>item.join("\u0000")===path.join("\u0000")))facetEntry.paths.push(path);
    if(productScopeId)facetEntry.productPaths.set(productScopeId,path);
    if(attributionBinding)facetEntry.attributionBinding=attributionBinding;
    return true;
  };
  // Resolve explicit products as an injective table assignment before other
  // facets spend the retrieval budget. A shared/ambiguous table cannot prove
  // that two named products were both covered.
  const productAssignments=assignProductFacetCandidates(facetEntries.filter((entry)=>entry.facet.kind==="product"&&entry.facet.required));
  for(const assignment of productAssignments.values())selectFacetCandidate(assignment.entry,assignment.candidate,{productScopeId:assignment.entry.facet.key});
  let filterClosureSnapshot=null;
  // Build the requested capability closure before binding filters. A verified
  // filter may reuse this closure but must never enlarge it, so dimensions,
  // entities and product-specific paths all receive their first opportunity
  // before the immutable snapshot is taken.
  for(const entry of facetEntries)if(entry.facet.required&&!new Set(["product","filter"]).has(entry.facet.kind)) {
    if(strictOntologyAttributionFacet(entry.facet,ontologyIndex)) {
      const subjectEntries=facetEntries.filter((item)=>item.facet.kind==="subject");
      const options=ontologyAttributionOptions({facet:entry.facet,candidates:entry.candidates,subjectEntries,ontologyIndex,relations:usableRelations,columnsByTable});
      if(options.length===1) {
        const option=options[0];
        selectFacetCandidate(entry,option.candidate,{path:option.binding.path,attributionBinding:option.binding});
        // The exact confirmed role path is stronger evidence than the lexical
        // ordering of subject candidates. Once it binds successfully, promote
        // its subject endpoint so a same-named event/relationship object that
        // sorts first cannot become the executable business object.
        if(entry.attributionBinding) {
          const subjectEntry=subjectEntries.find((item)=>item.facet.value===option.subjectConcept);
          const subjectCandidate=subjectEntry?.candidates.find((candidate)=>candidate.table.tableName===option.subjectTable);
          if(subjectEntry&&subjectCandidate) {
            selectFacetCandidate(subjectEntry,subjectCandidate);
            promoteValue(subjectEntry.selected,option.subjectTable);
            promotePath(subjectEntry.paths,[option.subjectTable]);
            subjectEntry.attributionSubjectTable=option.subjectTable;
          }
        }
      }
      continue;
    }
    // A normal multi-subject analytical question describes one result domain,
    // so every subject after the first must carry a confirmed path back to the
    // already selected domain.  Exhaustive/product questions deliberately keep
    // allowMultiple=true because they may be answered by independent result
    // sets over disconnected account systems.
    const wantsPath=entry.facet.kind!=="subject"||Boolean(connectSubjectFacets&&selectedNames.length&&!entry.facet.allowMultiple);
    const connected=wantsPath?connectedCandidates(entry.candidates,selectedNames,relationGraph):[];
    // Preserve independent-facet coverage when no confirmed connector exists;
    // the result contract will then have no join path to authorize and will
    // fail closed if a planner tries to invent one.  When a connector does
    // exist, retain it as executable lineage evidence.
    const candidates=connected.length?connected:entry.candidates;
    selectFacetCandidate(entry,candidates[0],{requirePath:wantsPath&&connected.length>0});
  }
  // Every required capability must be executable inside every explicitly
  // requested product domain. This is stricter than merely selecting N tables:
  // two top-ranked Alpha tables must not impersonate Alpha + AlphaGPT coverage.
  const assignedProductRoots=[...productAssignments.values()].map((assignment)=>({
    id:assignment.entry.facet.key,
    table:assignment.candidate.table.tableName,
  }));
  const allAssignedRoots=new Set(assignedProductRoots.map((item)=>item.table));
  for(const entry of facetEntries) {
    if(!entry.facet.required||new Set(["product","scope","filter"]).has(entry.facet.kind)||strictOntologyAttributionFacet(entry.facet,ontologyIndex))continue;
    for(const product of assignedProductRoots) {
      if(facetPathCoversProduct(entry,product,allAssignedRoots))continue;
      const option=bestCandidateForProductRoot(entry.candidates,product.table,allAssignedRoots,relationGraph);
      if(option)selectFacetCandidate(entry,option.candidate,{path:option.path,productScopeId:product.id});
    }
  }
  filterClosureSnapshot=new Set(selectedNames);
  for(const entry of facetEntries.filter((item)=>item.facet.required&&item.facet.kind==="filter"))for(const option of filterCandidateOptions(entry).slice(0,facetQuota(entry.facet)))selectFacetCandidate(entry,option.candidate,{path:option.path});
  for(const entry of facetEntries.filter((item)=>item.facet.required&&item.facet.kind==="filter"))for(const product of assignedProductRoots) {
    if(facetPathCoversProduct(entry,product,allAssignedRoots))continue;
    const option=filterCandidateOptions(entry,{targetRoots:new Set([product.table]),blockedRoots:new Set([...allAssignedRoots].filter((table)=>table!==product.table))})[0]||null;
    if(option)selectFacetCandidate(entry,option.candidate,{path:option.path,productScopeId:product.id});
  }
  for(const entry of facetEntries) {
    if(entry.facet.kind==="product")break;
    if(entry.facet.kind==="filter") {
      for(const option of filterCandidateOptions(entry)) {
        if(entry.selected.length>=facetQuota(entry.facet))break;
        selectFacetCandidate(entry,option.candidate,{path:option.path});
      }
      continue;
    }
    for(const candidate of secondaryFacetCandidates(entry)) {
      if(entry.selected.length>=facetQuota(entry.facet))break;
      const wantsPath=entry.facet.kind!=="subject"||connectSubjectFacets&&!entry.facet.allowMultiple;
      selectFacetCandidate(entry,candidate,{requirePath:wantsPath&&Boolean(bestPathToSelected(candidate.table.tableName,selectedNames,relationGraph))});
    }
  }

  function secondaryFacetCandidates(entry) {
    if(strictOntologyAttributionFacet(entry.facet,ontologyIndex))return [];
    const wantsPath=entry.facet.kind!=="subject"||connectSubjectFacets&&!entry.facet.allowMultiple;
    if(!wantsPath)return entry.candidates;
    const connected=connectedCandidates(entry.candidates,selectedNames,relationGraph);
    return connected.length?connected:entry.candidates;
  }
  function filterSubjectRoots(entry) {
    const subjectEntries=facetEntries.filter((candidate)=>candidate.facet.kind==="subject"&&candidate.facet.required);
    if(!subjectEntries.length) {
      const exactTables=[...new Set((entry.facet.physicalColumns||[]).map((column)=>String(column).toLowerCase().split(".")[0]).filter((table)=>entry.candidates.some((candidate)=>String(candidate.table.tableName).toLowerCase()===table)))];
      return new Set(exactTables.length===1?exactTables:[]);
    }
    const attached=entry.facet.attachesTo?subjectEntries.filter((candidate)=>candidate.facet.value===entry.facet.attachesTo):subjectEntries.length===1?subjectEntries:[];
    return new Set(attached.flatMap((candidate)=>candidate.attributionSubjectTable?[candidate.attributionSubjectTable]:candidate.facet.allowMultiple?candidate.selected:candidate.selected.slice(0,1)));
  }
  function filterCandidateOptions(entry,{targetRoots=null,blockedRoots=new Set()}={}) {
    const roots=targetRoots||filterSubjectRoots(entry);
    const closure=filterClosureSnapshot||new Set(selectedNames);
    const verifiedPhysical=verifiedPhysicalFilterFacet(entry.facet);
    const options=[];
    for(const candidate of entry.candidates) {
      const table=candidate.table.tableName;
      if(roots.has(table)) {options.push({candidate,path:[table]});continue;}
      // Lexical/catalog filters remain local to their declared business root.
      // Only a verified predicate with an exact physical column may execute on
      // a related table, and that table/path must already belong to the first
      // retrieval closure. This prevents the filter itself from expanding its
      // own authorization surface.
      if(!verifiedPhysical||!closure.has(table))continue;
      const paths=[...roots].map((root)=>bestPathInsideClosure(table,root,confirmedRelationGraph,closure,blockedRoots)).filter(Boolean).sort((left,right)=>left.length-right.length||left.join("\u0000").localeCompare(right.join("\u0000")));
      if(paths[0])options.push({candidate,path:paths[0]});
    }
    return options;
  }
  const facetDiagnostics=facetEntries.map(({facet,authoritativeNames,authoritativePageKeys,candidates,selected,paths,productPaths,attributionBinding,attributionSubjectTable})=>{
    const authoritativeTables=candidates.filter((entry)=>authoritativeNames.has(entry.table.tableName)).map((entry)=>entry.table.tableName);
    const selectedCandidates=candidates.filter((entry)=>selected.includes(entry.table.tableName));
    // Attribution evidence can live on a bridge inserted by the confirmed
    // path. Only inspect the dimension candidate plus its intermediate bridge
    // nodes; the subject/fact endpoint may have a generic is_deleted column and
    // must not impersonate the ownership relation.
    const bindingScope=new Set(paths.flatMap((path)=>path.length<=2?[path[0]]:[path[0],...path.slice(1,-1)]));
    const closureCandidates=[...bindingScope].map((name)=>tableByName.get(name)).filter(Boolean).map((table)=>({table,matchedColumns:rankFacetColumns(facet,columnsByTable[table.tableName]||[],table.tableName)}));
    const bindingCandidates=closureCandidates.filter((entry)=>entry.matchedColumns.some((column)=>column.binding));
    const legacyBindingTables=bindingCandidates.map((entry)=>entry.table.tableName);
    const ontologyBound=strictOntologyAttributionFacet(facet,ontologyIndex);
    const bindingTables=attributionBinding?.tables||legacyBindingTables;
    const bindingColumns=attributionBinding?.columns||[...new Set(bindingCandidates.flatMap((entry)=>entry.matchedColumns.map((column)=>`${entry.table.tableName}.${column.name}`)))];
    const bindingRelationIds=attributionBinding?.relationIds||[];
    const bindingIdentityColumns=attributionBinding?.identityColumns||[];
    const bindingValidityPredicates=attributionBinding?.validityPredicates||[];
    const bindingProvenance=attributionBinding?.provenance||null;
    const executionColumns=facet.kind==="filter"?unambiguousFilterExecutionColumns(selectedCandidates):[...new Set(selectedCandidates.flatMap((entry)=>entry.matchedColumns.map((column)=>`${entry.table.tableName}.${column.name}`)))];
    const filterBindings=facet.kind==="filter"?resolveFilterBindings(facet,executionColumns,{columnsByTable,enumItemsByColumn}):[];
    const executable=facet.kind==="filter"?selectedCandidates.length>0&&executionColumns.length===selectedCandidates.length&&filterBindings.length===executionColumns.length:selectedCandidates.some((entry)=>entry.matchedColumns.length>0||allowsVerifiedRowCount(facet,entry.table.tableName,authoritativeNames));
    const productScopedExecutionTables=[...new Set([...productPaths.values()].map((path)=>path?.[0]).filter(Boolean))];
    // Verified evidence may narrow a single-domain facet, but it cannot erase
    // a separately proven product endpoint from an explicit multi-product
    // request. Keep all product-bound execution endpoints in the contract.
    const executionTables=attributionSubjectTable?[attributionSubjectTable]:productScopedExecutionTables.length?[...new Set([...authoritativeTables,...productScopedExecutionTables])]:authoritativeTables.length?authoritativeTables:new Set(["subject","product"]).has(facet.kind)&&!facet.allowMultiple?selected.slice(0,1):facet.kind==="product"?selected.slice(0,1):selected;
    // Attribution dimensions execute over both the business subject and the
    // displayed dimension object.  The bridge validity is carried separately
    // by bindingValidityPredicates; include current-row predicates for both
    // endpoint tables so deleted sellers/channels/products cannot leak into an
    // otherwise valid ranking.
    const validityTables=facet.kind==="dimension"?[...new Set([...executionTables,...selected.slice(0,1)])]:executionTables;
    const includeDeletedTables=deletionRelaxedTables(facetEntries,intent);
    const confirmedBridgeTables=confirmedIntermediatePathTables(paths,confirmedRelationGraph);
    const executionValidityPredicates=mergePredicates(
      defaultExecutionValidityPredicates({facet,tableNames:validityTables,columnsByTable,includeDeletedTables}),
      defaultActiveRowPredicates({tableNames:confirmedBridgeTables,columnsByTable,includeDeletedTables}),
    );
    const requiredProductScopeIds=facet.kind==="product"?[facet.key]:facet.required&&facet.kind!=="scope"?productScopeValues.map((value)=>`product:${value}`):[];
    const productScopeIds=requiredProductScopeIds.filter((id)=>{
      if(productPaths.has(id))return true;
      const root=productAssignments.get(id)?.candidate?.table?.tableName;
      return Boolean(root&&paths.some((path)=>pathCoversOnlyProductRoot(path,root,allAssignedRoots)));
    });
    const missingProductScopeIds=requiredProductScopeIds.filter((id)=>!productScopeIds.includes(id));
    return {
      key:facet.key,
      kind:facet.kind,
      value:facet.value,
      required:Boolean(facet.required),
      role:facet.role||null,
      attribution:facet.attribution||null,
      covered:selected.length>0&&missingProductScopeIds.length===0&&(!new Set(["dimension","measure","time","filter"]).has(facet.kind)||executable)&&(ontologyBound?Boolean(attributionBinding):(!(facet.bindingTerms||[]).length||bindingTables.length>0)),
      selectedTables:selected,
      authoritativeTables,
      authoritativePageKeys,
      executionTables,
      executionColumns,
      filterBindings,
      identityColumns:[...new Set(selectedCandidates.flatMap((entry)=>entry.matchedColumns.filter((column)=>column.identity).map((column)=>`${entry.table.tableName}.${column.name}`)))],
      executionValidityPredicates,
      labelColumns:[...new Set(selectedCandidates.flatMap((entry)=>entry.matchedColumns.filter((column)=>column.label).map((column)=>`${entry.table.tableName}.${column.name}`)))],
      bindingTables,
      bindingColumns,
      bindingRelationIds,
      bindingIdentityColumns,
      bindingIdentity:attributionBinding?.identity||null,
      bindingValidityPredicates,
      bindingProvenance,
      paths,
      productScopeIds,
      missingProductScopeIds,
      candidates:candidates.slice(0,8).map((entry)=>({name:entry.table.tableName,score:roundScore(entry.score),columns:entry.matchedColumns.slice(0,6).map((column)=>column.name)})),
    };
  });

  // Knowledge-page bindings are an independent channel. They supplement the
  // per-facet candidates but cannot consume the quota reserved for a requested
  // business object, entity, time range, or explicit product.
  for(const page of selectedPages)for(const table of page.tables||[]) {
    if(selectedNames.length>=maxTables)break;
    addUnique(selectedNames,table);
  }

  // The global structural ranking remains a recall/fallback channel after each
  // intent facet has had an independent chance to contribute candidates.
  for(const entry of structural.slice(0,Math.min(8,maxTables))) {
    if(selectedNames.length>=maxTables)break;
    addUnique(selectedNames,entry.table.tableName);
  }

  const directNames=new Set(selectedNames);
  const neighbors=new Map();
  for(const relation of usableRelations) {
    let neighbor=null;
    if(directNames.has(relation.fromTable)&&!directNames.has(relation.toTable)) neighbor=relation.toTable;
    else if(directNames.has(relation.toTable)&&!directNames.has(relation.fromTable)) neighbor=relation.fromTable;
    if(!neighbor||!tableByName.has(neighbor)) continue;
    const semantic=scoreStructure(tableByName.get(neighbor),columnsByTable[neighbor]||[],query,tokens,signals);
    const score=semantic+Number(relation.confidence||0)*2;
    if(score>(neighbors.get(neighbor)||-Infinity)) neighbors.set(neighbor,score);
  }
  for(const [neighbor] of [...neighbors.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))) { if(selectedNames.length>=maxTables)break;addUnique(selectedNames,neighbor); }
  const allowed=new Set(tables.map((table)=>table.tableName));
  const tableNames=selectedNames.filter((name)=>allowed.has(name)).slice(0,maxTables);
  const requiredFacets=facetDiagnostics.filter((facet)=>facet.required);
  const coverageContract={
    required:requiredFacets.map((facet)=>facet.key),
    covered:requiredFacets.filter((facet)=>facet.covered).map((facet)=>facet.key),
    missing:requiredFacets.filter((facet)=>!facet.covered).map((facet)=>facet.key),
    missingDetails:requiredFacets.filter((facet)=>!facet.covered).map((facet)=>({key:facet.key,reason:facet.kind==="filter"&&facet.executionColumns?.length&&!facet.filterBindings?.length?"value_binding_missing":facet.missingProductScopeIds?.length?"product_scope_incomplete":facet.candidates.length?"retrieval_budget":"no_candidate",...(facet.missingProductScopeIds?.length?{missingProductScopeIds:facet.missingProductScopeIds}:{})})),
  };
  return {
    version:RETRIEVAL_VERSION,
    pages:selectedPages,
    tableNames,
    coverage:selectedPages.some((page)=>page.verified&&["term","metric"].includes(page.pageType))?"semantic":tableNames.length?"structural":"none",
    retrievalMode:fusion?"hybrid":"lexical",
    diagnostics:{
      pages:scored.slice(0,maxPages).map((entry)=>({key:`${entry.page.pageType}:${entry.page.slug}`,score:roundScore(entry.score),lexical:roundScore(entry.lex),semantic:roundScore(entry.cos)})),
      tables:structural.slice(0,maxTables).map((entry)=>({name:entry.table.tableName,score:roundScore(entry.score),lexical:roundScore(entry.lex),semantic:roundScore(entry.cos)})),
      facets:facetDiagnostics,
    },
    coverageContract,
  };
}

function connectedCandidates(candidates,selectedNames,graph) {
  if(!selectedNames.length)return candidates;
  return candidates.map((candidate)=>({candidate,path:bestPathToSelected(candidate.table.tableName,selectedNames,graph)})).filter((item)=>item.path).sort((left,right)=>{
    const leftScore=left.candidate.score-Math.max(0,left.path.length-1)*.35;
    const rightScore=right.candidate.score-Math.max(0,right.path.length-1)*.35;
    return Number(right.candidate.subjectPriority||0)-Number(left.candidate.subjectPriority||0)||rightScore-leftScore||left.path.length-right.path.length||left.candidate.table.tableName.localeCompare(right.candidate.table.tableName);
  }).map((item)=>item.candidate);
}

function assignProductFacetCandidates(entries) {
  if(!entries.length)return new Map();
  const ordered=[...entries].sort((left,right)=>left.candidates.length-right.candidates.length||normalize(right.facet.value).length-normalize(left.facet.value).length||left.facet.key.localeCompare(right.facet.key));
  let best={count:-1,score:-Infinity,signature:"",assignments:new Map()};
  const visit=(index,used,assignments,count,score)=>{
    if(index>=ordered.length) {
      const signature=[...assignments.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([key,value])=>`${key}:${value.candidate.table.tableName}`).join("|");
      if(count>best.count||count===best.count&&(score>best.score||score===best.score&&(!best.signature||signature<best.signature)))best={count,score,signature,assignments:new Map(assignments)};
      return;
    }
    const entry=ordered[index];
    for(const candidate of entry.candidates.slice(0,12)) {
      const table=candidate.table.tableName;if(used.has(table))continue;
      used.add(table);assignments.set(entry.facet.key,{entry,candidate});
      visit(index+1,used,assignments,count+1,score+Number(candidate.score||0));
      assignments.delete(entry.facet.key);used.delete(table);
    }
    visit(index+1,used,assignments,count,score);
  };
  visit(0,new Set(),new Map(),0,0);
  return best.assignments;
}

function facetPathCoversProduct(entry,product,allRoots) {
  if(entry.productPaths.has(product.id))return true;
  const path=entry.paths.find((item)=>pathCoversOnlyProductRoot(item,product.table,allRoots));
  if(!path)return false;
  entry.productPaths.set(product.id,path);
  return true;
}

function pathCoversOnlyProductRoot(path,root,allRoots) {
  return Array.isArray(path)&&path.includes(root)&&![...allRoots].some((candidate)=>candidate!==root&&path.includes(candidate));
}

function bestCandidateForProductRoot(candidates,root,allRoots,graph) {
  const blocked=new Set([...allRoots].filter((table)=>table!==root));
  return candidates.map((candidate)=>({candidate,path:bestPathToTarget(candidate.table.tableName,root,graph,blocked)})).filter((item)=>item.path).sort((left,right)=>{
    const leftScore=Number(left.candidate.score||0)-Math.max(0,left.path.length-1)*.35;
    const rightScore=Number(right.candidate.score||0)-Math.max(0,right.path.length-1)*.35;
    return Number(right.candidate.subjectPriority||0)-Number(left.candidate.subjectPriority||0)||rightScore-leftScore||left.path.length-right.path.length||left.candidate.table.tableName.localeCompare(right.candidate.table.tableName);
  })[0]||null;
}

function buildRelationGraph(relations,tableByName) {
  const graph=new Map([...tableByName.keys()].map((name)=>[name,[]]));
  for(const relation of relations||[]) {
    if(!graph.has(relation.fromTable)||!graph.has(relation.toTable))continue;
    graph.get(relation.fromTable).push(relation.toTable);
    graph.get(relation.toTable).push(relation.fromTable);
  }
  return graph;
}

function bestPathToSelected(start,selectedNames,graph,maxHops=4) {
  if(selectedNames.includes(start))return [start];
  if(!graph.has(start))return null;
  const targets=new Set(selectedNames);
  const queue=[[start]];const visited=new Set([start]);
  while(queue.length) {
    const path=queue.shift();
    if(path.length-1>=maxHops)continue;
    for(const neighbor of graph.get(path.at(-1))||[]) {
      if(visited.has(neighbor))continue;
      const next=[...path,neighbor];
      if(targets.has(neighbor))return next;
      visited.add(neighbor);queue.push(next);
    }
  }
  return null;
}

function bestPathToTarget(start,target,graph,blocked=new Set(),maxHops=4) {
  if(start===target)return [start];
  if(!graph.has(start)||!graph.has(target)||blocked.has(start))return null;
  const queue=[[start]];const visited=new Set([start,...blocked]);
  while(queue.length) {
    const path=queue.shift();
    if(path.length-1>=maxHops)continue;
    for(const neighbor of graph.get(path.at(-1))||[]) {
      if(visited.has(neighbor))continue;
      const next=[...path,neighbor];
      if(neighbor===target)return next;
      visited.add(neighbor);queue.push(next);
    }
  }
  return null;
}

function bestPathInsideClosure(start,target,graph,closure,blocked=new Set(),maxHops=4) {
  if(!closure?.has(start)||!closure.has(target))return null;
  const outside=new Set([...graph.keys()].filter((table)=>!closure.has(table)));
  for(const table of blocked||[])outside.add(table);
  outside.delete(start);outside.delete(target);
  return bestPathToTarget(start,target,graph,outside,maxHops);
}

function usableRelation(relation,{strict=false}={}) {
  const status=normalize(relation?.status);
  if(status==="rejected"||status==="denied")return false;
  return !strict||status==="accepted"||status==="confirmed";
}

function confirmedRelation(relation) {
  return new Set(["accepted","confirmed"]).has(normalize(relation?.status));
}

function buildOntologyIndex(schema) {
  const objects=(Array.isArray(schema?.objectTypes)?schema.objectTypes:[]).filter((item)=>item&&typeof item==="object"&&item.apiName);
  const links=(Array.isArray(schema?.linkTypes)?schema.linkTypes:[]).filter((item)=>item&&typeof item==="object");
  const objectTables=new Map(objects.map((object)=>[object.apiName,new Set((object.properties||[]).map((property)=>property?.mapping?.table).filter(Boolean))]));
  return {schema,objects,links,objectTables};
}

function strictOntologyAttributionFacet(facet,ontologyIndex) {
  return Boolean(ontologyIndex&&facet?.kind==="dimension"&&new Set(["current","event_time"]).has(facet.attribution));
}

function rankOntologyFacetTables(facet,ontologyIndex,tableByName) {
  if(!new Set(["subject","dimension"]).has(facet?.kind))return [];
  const candidates=[];
  for(const object of ontologyIndex.objects) {
    if(isAttributionRoleObject(object)||!semanticConceptMatch(ontologyObjectHead(object),facet.value))continue;
    const byTable=new Map();
    for(const property of object.properties||[]) {
      const tableName=property?.mapping?.table;const columnName=property?.mapping?.column;
      if(!tableName||!columnName||!tableByName.has(tableName))continue;
      const propertyText=ontologyPropertyText(property);
      const identity=property.apiName===object.primaryKey||semanticIdentity(propertyText);
      const label=semanticLabel(propertyText);
      const concept=semanticConceptMatch(propertyText,facet.value);
      if(facet.kind==="dimension"&&!identity&&!label&&!concept)continue;
      const items=byTable.get(tableName)||[];
      items.push({name:columnName,score:concept?12:identity?10:8,label,identity,binding:false,ontology:true});
      byTable.set(tableName,items);
    }
    for(const tableName of ontologyIndex.objectTables.get(object.apiName)||[]) {
      const table=tableByName.get(tableName);if(!table)continue;
      const matchedColumns=byTable.get(tableName)||[];
      // A published object mapping is authoritative for subject identity. For
      // a dimension it must still expose a mapped identity or readable label.
      if(facet.kind==="dimension"&&!matchedColumns.length)continue;
      candidates.push({
        table,matchedColumns,score:40,ontologyObjects:[object.apiName],
        subjectPriority:facet.kind==="subject"?ontologySubjectPriority(facet,object,table,ontologyIndex):0,
      });
    }
  }
  return candidates;
}

function mergeFacetCandidates(...groups) {
  const merged=new Map();
  for(const candidate of groups.flat()) {
    const name=candidate?.table?.tableName;if(!name)continue;
    const current=merged.get(name);
    if(!current) {merged.set(name,{...candidate,matchedColumns:[...(candidate.matchedColumns||[])],ontologyObjects:[...(candidate.ontologyObjects||[])]});continue;}
    current.score=Math.max(Number(current.score||0),Number(candidate.score||0));
    current.subjectPriority=Math.max(Number(current.subjectPriority||0),Number(candidate.subjectPriority||0));
    current.ontologyObjects=[...new Set([...(current.ontologyObjects||[]),...(candidate.ontologyObjects||[])])];
    const columns=new Map(current.matchedColumns.map((item)=>[item.name,{...item}]));
    for(const column of candidate.matchedColumns||[]) {
      const existing=columns.get(column.name);
      columns.set(column.name,existing?{...existing,score:Math.max(existing.score||0,column.score||0),label:Boolean(existing.label||column.label),identity:Boolean(existing.identity||column.identity),binding:Boolean(existing.binding||column.binding),ontology:Boolean(existing.ontology||column.ontology)}:{...column});
    }
    current.matchedColumns=[...columns.values()].sort((left,right)=>(right.score||0)-(left.score||0)||left.name.localeCompare(right.name));
  }
  return [...merged.values()].sort(compareFacetCandidates);
}

// Subject retrieval distinguishes a business root from tables that merely
// mention the subject as a foreign key, configuration target or event grain.
// Published ontology identity is the strongest signal; names/comments are a
// deterministic fallback. Auxiliary tables remain candidates when no root is
// available, so this changes ordering without fabricating missing coverage.
function ontologySubjectPriority(facet,object,table,ontologyIndex) {
  const structural=structuralSubjectPriority(facet,table);
  // Exact object identity deliberately excludes the free-form description:
  // mentioning a clue/customer as a property of a configuration object does
  // not turn that object into the queried business root.
  const identityText=semanticText(object?.apiName,object?.displayName);
  if(!semanticConceptMatch(identityText,facet.value)||subjectAuxiliaryName(object?.apiName)||subjectAuxiliaryComment(object?.displayName))return structural;
  const mappedTables=ontologyIndex.objectTables.get(object.apiName)||new Set();
  const primaryTable=(object.properties||[]).find((property)=>property?.apiName===object.primaryKey)?.mapping?.table||null;
  if(primaryTable===table.tableName||mappedTables.size===1||structural===3)return 4;
  return Math.max(3,structural);
}

function structuralSubjectPriority(facet,table) {
  const nameAuxiliary=subjectAuxiliaryName(table?.tableName);
  const canonical=subjectRootIdentifiers(facet).some((identifier)=>rootTableSignal(table?.tableName,identifier));
  const comment=String(table?.comment||"");
  const mainComment=semanticConceptMatch(comment,facet.value)&&SUBJECT_MAIN_COMMENT.test(comment);
  if(!nameAuxiliary&&(canonical||mainComment))return 3;
  if(nameAuxiliary||subjectAuxiliaryComment(comment))return 1;
  return 2;
}

function subjectRootIdentifiers(facet) {
  const value=String(facet?.value||"").toLowerCase();
  const configured=SUBJECT_ROOT_IDENTIFIERS[value]||[];
  return [...new Set([...configured,...(/^[a-z0-9_]+$/.test(value)?[value]:[])])];
}

function subjectAuxiliaryName(value) {return SUBJECT_AUXILIARY_NAME.test(String(value||"").toLowerCase().replace(/-/g,"_"));}
function subjectAuxiliaryComment(value) {return SUBJECT_AUXILIARY_COMMENT.test(String(value||""));}
function compareFacetCandidates(left,right) {
  return Number(right.subjectPriority||0)-Number(left.subjectPriority||0)||Number(right.score||0)-Number(left.score||0)||left.table.tableName.localeCompare(right.table.tableName);
}

function ontologyAttributionOptions({facet,candidates,subjectEntries,ontologyIndex,relations,columnsByTable}) {
  // The current ontology contract has no machine-readable link from an owner
  // snapshot to the completion event required by a won/completed measure.
  // Generic history/stage/snapshot wording is therefore insufficient proof
  // for event-time attribution; keep it closed until that event-role contract
  // is published and validated end to end.
  if(facet.attribution==="event_time")return [];
  const subjectConcepts=[...new Set(subjectEntries.map((entry)=>entry.facet.value).filter(Boolean))];
  const roleMatches=[];
  for(const object of ontologyIndex.objects)for(const subject of subjectConcepts) {
    const match=ontologyRoleMatch(object,{subject,dimension:facet.value,attribution:facet.attribution});
    if(match)roleMatches.push({object,subject,...match});
  }
  const candidateByTable=new Map(candidates.map((candidate)=>[candidate.table.tableName,candidate]));
  const options=[];
  // Role semantics nominate candidates; the actual proof is one unique
  // published role object plus one unique pair of confirmed endpoint edges.
  // Invalid semantic lookalikes must not hide a valid path, while two valid
  // bindings remain an intentional schema gap at the caller.
  for(const {object:roleObject,subject:subjectConcept,referencesByTable} of roleMatches) {
    // This collection is reused for every subject/dimension endpoint pair;
    // Map.keys() itself is a one-shot iterator and would let the first lexical
    // decoy consume the only role table before the real endpoints are checked.
    const roleTables=[...referencesByTable.keys()];
    const subjectObjects=ontologyIndex.objects.filter((object)=>object!==roleObject&&!isAttributionRoleObject(object)&&semanticConceptMatch(ontologyObjectIdentityText(object),subjectConcept));
    const dimensionObjects=ontologyIndex.objects.filter((object)=>object!==roleObject&&!isAttributionRoleObject(object)&&semanticConceptMatch(ontologyObjectIdentityText(object),facet.value));
    for(const subjectObject of subjectObjects)for(const dimensionObject of dimensionObjects)for(const roleTable of roleTables) {
      // Evaluate every ontology-mapped subject table. The exact role path must
      // disambiguate the subject rather than inherit the first lexical match.
      const subjectTables=[...(ontologyIndex.objectTables.get(subjectObject.apiName)||[])];
      const dimensionTables=[...(ontologyIndex.objectTables.get(dimensionObject.apiName)||[])].filter((table)=>candidateByTable.has(table));
      for(const subjectTable of subjectTables)for(const dimensionTable of dimensionTables) {
        if(new Set([subjectTable,roleTable,dimensionTable]).size!==3)continue;
        const roleReferences=referencesByTable.get(roleTable);if(!roleReferences)continue;
        const subjectIdentityColumns=ontologyEndpointIdentityColumns(subjectObject,subjectTable,subjectConcept);
        const dimensionIdentityColumns=ontologyEndpointIdentityColumns(dimensionObject,dimensionTable,facet.value);
        if(!subjectIdentityColumns.size||!dimensionIdentityColumns.size)continue;
        const subjectEdges=ontologyPairRelations({leftObject:subjectObject,rightObject:roleObject,leftTable:subjectTable,rightTable:roleTable,ontologyIndex,relations}).filter((relation)=>roleReferences.subjectColumns.has(relationColumnOnTable(relation,roleTable))&&subjectIdentityColumns.has(relationColumnOnTable(relation,subjectTable)));
        const dimensionEdges=ontologyPairRelations({leftObject:dimensionObject,rightObject:roleObject,leftTable:dimensionTable,rightTable:roleTable,ontologyIndex,relations}).filter((relation)=>roleReferences.dimensionColumns.has(relationColumnOnTable(relation,roleTable))&&dimensionIdentityColumns.has(relationColumnOnTable(relation,dimensionTable)));
        if(subjectEdges.length!==1||dimensionEdges.length!==1||relationId(subjectEdges[0])===relationId(dimensionEdges[0]))continue;
        const binding=buildOntologyAttributionBinding({facet,ontologyIndex,roleObject,subjectObject,dimensionObject,roleTable,subjectTable,dimensionTable,subjectEdge:subjectEdges[0],dimensionEdge:dimensionEdges[0],columnsByTable});
        if(binding)options.push({candidate:candidateByTable.get(dimensionTable),binding,subjectConcept,subjectTable});
      }
    }
  }
  return [...new Map(options.map((option)=>[`${option.binding.provenance.roleObject}\u0000${option.binding.provenance.subjectObject}\u0000${option.binding.provenance.dimensionObject}\u0000${option.binding.path.join("\u0000")}\u0000${option.binding.relationIds.join("\u0000")}`,option])).values()];
}

function ontologyPairRelations({leftObject,rightObject,leftTable,rightTable,ontologyIndex,relations}) {
  const direct=relations.filter((relation)=>relationId(relation)!=null&&relationConnects(relation,leftTable,rightTable));
  const links=ontologyIndex.links.filter((link)=>linkConnectsObjects(link,leftObject.apiName,rightObject.apiName));
  if(!links.length)return direct;
  const mappedIds=new Set(links.flatMap((link)=>link.relationMappings||[]).map((mapping)=>relationId(mapping)).filter((id)=>id!=null));
  return direct.filter((relation)=>mappedIds.has(relationId(relation)));
}

function buildOntologyAttributionBinding({facet,ontologyIndex,roleObject,subjectObject,dimensionObject,roleTable,subjectTable,dimensionTable,subjectEdge,dimensionEdge,columnsByTable}) {
  const subjectRoleColumn=relationColumnOnTable(subjectEdge,roleTable);
  const dimensionRoleColumn=relationColumnOnTable(dimensionEdge,roleTable);
  if(!subjectRoleColumn||!dimensionRoleColumn||subjectRoleColumn===dimensionRoleColumn)return null;
  const identityColumns=[`${roleTable}.${dimensionRoleColumn}`];
  const validityPredicates=(columnsByTable[roleTable]||[])
    .map((column)=>exactLifecyclePredicate(roleTable,column,{includeCurrent:true}))
    .filter(Boolean)
    .sort((left,right)=>left.column.localeCompare(right.column));
  // A current-owner role must carry an executable active-row invariant. Two
  // confirmed joins alone do not prove that a history/assignment table yields
  // one live owner rather than every owner ever recorded.
  if(facet.attribution==="current"&&!validityPredicates.length)return null;
  const relationIds=[relationId(dimensionEdge),relationId(subjectEdge)];
  const linkedNames=ontologyIndex.links.filter((link)=>linkConnectsObjects(link,subjectObject.apiName,roleObject.apiName)||linkConnectsObjects(link,dimensionObject.apiName,roleObject.apiName)).filter((link)=>(link.relationMappings||[]).some((mapping)=>relationIds.includes(relationId(mapping)))).map((link)=>link.apiName).filter(Boolean);
  const columns=[...new Set([`${roleTable}.${dimensionRoleColumn}`,`${roleTable}.${subjectRoleColumn}`,...identityColumns,...validityPredicates.map((item)=>item.column)])];
  return {
    path:[dimensionTable,roleTable,subjectTable],relationIds,tables:[roleTable],columns,identityColumns,validityPredicates,
    identity:{roleObject:roleObject.apiName,subjectObject:subjectObject.apiName,dimensionObject:dimensionObject.apiName,columns:identityColumns},
    provenance:{kind:"published_ontology_role_object",schema:ontologyIndex.schema?.name||null,roleObject:roleObject.apiName,roleDisplayName:roleObject.displayName||roleObject.apiName,subjectObject:subjectObject.apiName,dimensionObject:dimensionObject.apiName,attribution:facet.attribution,linkTypes:[...new Set(linkedNames)]},
  };
}

function ontologyRoleMatch(object,{subject,dimension,attribution}) {
  const head=ontologyObjectHead(object);const full=ontologyObjectText(object);
  const descriptor=semanticText(object?.apiName,object?.displayName,object?.description);
  if(attribution==="current"&&TEMPORAL_ROLE_CONTAINER_PATTERN.test(descriptor))return null;
  const referencePairs=ontologyRoleReferencePairs(object,{subject,dimension});
  if(!referencePairs.length||!semanticConceptMatch(full,subject)||!semanticConceptMatch(full,dimension))return null;
  const attributionPattern=attribution==="current"?CURRENT_ATTRIBUTION_PATTERN:attribution==="event_time"?EVENT_ATTRIBUTION_PATTERN:null;
  if(!attributionPattern)return null;
  // Temporal attribution must be stated on the seller identity reference
  // itself. Generic object prose such as "当前跟进销售动态" is retrieval
  // recall only and must not turn feed/action/history objects into ownership
  // roles. The role/assignment meaning may live on either the object head or
  // that same seller-reference property.
  const roleIdentity=ontologyObjectIdentityText(object);
  const boundPairs=referencePairs.filter(({right})=>{
    const dimensionReference=ontologyPropertyText(right);
    const ownsQueriedSubject=semanticConceptMatch(roleIdentity,subject)||semanticConceptMatch(dimensionReference,subject);
    return ownsQueriedSubject&&attributionPattern.test(dimensionReference)&&(ATTRIBUTION_ROLE_PATTERN.test(head)||ATTRIBUTION_ROLE_PATTERN.test(dimensionReference));
  });
  if(!boundPairs.length)return null;
  const referencesByTable=new Map();
  for(const {left,right} of boundPairs) {
    const table=left.mapping.table;const references=referencesByTable.get(table)||{subjectColumns:new Set(),dimensionColumns:new Set()};
    references.subjectColumns.add(left.mapping.column);references.dimensionColumns.add(right.mapping.column);referencesByTable.set(table,references);
  }
  return {referencesByTable};
}

function isAttributionRoleObject(object) {
  const head=ontologyObjectHead(object);const full=ontologyObjectText(object);const referencePairs=genericOntologyRoleReferencePairs(object);
  const identity=ontologyObjectIdentityText(object);
  // Free-form descriptions may document a current-owner attribute on a real
  // business object. They cannot reclassify that endpoint as a bridge/role.
  const explicitRoleContainer=(subjectAuxiliaryName(object?.apiName)||subjectAuxiliaryComment(object?.displayName||""))&&ATTRIBUTION_ROLE_PATTERN.test(identity);
  return explicitRoleContainer&&ROLE_SUBJECT_PATTERN.test(full)&&SEMANTIC_CONCEPT_PATTERNS.seller.test(full)&&referencePairs.some(({right})=>{
    const dimensionReference=ontologyPropertyText(right);
    const attributionSemantics=CURRENT_ATTRIBUTION_PATTERN.test(dimensionReference)||EVENT_ATTRIBUTION_PATTERN.test(dimensionReference);
    return attributionSemantics&&(ATTRIBUTION_ROLE_PATTERN.test(head)||ATTRIBUTION_ROLE_PATTERN.test(dimensionReference));
  });
}
function ontologyRoleReferencePairs(object,{subject,dimension}) {
  const mapped=(object.properties||[]).filter((property)=>property?.mapping?.table&&property?.mapping?.column);
  const subjectRefs=mapped.filter((property)=>semanticIdentity(ontologyPropertyText(property))&&semanticConceptMatch(ontologyPropertyText(property),subject));
  const dimensionRefs=mapped.filter((property)=>semanticIdentity(ontologyPropertyText(property))&&semanticConceptMatch(ontologyPropertyText(property),dimension));
  return distinctSameTableReferencePairs(subjectRefs,dimensionRefs);
}
function genericOntologyRoleReferencePairs(object) {
  const mapped=(object.properties||[]).filter((property)=>property?.mapping?.table&&property?.mapping?.column);
  const subjectRefs=mapped.filter((property)=>semanticIdentity(ontologyPropertyText(property))&&ROLE_SUBJECT_PATTERN.test(ontologyPropertyText(property)));
  const dimensionRefs=mapped.filter((property)=>semanticIdentity(ontologyPropertyText(property))&&SEMANTIC_CONCEPT_PATTERNS.seller.test(ontologyPropertyText(property)));
  return distinctSameTableReferencePairs(subjectRefs,dimensionRefs);
}
function distinctSameTableReferencePairs(left,right) {
  return left.flatMap((leftProperty)=>right.map((rightProperty)=>({left:leftProperty,right:rightProperty}))).filter(({left:leftProperty,right:rightProperty})=>leftProperty.mapping.table===rightProperty.mapping.table&&leftProperty.mapping.column!==rightProperty.mapping.column);
}
function ontologyEndpointIdentityColumns(object,table,concept) {
  return new Set((object.properties||[]).filter((property)=>{
    if(property?.mapping?.table!==table)return false;
    if(property.apiName===object.primaryKey)return true;
    // Descriptions may mention the owning object while explaining a foreign
    // attribute (for example "线索渠道标识"). Only the property's declared
    // name/display label can promote a non-primary mapping to endpoint identity.
    const declaredIdentity=semanticText(property.apiName,property.displayName);
    return semanticIdentity(declaredIdentity)&&semanticConceptMatch(declaredIdentity,concept);
  }).map((property)=>property.mapping.column));
}
function ontologyObjectHead(object) { return semanticText(object?.apiName,object?.displayName,object?.description,...(object?.properties||[]).map((property)=>property?.mapping?.table)); }
function ontologyObjectIdentityText(object) { return semanticText(object?.apiName,object?.displayName); }
function ontologyObjectText(object) { return semanticText(ontologyObjectHead(object),...(object?.properties||[]).map(ontologyPropertyText)); }
function ontologyPropertyText(property) { return semanticText(property?.apiName,property?.displayName,property?.description); }
function semanticText(...values) { return values.flat().map((value)=>String(value||"").toLowerCase().replace(/[_-]+/g," ")).filter(Boolean).join(" "); }
function semanticIdentity(value) { return /(?:^|[_\s])id(?:[_\s]|$)|编号|标识|主键|唯一键|identity|identifier/i.test(String(value||"")); }
function semanticLabel(value) { return /名称|姓名|名字|name|label|title/i.test(String(value||"")); }
function semanticConceptMatch(value,concept) { const pattern=SEMANTIC_CONCEPT_PATTERNS[concept];return pattern?pattern.test(String(value||"")):Boolean(concept&&normalize(value).includes(normalize(concept))); }
function relationId(value) { const raw=value?.relationId??value?.id;if(raw==null||raw==="")return null;const number=Number(raw);return Number.isInteger(number)&&number>0?number:null; }
function relationConnects(relation,leftTable,rightTable) { return relation?.fromTable===leftTable&&relation?.toTable===rightTable||relation?.fromTable===rightTable&&relation?.toTable===leftTable; }
function relationColumnOnTable(relation,table) { return relation?.fromTable===table?relation.fromCol:relation?.toTable===table?relation.toCol:null; }
function linkConnectsObjects(link,left,right) { return link?.source===left&&link?.target===right||link?.source===right&&link?.target===left; }

const ATTRIBUTION_ROLE_PATTERN=/归属|负责|跟进|分配|指派|责任|ownership|attribution|assignment|assignee|owner/i;
const CURRENT_ATTRIBUTION_PATTERN=/当前|现任|目前|\bcurrent\b|current[_\s-]?(?:owner|assignee|attribution|assignment)|active[_\s-]?(?:owner|assignee)/i;
const EVENT_ATTRIBUTION_PATTERN=/成单时|成交时|事件发生时|当时|历史|快照|event[_\s-]?time|event[_\s-]?owner|owner[_\s-]?snapshot|closing[_\s-]?owner|won[_\s-]?owner/i;
const TEMPORAL_ROLE_CONTAINER_PATTERN=/历史|快照|事件|阶段|变更|轨迹|日志|history|snapshot|event|stage|timeline|audit|log/i;
const ROLE_SUBJECT_PATTERN=/线索|进线|账号|账户|客户|订单|案件|案源|收入|营收|\bclue\b|\blead\b|\baccount\b|\bcustomer\b|\border\b|\bcase\b|\brevenue\b/i;
const SEMANTIC_CONCEPT_PATTERNS={
  clue:/线索|进线|\bclue\b|\blead\b/i,
  account:/账号|账户|\baccount\b|\buser\b/i,
  customer:/客户|客群|\bcustomer\b|\bclient\b/i,
  order:/订单|下单|\border\b|\bpurchase\b/i,
  case:/案件|案源|\bcase\b|\bmatter\b/i,
  revenue:/收入|营收|回款|\brevenue\b/i,
  seller:/销售|业务员|负责人|顾问|\bseller\b|\bsalesperson\b|\bowner\b|\bassignee\b/i,
  product:/产品|商品|\bproduct\b|\bsku\b/i,
  channel:/渠道|来源|\bchannel\b|\bsource\b/i,
  region:/地区|区域|省份|城市|\bregion\b|\bprovince\b|\bcity\b/i,
  organization:/机构|律所|部门|团队|\borganization\b|\boffice\b|\bdepartment\b|\bteam\b/i,
};

function orderedFacets(facets) {
  const priority={subject:0,measure:1,dimension:2,time:3,filter:4,entity:5,product:6,scope:7};
  return [...facets].sort((left,right)=>(priority[left.kind]??9)-(priority[right.kind]??9)||left.key.localeCompare(right.key));
}

function facetQuota(facet) { return Number.isInteger(facet.quota)&&facet.quota>0?facet.quota:facet.kind==="subject"||facet.kind==="product"?2:1; }

function rankFacetTables(facet,tables,columnsByTable,pageBoundNames=new Set()) {
  const raw=(facet.terms||[]).join(" ");
  const query=normalize(raw);
  const tokens=tokenize(raw);
  const signals=[...new Set((facet.terms||[]).map(normalize).filter(Boolean))];
  const anchors=[...new Set((facet.anchorTerms||[]).map(normalize).filter(Boolean))];
  return tables.map((table)=>{
    const pageBound=pageBoundNames.has(table.tableName);
    const productEvidence=facet.kind==="product"?productStructureEvidence(facet,table):null;
    return {table,pageBound,productEvidence};
  }).filter(({table,pageBound,productEvidence})=>{
    if(facet.kind!=="product")return !anchors.length||structureContains(table,columnsByTable[table.tableName]||[],anchors);
    // A verified, product-specific page may bind an otherwise neutral table,
    // but an explicit conflicting table comment remains a schema contradiction.
    if(pageBound&&productEvidence?.source!=="comment_conflict")return true;
    return Number(productEvidence?.confidence||0)>0;
  }).map(({table,pageBound,productEvidence})=>({
    table,
    matchedColumns:rankFacetColumns(facet,columnsByTable[table.tableName]||[],table.tableName),
    score:scoreStructure(table,columnsByTable[table.tableName]||[],query,tokens,signals)+(pageBound?12:0)+Math.max(0,Number(productEvidence?.confidence||0))*6,
    subjectPriority:facet.kind==="subject"?structuralSubjectPriority(facet,table):0,
  }))
    // Analytical capabilities must bind an executable physical field. A page
    // binding may raise the priority of a matching table, but it cannot turn a
    // fieldless table into measure/time/dimension evidence.
    .filter((entry)=>entry.score>0&&(!new Set(["dimension","measure","time","filter"]).has(facet.kind)||entry.matchedColumns.length>0||allowsVerifiedRowCount(facet,entry.table.tableName,pageBoundNames)))
    .sort(compareFacetCandidates);
}

function productStructureEvidence(facet,table) {
  const values=[...new Set([...(facet.productScopeValues||[]),facet.value].filter(Boolean))];
  const current=String(facet.value||"");
  const commentMatches=matchingProductValues(table.comment,values);
  if(commentMatches.length)return commentMatches.length===1&&commentMatches[0]===current?{confidence:4,source:"comment"}:{confidence:-1,source:"comment_conflict"};
  const nameMatches=matchingProductValues(table.tableName,values);
  if(nameMatches.length)return nameMatches.length===1&&nameMatches[0]===current?{confidence:3,source:"table_name"}:{confidence:-1,source:"table_name_conflict"};
  return {confidence:0,source:"none"};
}

function matchingProductValues(value,products) {
  const text=String(value||"");
  return products.filter((product)=>productMarkerPattern(product).test(text));
}

function productMarkerPattern(value) {
  const parts=String(value||"").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g)||[];
  if(!parts.length)return /$a/;
  if(parts.every((part)=>/^[a-z0-9]+$/.test(part)))return new RegExp(`(?:^|[^a-z0-9])${parts.map(escapeRegExp).join("[\\s_-]*")}(?:$|[^a-z0-9])`,"i");
  return new RegExp(parts.map(escapeRegExp).join("\\s*"),"i");
}

function rankFacetColumns(facet,columns,tableName="") {
  const exactPhysical=new Set((facet.physicalColumns||[]).map((value)=>String(value||"").toLowerCase()));
  if(facet.kind==="filter"&&exactPhysical.size)return (columns||[]).filter((column)=>exactPhysical.has(`${String(tableName).toLowerCase()}.${String(column.columnName).toLowerCase()}`)).map((column)=>({name:column.columnName,score:100,label:false,identity:Boolean(column.isPrimary||column.isUnique),binding:true,physical:true}));
  const terms=[...(facet.terms||[]),...(facet.anchorTerms||[])].map(normalize).filter(Boolean);
  const bindingTerms=(facet.bindingTerms||[]).map(normalize).filter(Boolean);
  const labels=(facet.labelTerms||[]).map(normalize).filter(Boolean);
  return columns.map((column)=>{
    const name=normalize(column.columnName);const comment=normalize(column.comment||"");const text=normalize(`${column.columnName} ${column.comment||""}`);
    let score=0;
    if(facet.kind==="filter") {
      const field=normalize(facet.field||"");const surface=normalize(facet.fieldSurface||"");
      const subjectPrefix=({clue:"线索",account:"账号",customer:"客户",order:"订单",case:"案件"})[facet.attachesTo]||"";
      if(field&&name===field)score=60;
      else if(surface&&(comment===surface||subjectPrefix&&comment===normalize(`${subjectPrefix}${surface}`)))score=60;
      else if(facet.role==="organization_name"&&/(?:^|_)(?:user_)?(?:office|law_?firm|firm|organization|org)_?name(?:_|$)/i.test(String(column.columnName||"")))score=60;
      else if((facet.fieldTerms||[]).map(normalize).filter(Boolean).includes(name))score=40;
      const identity=Boolean(column.isPrimary||column.isUnique)||semanticIdentity(text);
      return {name:column.columnName,score,label:false,identity,binding:score>0,physical:false};
    }
    for(const term of terms)if(text.includes(term)||term.includes(text))score+=term.includes("_")?3:1;
    const label=labels.some((term)=>text.includes(term))||/(?:^|_)(?:name|title|label)(?:_|$)/i.test(column.columnName)||/名称|姓名/.test(String(column.comment||""));
    const identity=Boolean(column.isPrimary||column.isUnique)||semanticIdentity(text);
    const binding=bindingTerms.some((term)=>text.includes(term)||term.includes(text));
    if(binding)score+=4;
    if(label&&facet.kind==="dimension")score+=1;
    return {name:column.columnName,score,label,identity,binding};
  }).filter((item)=>item.score>0).sort((left,right)=>right.score-left.score||left.name.localeCompare(right.name));
}

function resolveFilterBindings(facet,executionColumns,{columnsByTable,enumItemsByColumn}) {
  const result=[];
  for(const column of executionColumns||[]) {
    const binding=resolveFilterBinding(facet,column,{columnsByTable,enumItemsByColumn});
    if(!binding)return [];
    result.push(binding);
  }
  return result;
}

function resolveFilterBinding(facet,column,{columnsByTable,enumItemsByColumn}) {
  const [tableName,columnName]=String(column||"").toLowerCase().split(".");
  const metadata=(columnsByTable?.[tableName]||[]).find((item)=>String(item.columnName||"").toLowerCase()===columnName);
  if(!metadata)return null;
  const operator=String(facet.operator||"eq");const sourceValue=facet.value;const sourceType=String(facet.valueType||"string").toLowerCase();
  if(sourceType==="null")return filterBinding(column,operator,null,"null",sourceValue,{kind:facet.valueBinding==="verified_knowledge"?"verified_knowledge_predicate":"literal_null"});
  if(facet.valueBinding==="verified_knowledge")return filterBinding(column,operator,sourceValue,sourceType,sourceValue,{kind:"verified_knowledge_predicate",provenance:facet.provenance||facet.evidence||null});
  const unknownType=!String(metadata.dataType||"").trim();const numericColumn=isNumericType(metadata.dataType);const textualColumn=unknownType||isTextualType(metadata.dataType);
  if(sourceType==="number") {
    if(!numericColumn&&!unknownType)return null;
    const value=canonicalNumericValue(sourceValue);if(value==null)return null;
    return filterBinding(column,operator,value,"number",sourceValue,{kind:"numeric_literal"});
  }
  if(sourceType==="boolean") {
    if(!numericColumn&&!/bool/i.test(String(metadata.dataType||"")))return null;
    const value=String(sourceValue).toLowerCase();if(!new Set(["true","false","0","1"]).has(value))return null;
    return filterBinding(column,operator,value,/^[01]$/.test(value)?"number":"boolean",sourceValue,{kind:"boolean_literal"});
  }
  if(sourceType!=="string"||!textualColumn&&!numericColumn)return null;
  const items=(enumItemsByColumn?.[`${tableName}.${columnName}`]||[]).filter((item)=>String(item?.value)!=="null");
  if(items.length) {
    const exact=items.filter((item)=>String(item.value)===String(sourceValue));
    if(exact.length===1)return filterBinding(column,operator,String(exact[0].value),inferBoundType(exact[0].value,metadata.dataType),sourceValue,{kind:"observed_enum_value"});
    if(operator==="contains")return null;
    const meanings=items.filter((item)=>verifiedEnumMeaning(item)&&normalize(item.meaning)===normalize(sourceValue));
    const values=[...new Set(meanings.map((item)=>String(item.value)))];
    if(values.length===1)return filterBinding(column,operator,values[0],inferBoundType(values[0],metadata.dataType),sourceValue,{kind:"verified_enum_meaning",meaning:meanings[0].meaning,meaningSource:meanings[0].meaningSource});
    return null;
  }
  if(!textualColumn)return null;
  return filterBinding(column,operator,String(sourceValue),"string",sourceValue,{kind:"direct_string_literal"});
}

function filterBinding(column,operator,value,valueType,sourceValue,evidence) {return {column:String(column).toLowerCase(),operator,value,valueType,sourceValue,evidence};}
function isNumericType(value) {return /(?:tinyint|smallint|mediumint|bigint|decimal|numeric|number|float|double|real|integer|\bint\b)/i.test(String(value||""));}
function isTextualType(value) {return /(?:char|text|enum|set|json|uuid)/i.test(String(value||""));}
function inferBoundType(value,dataType) {return isNumericType(dataType)&&canonicalNumericValue(value)!=null?"number":"string";}
function verifiedEnumMeaning(item) {return Boolean(String(item?.meaning||"").trim()&&/^(?:verified|manual|human|user|ontology|knowledge|reviewed|confirmed)$/i.test(String(item?.meaningSource||"")));}
function canonicalNumericValue(value) {
  const match=String(value??"").trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);if(!match)return null;
  let integer=String(match[2]||"0").replace(/^0+(?=\d)/,"");let fraction=String(match[3]??match[4]??"").replace(/0+$/,"");
  const zero=/^0+$/.test(integer)&&!fraction;const sign=match[1]==="-"&&!zero?"-":"";
  return `${sign}${integer||"0"}${fraction?`.${fraction}`:""}`;
}

function unambiguousFilterExecutionColumns(entries) {
  const result=[];
  for(const entry of entries||[]) {
    const maximum=Math.max(...(entry.matchedColumns||[]).map((column)=>Number(column.score)||0),0);
    const strongest=(entry.matchedColumns||[]).filter((column)=>(Number(column.score)||0)===maximum&&maximum>0);
    if(strongest.length!==1)return [];
    result.push(`${entry.table.tableName}.${strongest[0].name}`);
  }
  return [...new Set(result)];
}

function facetAuthoritativePages(facet,pages,{productScopeValues=[]}={}) {
  const explicitPage=facet.evidence?.level==="verified_knowledge"&&facet.evidence.page||facet.provenance?.level==="verified_knowledge"&&facet.provenance.page;
  if(explicitPage) {
    const exact=(pages||[]).find((page)=>page.verified&&`${page.pageType}:${page.slug}`===explicitPage);
    return exact?[exact]:[];
  }
  const matched=[];
  for(const page of pages||[]) {
    if(!page.verified)continue;
    if(facet.kind==="measure"&&page.pageType!=="metric")continue;
    if(facet.kind==="product") {
      const matches=matchingProductValues([page.title,...(page.aliases||[])].join(" "),productScopeValues);
      if(matches.length!==1||matches[0]!==facet.value)continue;
    }
    // Body/SQL tokens and embedding similarity are recall signals only. They
    // cannot promote a page into an authoritative contract for a facet. That
    // promotion requires an explicit evidence key above or a strong phrase
    // match between the facet vocabulary and the page title/aliases.
    if(!highConfidenceFacetPageMatch(facet,page))continue;
    matched.push(page);
  }
  return matched;
}

function knowledgePageKey(page) {return `${page?.pageType||"asset"}:${page?.slug||""}`;}

function highConfidenceFacetPageMatch(facet,page) {
  const facetPhrases=[facet?.value,facet?.sourceValue,facet?.field,facet?.fieldSurface,...(facet?.terms||[]),...(facet?.anchorTerms||[]),...(facet?.fieldTerms||[]),...(facet?.bindingTerms||[]),...(facet?.labelTerms||[])].map(normalize).filter(Boolean);
  const pageAliases=Array.isArray(page?.aliases)?page.aliases:[];
  const pagePhrases=[page?.title,...pageAliases].map(normalize).filter(Boolean);
  for(const pagePhrase of pagePhrases)for(const facetPhrase of facetPhrases) {
    if(pagePhrase===facetPhrase&&pagePhrase.length>=2)return true;
    if(pagePhrase.length>=3&&!GENERIC_AUTHORITY_PHRASES.has(pagePhrase)&&facetPhrase.includes(pagePhrase))return true;
    // Do not let a generic two-character subject such as “账号” activate a
    // same-table page titled “AlphaGPT 律所账号”. The facet phrase itself must
    // be specific before the broader page label may contain it.
    if(facetPhrase.length>=4&&!GENERIC_AUTHORITY_PHRASES.has(facetPhrase)&&pagePhrase.includes(facetPhrase))return true;
  }
  return false;
}

function allowsVerifiedRowCount(facet,tableName,authoritativeNames) {
  return facet.kind==="measure"
    &&facet.aggregation==="count"
    &&facet.evidence?.level==="verified_knowledge"
    &&facet.metricDefinition?.rowCount===true
    &&facet.metricDefinition?.source===facet.evidence.page
    &&authoritativeNames.has(tableName);
}

function deletionRelaxedTables(facetEntries,intent) {
  if(!intent?.scope?.deletionExplicit)return new Set();
  const targets=new Set(intent?.scope?.deletionTargets||[]);
  for(const filter of intent?.filters||[])if(filter.field==="is_deleted"&&filter.attachesTo)targets.add(filter.attachesTo);
  if(intent?.scope?.includeDeleted)for(const subject of intent?.subjects||[])targets.add(subject);
  const tables=new Set();
  for(const entry of facetEntries||[])if(entry.facet?.kind==="subject"&&targets.has(entry.facet.value))for(const table of entry.facet.allowMultiple?entry.selected:entry.selected.slice(0,1))tables.add(String(table).toLowerCase());
  return tables;
}

function defaultExecutionValidityPredicates({facet,tableNames,columnsByTable,includeDeletedTables=new Set()}) {
  const structuralMeasure=facet.kind==="measure"&&facet.evidence?.level!=="verified_knowledge";
  if(facet.kind!=="subject"&&facet.kind!=="time"&&facet.kind!=="dimension"&&facet.kind!=="product"&&facet.kind!=="filter"&&!structuralMeasure)return [];
  return defaultActiveRowPredicates({tableNames,columnsByTable,includeDeletedTables});
}

function defaultActiveRowPredicates({tableNames,columnsByTable,includeDeletedTables=new Set()}) {
  const predicates=[];
  for(const table of tableNames||[])for(const column of columnsByTable[table]||[]) {
    const predicate=exactLifecyclePredicate(table,column,{relaxSoftDelete:includeDeletedTables.has(String(table).toLowerCase())});
    if(predicate)predicates.push(predicate);
  }
  return [...new Map(predicates.map((item)=>[item.column.toLowerCase(),item])).values()].sort((left,right)=>left.column.localeCompare(right.column));
}

function exactLifecyclePredicate(table,column,{includeCurrent=false,relaxSoftDelete=false}={}) {
  const name=String(column?.columnName||"").toLowerCase();
  // Lifecycle inference is deliberately closed over exact conventional names.
  // Free-form comments and lookalikes such as status/enabled/active cannot
  // silently narrow a query's row domain without verified knowledge.
  if(name==="is_deleted")return relaxSoftDelete?null:{column:`${table}.${column.columnName}`,operator:"=",valueType:"number",value:"0"};
  if(name==="is_valid")return {column:`${table}.${column.columnName}`,operator:"=",valueType:"number",value:"1"};
  if(includeCurrent&&name==="is_current")return {column:`${table}.${column.columnName}`,operator:"=",valueType:"number",value:"1"};
  return null;
}

function confirmedIntermediatePathTables(paths,graph) {
  const tables=new Set();
  for(const path of paths||[]) {
    if(path.length<3||!path.every((table,index)=>index===0||(graph.get(path[index-1])||[]).includes(table)))continue;
    for(const table of path.slice(1,-1))tables.add(table);
  }
  return [...tables];
}

function mergePredicates(...groups) {
  return [...new Map(groups.flat().map((item)=>[`${String(item.column).toLowerCase()}|${item.operator}|${item.valueType}|${String(item.value)}`,item])).values()].sort((left,right)=>left.column.localeCompare(right.column));
}

function verifiedPhysicalFilterFacet(facet) {
  return facet?.kind==="filter"&&facet.valueBinding==="verified_knowledge"&&Array.isArray(facet.physicalColumns)&&facet.physicalColumns.length>0;
}

function structureContains(table,columns,terms) {
  const texts=[normalize(`${table.tableName} ${table.comment||""}`),...columns.map((column)=>normalize(`${column.columnName} ${column.comment||""}`))];
  return terms.some((term)=>texts.some((text)=>text.includes(term)));
}

function fuseAndFilter(entries,fusion) {
  if(!fusion) return entries.filter((entry)=>entry.lex>0).map((entry)=>({...entry,score:entry.lex}));
  const maxLex=Math.max(...entries.map((entry)=>entry.lex),0);
  const fused=[];
  for(const entry of entries) {
    const similarity=entry.cos>=fusion.minSimilarity?entry.cos:0;
    if(entry.lex<=0&&similarity<fusion.semanticThreshold) continue;
    const lexNorm=maxLex>0?entry.lex/maxLex:0;
    const score=(1-fusion.vectorWeight)*lexNorm+fusion.vectorWeight*similarity;
    if(score<=0) continue;
    fused.push({...entry,score});
  }
  return fused;
}

function cosine(queryVector,candidate) {
  if(!Array.isArray(candidate)||candidate.length!==queryVector.length) return 0;
  let dot=0;
  for(let index=0;index<queryVector.length;index++) dot+=queryVector[index]*candidate[index];
  return Math.max(0,dot);
}
function clampRatio(value,fallback) { const num=Number(value);return Number.isFinite(num)&&num>=0&&num<=1?num:fallback; }

function scorePage(page,query,tokens) {
  const title=normalize(page.title); const aliases=(page.aliases||[]).map(normalize);
  const body=normalize(`${page.content||""} ${page.sqlContent||""} ${page.antiExamples||""} ${(page.tables||[]).join(" ")}`);
  let score=0;
  if(title&&query.includes(title)) score+=12;
  if(aliases.some((alias)=>alias&&query.includes(alias))) score+=9;
  for(const token of tokens){if(title.includes(token))score+=3;if(aliases.some((alias)=>alias.includes(token)))score+=2;if(body.includes(token))score+=.55;}
  return score*(TYPE_BOOST[page.pageType]||1)*(page.verified?1.2:.82);
}

function scoreStructure(table,columns,query,tokens,signals=[]){
  let score=0;
  const tableText=normalize(`${table.tableName} ${table.comment||""}`);
  const columnTexts=columns.map((column)=>normalize(`${column.columnName} ${column.comment||""}`));
  if(query.includes(normalize(table.tableName))) score+=8;
  for(const token of tokens) {
    if(tableText.includes(token)) score+=1.5;
    else if(columnTexts.some((text)=>text.includes(token))) score+=.35;
  }
  for(const signal of signals) {
    if(tableText.includes(signal)) score+=2;
    else if(columnTexts.some((text)=>text.includes(signal))) score+=.55;
    if(rootTableSignal(table.tableName,signal))score+=5;
  }
  if(NOISE_TABLE.test(table.tableName)) score-=4;
  return score;
}
function tokenize(value){const latin=value.match(/[a-z0-9_]{2,}/g)||[];const chinese=(value.match(/[\u4e00-\u9fff]+/g)||[]).flatMap((part)=>part.length<=2?[part]:Array.from({length:part.length-1},(_,index)=>part.slice(index,index+2))).filter((token)=>!QUERY_STOP_TOKENS.has(token));return [...new Set([...latin,...chinese])];}
function semanticSignals(query,conceptAliases=[]){
  const signals=[];
  if(/(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(query))signals.push("手机号","手机号码","mobile","phone","cell");
  if(/[\w.+-]{1,64}@[\w.-]{1,255}\.[a-z]{2,}/i.test(query))signals.push("邮箱","电子邮件","email","mail");
  if(/(?:^|\D)\d{17}[\dx](?:\D|$)/i.test(query))signals.push("身份证","证件号","id_card","identity");
  // Chinese business questions often use domain words while physical schemas use
  // English names. Expand only high-confidence concepts so exhaustive questions
  // such as “所有账号” can recall every product account root instead of whichever
  // single table happens to have the strongest Chinese comment match.
  if(/账号|账户/.test(query))signals.push("账号","账户","account","user");
  if(/产品/.test(query))signals.push("产品","product");
  if(/律所|律师事务所/.test(query))signals.push("律所","律师事务所","office","law_firm","firm");
  if(/线索|进线|clue|lead/.test(query))signals.push("线索","进线","clue","lead");
  if(/销售(?!额)|业务员|负责人|seller|salesperson|owner|assignee/.test(query))signals.push("销售","业务员","负责人","seller","salesperson","owner","assignee","seller_id","seller_name");
  if(/成单|成交|赢单|签单|closed|won/.test(query))signals.push("成单","成交","赢单","签单","order","is_win_order","order_time","closed_at","won_at");
  if(/排行|排名|榜单|top/.test(query))signals.push("排行","排名","rank","ranking");
  if(/本月|上月|今天|昨日|时间|日期|create_time|created_at/.test(query))signals.push("时间","日期","time","date","create_time","created_at");
  for(const alias of conceptAliases){
    const source=String(alias?.match||"");
    if(!source)continue;
    let pattern;
    try{pattern=new RegExp(source);}catch{continue;}
    if(pattern.test(query))signals.push(...(Array.isArray(alias.terms)?alias.terms:[]).map(String));
  }
  return [...new Set(signals.map(normalize).filter(Boolean))];
}
function wikiLinks(value){return [...String(value).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match)=>match[1].trim());}
function normalize(value){return String(value||"").toLowerCase().replace(/\s+/g,"");}
function escapeRegExp(value){return String(value||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function addUnique(items,value){if(value&&!items.includes(value))items.push(value);}
function promoteValue(items,value){const index=items.indexOf(value);if(index===0)return;if(index>0)items.splice(index,1);items.unshift(value);}
function promotePath(paths,path){const key=path.join("\u0000");const index=paths.findIndex((item)=>item.join("\u0000")===key);if(index===0)return;if(index>0)paths.splice(index,1);paths.unshift(path);}
function rootTableSignal(tableName,signal) { const table=normalize(tableName);const value=normalize(signal);return Boolean(value&&/^[a-z0-9_]+$/.test(value)&&(table===value||table.endsWith(`_${value}`))); }
function roundScore(value){return Math.round(Number(value||0)*10_000)/10_000;}

function expandTermAliases(question,items) {
  const query=normalize(question);
  const result=[];
  for(const item of Array.isArray(items)?items:[]) {
    const aliases=Array.isArray(item?.aliases)?item.aliases:[];
    if(!aliases.some((alias)=>{const value=normalize(alias);return value&&query.includes(value);}))continue;
    for(const term of Array.isArray(item?.terms)?item.terms:[])addUnique(result,String(term));
  }
  return result;
}

export const _internal={tokenize,semanticSignals,scorePage,scoreStructure,wikiLinks,expandTermAliases};
