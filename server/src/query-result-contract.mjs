// A query result contract sits above the SQL safety guard. The guard proves a
// statement is safe to execute; this module proves its result shape and physical
// lineage still satisfy the business capabilities extracted from the question.

export const QUERY_RESULT_CONTRACT_VERSION="result-contract-v1";

export function buildQueryResultContract(intent,retrievalEvidence=[],semanticContract=null) {
  const retrievals=(Array.isArray(retrievalEvidence)?retrievalEvidence:[retrievalEvidence]).filter(Boolean);
  const semanticBinding=normalizeSemanticContract(semanticContract);
  const declaredRequirements=[...(intent?.requirements||[])];
  for(const [index,filter] of (intent?.filters||[]).entries())if(!declaredRequirements.some((item)=>item.kind==="filter"&&item.filterId===filter.id)) {
    const entity=(intent?.entities||[]).find((item)=>item.type==="organization"&&item.text===filter.value);
    declaredRequirements.push({
      id:filter.requirementId||(filter.kind==="organization_name"&&entity?`entity:organization:${entity.text}`:`filter:${filter.kind||"unknown"}:${index}`),
      filterId:filter.id||null,kind:"filter",value:filter.value,role:filter.kind||"business_filter",surfaceText:filter.sourceText||String(filter.value??""),required:true,
      operator:filter.operator||"eq",valueType:filter.valueType||inferValueType(filter.value),fieldTerms:[...(filter.fieldTerms||[])],physicalColumns:[...(filter.physicalColumns||[])],valueBinding:filter.valueBinding||null,provenance:filter.provenance||null,
    });
  }
  for(const product of intent?.scope?.products||[])if(!declaredRequirements.some((item)=>item.kind==="product"&&String(item.value).toLowerCase()===String(product).toLowerCase()))declaredRequirements.push({id:`product:${product}`,kind:"product",value:product,role:"product_scope",surfaceText:product,required:true});
  const slots=declaredRequirements.filter((item)=>item.required!==false).map((requirement)=>{
    const facets=retrievals.flatMap((retrieval)=>retrieval?.diagnostics?.facets||[]).filter((facet)=>facet.key===requirement.id&&(!requirement.attribution||facet.attribution===requirement.attribution));
    return {
      ...requirement,
      tables:unique(facets.flatMap((facet)=>facet.executionTables||facet.selectedTables||[])),
      columns:stableFacetValues(facets,"executionColumns"),
      filterBindings:requirement.kind==="filter"?stableFacetObjects(facets,"filterBindings",filterBindingKey):[],
      labelColumns:unique(facets.flatMap((facet)=>facet.labelColumns||[])),
      identityColumns:unique(facets.flatMap((facet)=>facet.identityColumns||[])),
      bindingTables:unique(facets.flatMap((facet)=>facet.bindingTables||[])),
      bindingColumns:unique(facets.flatMap((facet)=>facet.bindingColumns||[])),
      bindingRelationIds:uniqueValues(facets.flatMap((facet)=>facet.bindingRelationIds||[])),
      bindingValidityPredicates:uniquePredicates(facets.flatMap((facet)=>facet.bindingValidityPredicates||facet.validityPredicates||[])),
      executionValidityPredicates:uniquePredicates(facets.flatMap((facet)=>facet.executionValidityPredicates||[])),
      bindingPaths:uniquePaths(facets.flatMap((facet)=>facet.paths||[])),
      authoritativeTables:unique(facets.flatMap((facet)=>facet.authoritativeTables||[])),
      evidenceLevel:facets.some((facet)=>(facet.authoritativeTables||[]).length)?"verified_knowledge":"structural",
    };
  });
  slots.push(...semanticBinding.slots);
  return {
    version:QUERY_RESULT_CONTRACT_VERSION,
    intentVersion:intent?.version||null,
    shape:intent?.shape||{kind:"detail",direction:null,requestedLimit:null},
    closedWorldRowDomain:closedWorldRowDomainEnabled(intent),
    slots,
    semanticBinding:semanticBinding.binding,
    bindingErrors:semanticBinding.errors,
    blockingAmbiguities:(intent?.ambiguities||[]).filter((item)=>item.blocking),
  };
}

export function validateQueryResultContract(contract,{sql="",verdict=null,columnsByTable={}}={}) {
  const errors=[];
  for(const bindingError of contract?.bindingErrors||[])errors.push(issue(
    "ONTOLOGY_DISCRIMINATOR_BINDING_INVALID",
    bindingError.message||"已发布本体的子类判别条件缺少可核验的 Schema 版本或根对象绑定",
    bindingError.details||{},
  ));
  if(contract?.blockingAmbiguities?.length)errors.push(issue(
    "INTENT_CLARIFICATION_REQUIRED",
    `以下业务口径会实质改变结果，执行前必须澄清：${contract.blockingAmbiguities.map((item)=>item.message).join("；")}`,
    {ambiguities:contract.blockingAmbiguities},
  ));
  const shape=describeSql(verdict?.ast,{usedTables:verdict?.tables||[],columnsByTable,sql,relationCatalog:relationCatalogFromVerdict(verdict)});
  const requestedLimit=limitSpec(verdict?.requestedAst?.limit??verdict?.ast?.limit);
  shape.requestedLimit=requestedLimit.rowCount;shape.requestedOffset=requestedLimit.offset;
  const usedTables=shape.effectiveTables.size?shape.effectiveTables:new Set((verdict?.tables||[]).map(normalize));
  const slots=contract?.slots||[];

  for(const slot of slots) {
    const expectedTables=new Set((slot.tables||[]).map(normalize));
    if(slot.kind==="product"&&!expectedTables.size)errors.push(issue(
      "INTENT_PRODUCT_BINDING_MISSING",
      `产品范围“${slot.surfaceText||slot.value}”没有唯一、可执行的物理表绑定，系统不会用名称子串猜测产品范围`,
      {requirementId:slot.id,product:slot.value},
    ));
    if(slot.kind!=="product"&&expectedTables.size&&![...expectedTables].some((table)=>usedTables.has(table)))errors.push(issue(
      requirementCode(slot.kind),
      `SQL 没有覆盖必需的${kindLabel(slot.kind)}“${slot.surfaceText||slot.value}”`,
      {requirementId:slot.id,expectedTables:[...expectedTables],usedTables:[...usedTables]},
    ));
    if(slot.kind==="filter"&&(!(slot.columns||[]).length||!(slot.filterBindings||[]).length))errors.push(issue(
      "INTENT_FILTER_BINDING_MISSING",
      `筛选“${slot.surfaceText||slot.value}”没有唯一、可执行的物理字段与值绑定，系统不会猜测筛选列或枚举代码`,
      {requirementId:slot.id,role:slot.role,operator:slot.operator,value:slot.value},
    ));
    if((slot.executionValidityPredicates||[]).length)validateExecutionValidity(slot,shape,errors);
  }

  for(const slot of slots.filter((item)=>item.kind==="time"&&item.role&&item.role!=="unknown")) {
    const expected=new Set((slot.columns||[]).map(normalizeColumnKey));
    if(!expected.size)errors.push(issue("INTENT_TIME_ROLE_BINDING_MISSING",`时间角色“${slot.role}”没有可执行的字段绑定`,{requirementId:slot.id,role:slot.role}));
    if(slot.range&&expected.size&&!hasTimeRangeBinding(shape,expected,{...slot.range,kind:slot.value}))errors.push(issue(
      "INTENT_TIME_ROLE_MISMATCH",
      `时间范围必须绑定“${slot.role}”业务时间，不能套用其他创建或更新时间`,
      {requirementId:slot.id,role:slot.role,expectedColumns:[...expected],actualRangePredicates:shape.rangePredicates},
    ));
    if(contract.shape?.kind==="trend"&&expected.size&&![...shape.groupColumns].some((column)=>expected.has(column)))errors.push(issue(
      "INTENT_TREND_TIME_DIMENSION_MISMATCH",
      `趋势必须按“${slot.role}”业务时间分组，不能用其他日期字段代替`,
      {requirementId:slot.id,role:slot.role,expectedColumns:[...expected],actualColumns:[...shape.groupColumns]},
    ));
    if(contract.shape?.kind==="trend"&&expected.size) {
      const grain=contract.shape.timeGrain;
      const grouped=shape.groupItems.filter((item)=>exactTimeBucketItem(item,grain,expected));
      if(grouped.length!==1)errors.push(issue("INTENT_TREND_GRAIN_MISMATCH",`趋势时间粒度必须为 ${grain}，且必须由一个独立分组项精确绑定`,{requirementId:slot.id,expectedGrain:grain,actualGroupItems:shape.groupItems}));
      const primary=shape.orderBy[0];
      const ordered=primary?.direction==="asc"&&exactTimeBucketItem(primary,grain,expected);
      if(!ordered)errors.push(issue("INTENT_TREND_ORDER_MISMATCH","趋势必须以输出的时间桶作为第一排序项正序输出",{requirementId:slot.id,actual:shape.orderBy}));
    }
  }

  for(const slot of slots.filter((item)=>item.kind==="dimension")) {
    const expected=new Set((slot.columns||[]).map(normalizeColumnKey));
    const directGroupedColumns=new Set((shape.groupItems||[]).filter((item)=>item.expressionKind==="direct_column").flatMap((item)=>item.columns||[]).map(normalizeColumnKey));
    const directOutputColumns=new Set([...shape.outputs.values()].filter((item)=>item?.expressionKind==="direct_column").flatMap((item)=>[...item.columns]).map(normalizeColumnKey));
    if(!expected.size)errors.push(issue("INTENT_DIMENSION_BINDING_MISSING",`维度“${slot.surfaceText||slot.value}”没有可执行的字段绑定`,{requirementId:slot.id}));
    if(expected.size&&![...directGroupedColumns].some((column)=>expected.has(column)))errors.push(issue(
      "INTENT_DIMENSION_MISMATCH",
      `SQL 没有按要求的“${slot.surfaceText||slot.value}”直接维度列分组，函数或算术变换不能替代原维度`,
      {requirementId:slot.id,expectedColumns:[...expected],actualGroupItems:shape.groupItems},
    ));
    if(slot.attribution) {
      const bindingTables=new Set((slot.bindingTables||[]).map(normalize));
      const bindingColumns=new Set((slot.bindingColumns||[]).map(normalizeColumnKey));
      if(!bindingTables.size||!bindingColumns.size)errors.push(issue("INTENT_DIMENSION_ATTRIBUTION_BINDING_MISSING",`维度“${slot.surfaceText||slot.value}”没有“${slot.attribution}”归属口径的已识别物理绑定`,{requirementId:slot.id,attribution:slot.attribution}));
      else if(![...bindingTables].some((table)=>shape.effectiveTables.has(table))||![...shape.referencedColumns].some((column)=>bindingColumns.has(column)))errors.push(issue("INTENT_DIMENSION_ATTRIBUTION_MISMATCH",`SQL 使用的“${slot.surfaceText||slot.value}”归属路径与已确认的 ${slot.attribution} 口径不一致`,{requirementId:slot.id,attribution:slot.attribution,expectedTables:[...bindingTables],expectedColumns:[...bindingColumns],actualTables:[...shape.effectiveTables],actualColumns:[...shape.referencedColumns]}));
      if(bindingTables.size&&bindingColumns.size)validateAttributionRelation(slot,shape,errors);
      if(slot.attribution==="current"&&bindingTables.size&&bindingColumns.size)validateCurrentAttributionValidity(slot,shape,errors);
    }
    if(contract.shape?.kind==="ranking"&&slot.presentation==="label_and_id") {
      const labels=new Set((slot.labelColumns||[]).map(normalizeColumnKey));
      const stableLabelOutputColumns=new Set([...shape.outputs.values()].flatMap((item)=>{
        if(item?.expressionKind==="direct_column")return [...item.columns];
        const aggregate=item?.expressionKind==="aggregate"&&item.aggregates?.length===1?item.aggregates[0]:null;
        return aggregate&&new Set(["min","max"]).has(aggregate.name)&&aggregate.argumentKind==="direct_column"&&aggregate.columns.length===1?aggregate.columns:[];
      }).map(normalizeColumnKey));
      if(!labels.size)errors.push(issue("INTENT_DIMENSION_LABEL_BINDING_MISSING",`排行维度“${slot.surfaceText||slot.value}”没有登记可读名称字段`,{requirementId:slot.id}));
      else if(![...stableLabelOutputColumns].some((column)=>labels.has(column)))errors.push(issue(
        "INTENT_DIMENSION_LABEL_MISSING",
        `排行结果必须直接返回“${slot.surfaceText||slot.value}”的可读名称，不能只返回内部 ID 或变换后的名称`,
        {requirementId:slot.id,expectedLabelColumns:[...labels],actualGroupItems:shape.groupItems,actualOutputs:shape.outputOrder},
      ));
      if(slot.attribution) {
        const explicitIdentities=(slot.identityColumns||[]).map(normalizeColumnKey);
        const inferredIdentities=(slot.columns||[]).map(normalizeColumnKey).filter((column)=>!labels.has(column)&&/(?:^|_)(?:id|no)$|编号|标识/.test(column.split(".").at(-1)));
        const identities=new Set(explicitIdentities.length?explicitIdentities:inferredIdentities);
        if(!identities.size)errors.push(issue("INTENT_DIMENSION_IDENTITY_BINDING_MISSING",`排行维度“${slot.surfaceText||slot.value}”没有登记稳定身份字段，无法避免同名对象被合并`,{requirementId:slot.id}));
        else if(![...directOutputColumns].some((column)=>identities.has(column))||![...directGroupedColumns].some((column)=>identities.has(column)))errors.push(issue(
          "INTENT_DIMENSION_IDENTITY_MISSING",
          `排行结果必须直接返回并分组“${slot.surfaceText||slot.value}”的稳定身份字段，不能仅按名称合并`,
          {requirementId:slot.id,expectedIdentityColumns:[...identities],actualGroupItems:shape.groupItems,actualOutputs:shape.outputOrder},
        ));
      }
    }
  }

  const measureAliases=new Set();
  for(const slot of slots.filter((item)=>item.kind==="measure"))for(const alias of validateMeasure(slot,slots,shape,columnsByTable,errors))if(alias)measureAliases.add(normalize(alias));
  validateRequestedShape(contract.shape||{},shape,errors,measureAliases,slots);
  if(contract?.closedWorldRowDomain)validateClosedWorldRowDomain(contract,shape,slots,errors);
  const coverage=validateRunCoverage(slots,usedTables);
  const productSlots=slots.filter((slot)=>slot.kind==="product");
  if(productSlots.length&&coverage.productScopeIds.length!==1)errors.push(issue(
    "INTENT_PRODUCT_SCOPE_MISMATCH",
    "每个结果查询必须唯一绑定一个用户明确要求的产品范围；遗漏产品或把多个产品表混入同一结果均不可执行",
    {requiredProductScopeIds:productSlots.map((slot)=>slot.id),coveredProductScopeIds:coverage.productScopeIds,usedTables:[...usedTables]},
  ));
  return {ok:errors.length===0,version:contract?.version||QUERY_RESULT_CONTRACT_VERSION,errors,shape:publicShape(shape),bindings:slots.map(publicSlot),coverage};
}

function closedWorldRowDomainEnabled() {
  return true;
}

export function validateQueryRunSet(contract,runs) {
  const invalid=(runs||[]).filter((run)=>!run.contractValidation?.ok);
  if(invalid.length)return {ok:false,errors:invalid.flatMap((run)=>run.contractValidation?.errors||[issue("INTENT_RESULT_CONTRACT_MISMATCH",`结果集 ${run.name||"查询"} 未通过查询结果契约`)])};
  const requiredProducts=(contract?.slots||[]).filter((slot)=>slot.kind==="product").map((slot)=>slot.id);
  const coveredProducts=new Set((runs||[]).flatMap((run)=>run.contractValidation?.coverage?.productScopeIds||[]));
  const missingProducts=requiredProducts.filter((id)=>!coveredProducts.has(id));
  if(missingProducts.length)return {ok:false,errors:[issue(
    "INTENT_PRODUCT_SCOPE_INCOMPLETE",
    `结果集合遗漏用户明确要求的产品范围：${missingProducts.map((id)=>id.replace(/^product:/,"" )).join("、")}`,
    {requiredProductScopeIds:requiredProducts,coveredProductScopeIds:[...coveredProducts],missingProductScopeIds:missingProducts},
  )]};
  return {ok:true,errors:[]};
}

function validateRunCoverage(slots,usedTables) {
  const products=slots.filter((slot)=>slot.kind==="product");
  const ownership=new Map();
  for(const slot of products)for(const table of slot.tables||[]) {
    const key=normalizeTableName(table);const owners=ownership.get(key)||new Set();owners.add(slot.id);ownership.set(key,owners);
  }
  const productScopeIds=[];
  for(const slot of products)if((slot.tables||[]).some((table)=>usedTables.has(normalizeTableName(table))&&ownership.get(normalizeTableName(table))?.size===1))productScopeIds.push(slot.id);
  // A mixed-table aggregate cannot prove per-product completeness or preserve
  // each product's independent grain. Multi-product answers use one validated
  // result run per product, then the server verifies complete run-set coverage.
  return {productScopeIds:productScopeIds.length===1?productScopeIds:[]};
}

function validateMeasure(slot,slots,shape,columnsByTable,errors) {
  const expected=slot.aggregation;
  if(expected==="precomputed") {
    const columns=new Set((slot.metricDefinition?.columns||slot.columns||[]).map(normalizeColumnKey));
    if(!columns.size)errors.push(issue("INTENT_MEASURE_DEFINITION_INCOMPLETE",`预计算指标“${slot.surfaceText||slot.value}”没有绑定结果字段`,{requirementId:slot.id}));
    else if(![...shape.selectedColumns].some((column)=>columns.has(column)))errors.push(issue("INTENT_MEASURE_COLUMN_MISMATCH",`SQL 没有选择预计算指标“${slot.surfaceText||slot.value}”的已验证结果字段`,{requirementId:slot.id,expectedColumns:[...columns],actualColumns:[...shape.selectedColumns]}));
    return [];
  }
  if(expected==="ratio") {
    if(slot.evidenceLevel!=="verified_knowledge"&&slot.evidence?.level!=="verified_knowledge")errors.push(issue("INTENT_MEASURE_DEFINITION_REQUIRED",`指标“${slot.surfaceText||slot.value}”需要已验证的分子、分母和去重口径，不能由 COUNT(*) 猜测`,{requirementId:slot.id}));
    else if(!shape.ratioExpressions)errors.push(issue("INTENT_MEASURE_MISMATCH",`已验证比例指标“${slot.surfaceText||slot.value}”必须使用聚合分子与分母计算`,{requirementId:slot.id}));
    else {
      const definitionColumns=new Set((slot.metricDefinition?.columns||[]).map(normalizeColumnKey));
      const formula=slot.metricDefinition?.formula;
      if(!definitionColumns.size||!formula)errors.push(issue("INTENT_MEASURE_DEFINITION_INCOMPLETE",`已验证比例指标“${slot.surfaceText||slot.value}”没有绑定可核验的分子、分母公式`,{requirementId:slot.id,source:slot.metricDefinition?.source||slot.evidence?.page||null}));
      else if(!ratioPredicateDefinitionUsable(formula))errors.push(issue(
        "INTENT_MEASURE_PREDICATE_BINDING_MISSING",
        `已验证比例指标“${slot.surfaceText||slot.value}”的条件谓词无法唯一绑定到物理字段`,
        {requirementId:slot.id,expectedFormula:formula,source:slot.metricDefinition?.source||slot.evidence?.page||null},
      ));
      else if(!shape.ratioSignatures.some((item)=>ratioFormulaMatches(formula,item)))errors.push(issue(
        "INTENT_MEASURE_FORMULA_MISMATCH",
        `比例指标“${slot.surfaceText||slot.value}”的分子、分母、聚合方式或去重条件与已验证定义不一致`,
        {requirementId:slot.id,expectedFormula:formula,actualFormulas:shape.ratioSignatures},
      ));
    }
    return shape.aggregates.map((item)=>item.alias).filter(Boolean);
  }
  if(!expected||expected==="unknown") {
    errors.push(issue("INTENT_MEASURE_DEFINITION_REQUIRED",`指标“${slot.surfaceText||slot.value}”没有可执行的已验证聚合定义`,{requirementId:slot.id}));
    return [];
  }
  const aggregates=shape.aggregates.filter((item)=>aggregationMatches(expected,item));
  if(!aggregates.length) {
    errors.push(issue("INTENT_MEASURE_MISMATCH",`SQL 聚合方式与指标“${slot.surfaceText||slot.value}”不一致`,{requirementId:slot.id,expectedAggregation:expected,actualAggregations:shape.aggregates.map((item)=>item.name)}));
    return [];
  }
  const outputAggregates=aggregates.filter((item)=>{
    const descriptor=shape.outputs?.get(normalize(item.alias));
    return descriptor?.expressionKind==="aggregate"&&descriptor.aggregates?.length===1;
  });
  if(!outputAggregates.length)errors.push(issue(
    "INTENT_MEASURE_EXPRESSION_MISMATCH",
    `指标“${slot.surfaceText||slot.value}”必须作为独立聚合结果输出，不能再套用函数、符号或算术表达式`,
    {requirementId:slot.id,actualOutputs:shape.outputOrder.map((name)=>({name,expressionKind:shape.outputs?.get(name)?.expressionKind||null}))},
  ));
  if(expected==="count_distinct") {
    const grainColumns=measureGrainColumns(slot,slots,columnsByTable);
    const exactAggregates=outputAggregates.filter((item)=>item.argumentKind==="direct_column"||item.argumentKind==="conditional");
    if(!exactAggregates.length)errors.push(issue(
      "INTENT_MEASURE_EXPRESSION_MISMATCH",
      `指标“${slot.surfaceText||slot.value}”的去重参数必须是直接业务身份列，不能套用函数、算术或其他变换`,
      {requirementId:slot.id,actualAggregates:aggregates.map(publicAggregate)},
    ));
    if(grainColumns.size&&!exactAggregates.some((item)=>item.distinct&&(item.argumentKind==="direct_column"?item.columns.length===1&&grainColumns.has(item.columns[0]):item.columns.some((column)=>grainColumns.has(column)))))errors.push(issue(
      "INTENT_MEASURE_GRAIN_MISMATCH",
      `指标“${slot.surfaceText||slot.value}”必须按 ${slot.grain} 粒度去重，COUNT(*) 或其他粒度会造成重复计数`,
      {requirementId:slot.id,grain:slot.grain,expectedColumns:[...grainColumns],actualAggregates:exactAggregates.map(publicAggregate)},
    ));
  }
  if(new Set(["sum","avg"]).has(expected)) {
    const metricColumns=new Set((slot.columns||[]).map(normalizeColumnKey));
    const exactAggregates=outputAggregates.filter((item)=>item.argumentKind==="direct_column");
    if(!exactAggregates.length)errors.push(issue(
      "INTENT_MEASURE_EXPRESSION_MISMATCH",
      `指标“${slot.surfaceText||slot.value}”必须直接聚合已登记度量列，不能套用函数、算术或其他变换`,
      {requirementId:slot.id,actualAggregates:aggregates.map(publicAggregate)},
    ));
    if(metricColumns.size&&!exactAggregates.some((item)=>item.columns.length===1&&metricColumns.has(item.columns[0])))errors.push(issue(
      "INTENT_MEASURE_COLUMN_MISMATCH",
      `指标“${slot.surfaceText||slot.value}”使用了错误的度量字段`,
      {requirementId:slot.id,expectedColumns:[...metricColumns],actualAggregates:exactAggregates.map(publicAggregate)},
    ));
  }
  return outputAggregates.map((item)=>item.alias).filter(Boolean);
}

function validateAttributionRelation(slot,shape,errors) {
  const expectedRelationIds=(slot.bindingRelationIds||[]).map(relationIdentifier).filter((item)=>item!=null);
  const actualRelationIds=new Set((shape.activeJoinEdges||[]).map((item)=>relationIdentifier(item.relationId)).filter((item)=>item!=null));
  if(expectedRelationIds.length) {
    const missing=expectedRelationIds.filter((id)=>!actualRelationIds.has(id));
    if(missing.length)errors.push(issue(
      "INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH",
      `SQL 的活跃结果链路没有使用“${slot.attribution}”归属本体绑定的完整已确认关系路径`,
      {requirementId:slot.id,expectedRelationIds,activeRelationIds:[...actualRelationIds],missingRelationIds:missing},
    ));
    else validateAliasAwareAttributionPath(slot,shape,expectedRelationIds,errors);
  } else if(!hasStructuralAttributionPath(slot,shape.activeJoinEdges||[]))errors.push(issue(
    "INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH",
    `SQL 没有使用“${slot.attribution}”归属已识别的物理关联路径`,
    {requirementId:slot.id,expectedPaths:slot.bindingPaths||[],activeJoinEdges:publicJoinEdges(shape.activeJoinEdges||[]),compatibilityFallback:true},
  ));

}

function validateAliasAwareAttributionPath(slot,shape,expectedRelationIds,errors) {
  const paths=(slot.bindingPaths||[]).map((path)=>path.map(normalizeTableName)).filter((path)=>path.length>1);
  if(!paths.length) {
    errors.push(issue(
      "INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH",
      `SQL 无法证明“${slot.surfaceText||slot.value}”别名沿 ${slot.attribution} 归属路径连接到业务主体`,
      {requirementId:slot.id,reason:"binding_path_missing",expectedRelationIds},
    ));
    return;
  }
  const expectedIds=new Set(expectedRelationIds.map(String));
  const expectedColumns=new Set((slot.columns||[]).map(normalizeColumnKey));
  const groupedOrigins=new Set((shape.groupItems||[]).filter((item)=>(item.columns||[]).some((column)=>expectedColumns.has(column))).flatMap((item)=>item.origins||[]));
  const activeInstances=shape.activeInstances||new Map();
  const evidence=[];
  let valid=false;
  for(const path of paths) {
    const instances=path.map((table)=>[...activeInstances.entries()].filter(([,value])=>value.table===table).map(([id])=>id));
    const ambiguous=instances.map((items,index)=>({table:path[index],instances:items})).filter((item)=>item.instances.length!==1);
    if(ambiguous.length) {evidence.push({path,reason:"ambiguous_instances",instances:ambiguous});continue;}
    const instancePath=instances.map((items)=>items[0]);
    if(groupedOrigins.size!==1||!groupedOrigins.has(instancePath[0])) {evidence.push({path,reason:"dimension_output_not_bound_to_path",groupedOrigins:[...groupedOrigins],expectedDimensionInstance:instancePath[0]});continue;}
    const missingEdges=[];
    for(let index=0;index<instancePath.length-1;index++) {
      const left=instancePath[index];const right=instancePath[index+1];
      const matchingEdges=(shape.activeJoinEdges||[]).filter((item)=>expectedIds.has(String(item.relationId))&&new Set([item.left.instance,item.right.instance]).has(left)&&new Set([item.left.instance,item.right.instance]).has(right));
      const edge=matchingEdges.find((item)=>item.joinType==="inner");
      if(!edge)missingEdges.push({from:path[index],to:path[index+1],fromInstance:left,toInstance:right,actualJoinTypes:unique(matchingEdges.map((item)=>item.joinType))});
    }
    if(missingEdges.length) {evidence.push({path,reason:"missing_alias_edge",missingEdges});continue;}
    const protectedInstances=new Set(instancePath.slice(0,-1));
    const competingEdges=(shape.activeJoinEdges||[]).filter((item)=>
      (protectedInstances.has(item.left.instance)||protectedInstances.has(item.right.instance))
      &&!expectedIds.has(String(item.relationId)),
    );
    if(competingEdges.length) {evidence.push({path,reason:"competing_path_edge",competingEdges:publicJoinEdges(competingEdges)});continue;}
    valid=true;break;
  }
  if(!valid)errors.push(issue(
    "INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH",
    `SQL 输出的“${slot.surfaceText||slot.value}”别名没有沿唯一的 ${slot.attribution} 归属路径连接到业务主体`,
    {requirementId:slot.id,expectedPaths:paths,activeInstances:publicInstances(activeInstances),activeJoinEdges:publicJoinEdges(shape.activeJoinEdges||[]),pathEvidence:evidence},
  ));
}

function validateCurrentAttributionValidity(slot,shape,errors) {
  const expected=expectedValidityPredicates(slot,shape);
  if(!expected.length) {
    errors.push(issue("INTENT_DIMENSION_ATTRIBUTION_VALIDITY_BINDING_MISSING",`当前归属绑定没有可核验的有效性谓词`,{requirementId:slot.id,bindingColumns:slot.bindingColumns||[]}));
    return;
  }
  const {missing,ambiguousTables}=missingAliasBoundPredicates(expected,shape);
  if(missing.length)errors.push(issue(
    "INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH",
    `当前归属 SQL 缺少或篡改了关系表的有效性谓词`,
    {requirementId:slot.id,expectedPredicates:expected,actualPredicates:shape.filterPredicates||[],missingPredicates:missing,ambiguousTables},
  ));
}

function validateExecutionValidity(slot,shape,errors) {
  const declared=slot.executionValidityPredicates||[];
  const valid=declared.filter((item)=>validityPredicateKey(item));
  if(valid.length!==declared.length) {
    errors.push(issue("INTENT_EXECUTION_VALIDITY_BINDING_MISSING",`“${slot.surfaceText||slot.value}”的执行有效性谓词无法核验`,{requirementId:slot.id,expectedPredicates:slot.executionValidityPredicates||[]}));
    return;
  }
  // An exhaustive/multi-product requirement may publish one active-row
  // predicate per execution table while each independent run intentionally
  // covers only one product. Enforce the predicates for this run's physical
  // tables; run-set subject completeness remains a separate contract.
  const expected=valid.filter((item)=>shape.effectiveTables.has(predicateTable(item)));
  if(!expected.length)return;
  const {missing,ambiguousTables}=missingAliasBoundPredicates(expected,shape);
  if(missing.length)errors.push(issue(
    "INTENT_EXECUTION_VALIDITY_MISMATCH",
    `SQL 缺少或篡改了“${slot.surfaceText||slot.value}”的已登记执行有效性谓词`,
    {requirementId:slot.id,expectedPredicates:expected,actualPredicates:shape.filterPredicates||[],missingPredicates:missing,ambiguousTables},
  ));
}

function predicateTable(value) {
  const physicalColumn=value?.table&&value?.column&&!String(value.column).includes(".")?`${value.table}.${value.column}`:value?.column;
  return normalizeColumnKey(physicalColumn).split(".")[0];
}

function missingAliasBoundPredicates(expected,shape) {
  const activeInstances=shape.activeInstances||new Map();const actual=shape.filterPredicates||[];const ambiguousTables=[];const missing=[];
  for(const predicate of expected) {
    const table=predicateTable(predicate);
    const instances=[...activeInstances.entries()].filter(([,item])=>item.table===table).map(([id])=>id);
    if(instances.length!==1) {ambiguousTables.push({table,instances});missing.push(predicate);continue;}
    const instance=instances[0];
    if(!actual.some((item)=>validityPredicateKey(item)===validityPredicateKey(predicate)&&(item.origins||[]).length===1&&item.origins[0]===instance))missing.push(predicate);
  }
  return {missing,ambiguousTables};
}

function expectedValidityPredicates(slot,shape) {
  const explicit=(slot.bindingValidityPredicates||[]).filter((item)=>validityPredicateKey(item));
  if(explicit.length)return explicit;
  // Compatibility for legacy retrieval facets. Published ontology facets carry
  // explicit predicates; older fixtures can only bind conventional current-row
  // flags through their physical binding columns.
  const groupedTables=new Set([...(shape?.groupColumns||[])].map((column)=>normalizeColumnKey(column).split(".")[0]));
  const bindingTables=new Set((slot.bindingTables||[]).map(normalize));
  const activeTables=new Set([...groupedTables].filter((table)=>bindingTables.has(table)));
  const candidates=(slot.bindingColumns||[]).filter((column)=>!activeTables.size||activeTables.has(normalizeColumnKey(column).split(".")[0]));
  return candidates.flatMap((column)=>{
    const key=normalizeColumnKey(column);const name=key.split(".").at(-1);
    if(name==="is_deleted")return [{column:key,operator:"=",valueType:"number",value:"0"}];
    if(name==="is_current"||name==="is_active"||name==="is_valid")return [{column:key,operator:"=",valueType:"number",value:"1"}];
    return [];
  });
}

function validateClosedWorldRowDomain(contract,shape,slots,errors) {
  const allowedPairs=new Set(slots.flatMap((slot)=>(slot.bindingPaths||[]).flatMap((path)=>path.slice(1).map((table,index)=>relationTablePair(path[index],table)))));
  const allowedGroupColumns=new Set(slots.filter((slot)=>slot.kind==="dimension"||slot.kind==="time"&&contract?.shape?.kind==="trend").flatMap((slot)=>slot.columns||[]).map(normalizeColumnKey));
  const validityKeys=new Set(slots.flatMap((slot)=>[
    ...(slot.executionValidityPredicates||[]).filter((item)=>shape.effectiveTables.has(predicateTable(item))),
    ...expectedValidityPredicates(slot,shape),
  ]).map(validityPredicateKey).filter(Boolean));
  const authorizedTimeAtoms=authorizedRowTimeAtoms(shape.rowDomainAtoms||[],slots);
  const unauthorized=[];
  const filterSlots=slots.filter((slot)=>slot.kind==="filter");
  const semanticRowDomainSlots=slots.filter((slot)=>slot.kind==="semantic_row_domain");
  const filterMatches=new Map(filterSlots.map((slot)=>[slot.id,(shape.rowDomainAtoms||[]).filter((atom)=>matchesDeclaredFilter(atom,slot,shape))]));
  for(const slot of filterSlots)if((filterMatches.get(slot.id)||[]).length!==1)errors.push(issue(
    "INTENT_FILTER_MISMATCH",
    `SQL 必须且只能有一个与“${slot.surfaceText||slot.value}”完全一致的筛选原子，不能遗漏、重复或绑定到其他字段`,
    {requirementId:slot.id,expectedColumns:slot.columns||[],operator:slot.operator,value:slot.value,actualPredicates:(shape.rowDomainAtoms||[]).filter((atom)=>atom.kind==="predicate")},
  ));
  const semanticMatches=new Map(semanticRowDomainSlots.map((slot)=>[slot.id,(shape.rowDomainAtoms||[]).filter((atom)=>matchesSemanticRowDomain(atom,slot,shape))]));
  for(const slot of semanticRowDomainSlots)if((semanticMatches.get(slot.id)||[]).length!==1)errors.push(issue(
    "ONTOLOGY_DISCRIMINATOR_MISMATCH",
    `SQL 必须且只能有一个与已发布子类 ${slot.owner||slot.object||slot.rootObject} 完全一致的判别原子`,
    {requirementId:slot.id,ontologySchemaVersion:slot.ontologySchemaVersion,rootObject:slot.rootObject,expectedColumns:slot.columns||[],expectedValues:slot.values||[],actualPredicates:(shape.rowDomainAtoms||[]).filter((atom)=>atom.kind==="predicate")},
  ));
  for(const item of shape.groupItems||[]) {
    const declaredColumns=(item.columns||[]).length>0&&(item.columns||[]).every((column)=>allowedGroupColumns.has(normalizeColumnKey(column)));
    const exactExpression=item.expressionKind==="direct_column"||item.expressionKind==="time_bucket"&&contract?.shape?.kind==="trend";
    if(!declaredColumns||!exactExpression)unauthorized.push({kind:"group_item",item,reason:declaredColumns?"grouping_expression_not_exact":"grouping_not_declared"});
  }
  for(const atom of shape.rowDomainAtoms||[]) {
    if(atom.source==="having") {unauthorized.push({...atom,reason:"having_not_declared"});continue;}
    if(atom.kind==="unsupported") {unauthorized.push({...atom,reason:atom.reason||"unprovable_predicate"});continue;}
    if(atom.kind==="relation") {
      const pair=relationTablePair(atom.left?.table,atom.right?.table);
      if(atom.source!=="join_on"||!relationIdentifier(atom.relationId)||!allowedPairs.has(pair))unauthorized.push({...atom,reason:"relation_not_declared_by_binding_path"});
      continue;
    }
    if(atom.kind==="predicate") {
      const key=validityPredicateKey(atom);
      const declaredFilter=filterSlots.some((slot)=>matchesDeclaredFilter(atom,slot,shape));
      const declaredSemanticRowDomain=semanticRowDomainSlots.some((slot)=>matchesSemanticRowDomain(atom,slot,shape));
      const direct=atom.expressionKind==="direct_column";
      if(!direct||!validityKeys.has(key)&&!authorizedTimeAtoms.has(atom)&&!declaredFilter&&!declaredSemanticRowDomain)unauthorized.push({...atom,reason:direct?"predicate_not_declared_or_time_range_incomplete":"predicate_column_must_be_direct"});
      continue;
    }
    unauthorized.push({...atom,reason:"unknown_row_domain_atom"});
  }

  const formulaPredicateKeys=new Set(slots.filter((slot)=>slot.kind==="measure"&&(slot.evidenceLevel==="verified_knowledge"||slot.evidence?.level==="verified_knowledge"))
    .flatMap((slot)=>[slot.metricDefinition?.formula?.numerator,slot.metricDefinition?.formula?.denominator])
    .filter((side)=>side?.predicateBinding==="physical")
    .flatMap((side)=>side.predicates||[])
    .map(validityPredicateKey).filter(Boolean));
  for(const aggregate of shape.aggregates||[]) {
    if(!aggregate.conditional)continue;
    if(aggregate.predicateBinding!=="physical"||!(aggregate.predicates||[]).length) {
      unauthorized.push({kind:"conditional_aggregate",alias:aggregate.alias,predicateBinding:aggregate.predicateBinding,reason:"conditional_metric_not_provable"});
      continue;
    }
    const unapproved=(aggregate.predicates||[]).filter((predicate)=>!formulaPredicateKeys.has(validityPredicateKey(predicate))&&!matchesDeclaredTimeBoundary(predicate,slots));
    if(unapproved.length)unauthorized.push({kind:"conditional_aggregate",alias:aggregate.alias,predicates:unapproved,reason:"conditional_metric_predicate_not_declared"});
  }

  if(unauthorized.length)errors.push(issue(
    "INTENT_ROW_DOMAIN_UNAUTHORIZED",
    "SQL 包含问题、已确认关系或有效性口径之外的额外筛选，无法证明结果行域与问数意图一致",
    {shape:contract?.shape?.kind,unauthorizedAtoms:unauthorized},
  ));
}

function matchesSemanticRowDomain(atom,slot,shape) {
  if(atom?.kind!=="predicate"||atom.source!=="where"||atom.expressionKind!=="direct_column")return false;
  const expectedColumn=normalizeColumnKey((slot.columns||[])[0]||slot.column);
  const column=normalizeColumnKey(atom.column);
  if(!expectedColumn||column!==expectedColumn)return false;
  const table=column.split(".")[0];
  const instances=[...(shape.activeInstances||new Map()).entries()].filter(([,item])=>item.table===table).map(([id])=>id);
  if(instances.length!==1||(atom.origins||[]).length!==1||atom.origins[0]!==instances[0])return false;
  const expected=(slot.values||[]).map(semanticLiteralKey).sort();
  if(!expected.length)return false;
  const operator=normalizeComparisonOperator(atom.operator);
  const actual=operator==="="?[semanticLiteralKey({value:atom.value,valueType:atom.valueType})]:operator==="in"?(atom.values||[]).map(semanticLiteralKey).sort():[];
  if(operator==="="&&expected.length!==1||operator==="in"&&actual.length!==expected.length||!new Set(["=","in"]).has(operator))return false;
  return actual.length===expected.length&&actual.every((value,index)=>value===expected[index]);
}

function matchesDeclaredFilter(atom,slot,shape) {
  if(atom?.kind!=="predicate"||atom.source!=="where"||atom.expressionKind!=="direct_column")return false;
  const columns=new Set((slot.columns||[]).map(normalizeColumnKey));
  const column=normalizeColumnKey(atom.column);
  if(!columns.has(column))return false;
  const table=column.split(".")[0];
  const instances=[...(shape.activeInstances||new Map()).entries()].filter(([,item])=>item.table===table).map(([id])=>id);
  if(instances.length!==1||(atom.origins||[]).length!==1||atom.origins[0]!==instances[0])return false;
  const binding=(slot.filterBindings||[]).find((item)=>normalizeColumnKey(item.column)===column);
  if((slot.filterBindings||[]).length&&!binding)return false;
  const expectedOperator=normalizeFilterOperator(binding?.operator||slot.operator);
  const actualOperator=normalizeComparisonOperator(atom.operator);
  const expectedRaw=binding?binding.value:slot.value;
  const expectedValue=String(expectedRaw??"");const actualValue=String(atom.value??"");
  if(expectedOperator==="contains")return actualOperator==="like"&&atom.valueType==="string"&&actualValue===`%${expectedValue}%`;
  if(actualOperator!==expectedOperator)return false;
  const expectedType=String(binding?.valueType||slot.valueType||inferValueType(expectedRaw)).toLowerCase();
  if(expectedType==="null")return String(atom.valueType||"").toLowerCase()==="null"&&actualValue==="null";
  const actualType=String(atom.valueType||"").toLowerCase();
  if(actualType!==expectedType)return false;
  if(expectedType==="number")return canonicalNumericLiteral(actualValue)!=null&&canonicalNumericLiteral(actualValue)===canonicalNumericLiteral(expectedValue);
  return actualValue===expectedValue;
}

function normalizeFilterOperator(value) {
  return ({eq:"=",neq:"!=",gt:">",gte:">=",lt:"<",lte:"<=",contains:"contains",is_null:"is",not_null:"is not"})[String(value||"").toLowerCase()]||normalizeComparisonOperator(value);
}

function authorizedRowTimeAtoms(atoms,slots) {
  const result=new Set();const candidates=(atoms||[]).filter((atom)=>atom.kind==="predicate"&&matchesDeclaredTimeBoundary(atom,slots));const groups=new Map();
  for(const atom of candidates) {
    const key=`${atom.scopeId||"unknown"}|${atom.source}|${normalizeColumnKey(atom.column)}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(atom);
  }
  for(const group of groups.values()) {
    if(group[0]?.source!=="where")continue;
    const column=normalizeColumnKey(group[0]?.column);
    const periods=slots.filter((slot)=>slot.kind==="time"&&slot.range&&(slot.columns||[]).map(normalizeColumnKey).includes(column));
    const envelopes=[];
    if(periods.length>1) {
      const starts=periods.map((slot)=>String(slot.range.start||"")).filter(Boolean).sort();
      const ends=periods.map((slot)=>String(slot.range.endExclusive||"")).filter(Boolean).sort();
      if(starts.length===periods.length&&ends.length===periods.length)envelopes.push({range:{start:starts[0],endExclusive:ends.at(-1)},value:null});
    }
    if([...periods.map((slot)=>({range:slot.range,value:slot.value})),...envelopes].some((period)=>exactTimePredicatePair(group,period)))for(const atom of group)result.add(atom);
  }
  return result;
}

function exactTimePredicatePair(predicates,period) {
  if(predicates.length!==2)return false;
  const lower=predicates.find((item)=>normalizeComparisonOperator(item.operator)===">=");
  const upper=predicates.find((item)=>normalizeComparisonOperator(item.operator)==="<");
  if(!lower||!upper)return false;
  const lowerMatch=sameBoundary(lower.value,period.range.start);
  const upperMatch=sameBoundary(upper.value,period.range.endExclusive);
  return Boolean(lowerMatch&&upperMatch);
}

function matchesDeclaredTimeBoundary(predicate,slots) {
  if(predicate?.expressionKind!=="direct_column")return false;
  const column=normalizeColumnKey(predicate?.column);
  const operator=normalizeComparisonOperator(predicate?.operator);
  for(const slot of slots.filter((item)=>item.kind==="time"&&item.range)) {
    if(!(slot.columns||[]).map(normalizeColumnKey).includes(column))continue;
    if(operator===">="&&sameBoundary(predicate.value,slot.range.start))return true;
    if(operator==="<"&&sameBoundary(predicate.value,slot.range.endExclusive))return true;
  }
  return false;
}

function relationTablePair(left,right) {return [normalizeTableName(left),normalizeTableName(right)].sort().join("\u0000");}

function validityPredicateKey(value) {
  if(!value||typeof value!=="object")return null;
  const column=value.table&&value.column&&!String(value.column).includes(".")?`${value.table}.${value.column}`:value.column;
  if(!column||!value.operator||value.value===undefined)return null;
  const valueType=String(value.valueType||inferValueType(value.value)).toLowerCase();
  return `${normalizeColumnKey(column)}|${normalizeComparisonOperator(value.operator)}|${valueType}|${normalizedTypedValue(value.value,valueType)}`;
}

function inferValueType(value) {
  if(value===null)return "null";
  if(typeof value==="number")return "number";
  if(typeof value==="boolean")return "boolean";
  return "string";
}

function relationIdentifier(value) {
  const raw=value&&typeof value==="object"?(value.id??value.relationId):value;
  const number=Number(raw);return Number.isInteger(number)&&number>0?String(number):null;
}

function hasStructuralAttributionPath(slot,joins) {
  const edges=(joins||[]).filter((item)=>item.joinType==="inner").map((item)=>[item.left?.table,item.right?.table].filter(Boolean)).filter((item)=>item.length===2);
  const edgeKeys=new Set(edges.map((item)=>item.sort().join("\u0000")));
  const bindingTables=new Set((slot.bindingTables||[]).map(normalize));
  const paths=(slot.bindingPaths||[]).map((path)=>path.map(normalize)).filter((path)=>path.length>1&&path.some((table)=>bindingTables.has(table)));
  if(paths.length)return paths.some((path)=>path.slice(1).every((table,index)=>edgeKeys.has([path[index],table].sort().join("\u0000"))));
  return edges.some(([left,right])=>bindingTables.has(left)!==bindingTables.has(right));
}

function validateRequestedShape(requested,shape,errors,measureAliases=new Set(),slots=[]) {
  if(requested.kind==="ranking") {
    if(!shape.orderBy.length)errors.push(issue("INTENT_RANKING_ORDER_MISSING","排行结果缺少 ORDER BY"));
    else {
      const expectedDirection=String(requested.direction||"desc").toLowerCase();
      const primary=shape.orderBy[0];
      const selectedMeasureAggregates=shape.aggregates.filter((item)=>item.alias&&measureAliases.has(normalize(item.alias)));
      const aliasMatch=primary.aggregateAliases.some((alias)=>measureAliases.has(normalize(alias)));
      const expressionMatch=(primary.aggregates||[]).length===1&&selectedMeasureAggregates.some((item)=>aggregateExpressionEquivalent(primary.aggregates[0],item));
      const exactOrderExpression=new Set(["output_alias","ordinal","aggregate"]).has(primary.expressionKind);
      const compatible=primary.direction===expectedDirection&&exactOrderExpression&&(aliasMatch||expressionMatch);
      if(!compatible)errors.push(issue("INTENT_RANKING_ORDER_MISMATCH","排行必须把已验证的输出指标作为第一排序项，并采用正确方向",{expectedDirection,actual:shape.orderBy}));
    }
    if(requested.requestedLimit!=null&&(shape.requestedLimit!==Number(requested.requestedLimit)||shape.requestedOffset!==0))errors.push(issue("INTENT_RANKING_LIMIT_MISMATCH",`用户要求 Top ${requested.requestedLimit}，模型原始 SQL 必须使用相同 LIMIT 且不得设置 OFFSET`,{expectedLimit:Number(requested.requestedLimit),expectedOffset:0,requestedLimit:shape.requestedLimit,requestedOffset:shape.requestedOffset,executedLimit:shape.limit,executedOffset:shape.offset}));
  }
  if(requested.kind==="trend") {
    if(!shape.groupColumns.size)errors.push(issue("INTENT_TREND_TIME_DIMENSION_MISSING","趋势查询必须包含时间维度分组"));
    if(!shape.orderBy.length)errors.push(issue("INTENT_TREND_ORDER_MISSING","趋势查询必须按时间正序输出"));
    const dimensionColumns=new Set(slots.filter((item)=>item.kind==="dimension").flatMap((item)=>item.columns||[]).map(normalizeColumnKey));
    const timeColumns=new Set(slots.filter((item)=>item.kind==="time").flatMap((item)=>item.columns||[]).map(normalizeColumnKey));
    const unauthorized=shape.groupItems.filter((item)=>!item.buckets.length&&!item.columns.every((column)=>dimensionColumns.has(column))||item.buckets.length&&!item.columns.every((column)=>timeColumns.has(column)));
    if(unauthorized.length)errors.push(issue("INTENT_TREND_GROUP_ITEM_MISMATCH","趋势分组包含未请求的或混合的分组项",{actualGroupItems:unauthorized,allowedDimensionColumns:[...dimensionColumns],allowedTimeColumns:[...timeColumns]}));
  }
  if(requested.kind==="comparison") {
    validateComparisonOutputs(slots,shape,errors);
  }
}

function aggregateExpressionEquivalent(left,right) {
  if(!left||!right||String(left.name)!==String(right.name)||Boolean(left.distinct)!==Boolean(right.distinct)||String(left.argumentKind||"")!==String(right.argumentKind||""))return false;
  const leftColumns=[...(left.columns||[])].map(normalizeColumnKey).sort();const rightColumns=[...(right.columns||[])].map(normalizeColumnKey).sort();
  if(JSON.stringify(leftColumns)!==JSON.stringify(rightColumns))return false;
  return predicateListKey(left.predicates||[])===predicateListKey(right.predicates||[]);
}

function validateComparisonOutputs(slots,shape,errors) {
  const periods=slots.filter((item)=>item.kind==="time"&&item.range);
  const outputs=shape.outputOrder.map((name,index)=>({name,index,descriptor:shape.outputs.get(name)})).filter((item)=>item.descriptor?.aggregates?.length||item.descriptor?.ratioExpressions);
  if(periods.length<2) {
    errors.push(issue("INTENT_COMPARISON_OUTPUT_MISSING","同比或环比缺少可执行的当前期或基准期定义",{expectedPeriods:periods}));
    return;
  }
  if(outputs.length<periods.length)errors.push(issue("INTENT_COMPARISON_OUTPUT_MISSING","同比或环比必须分别输出当前期与基准期指标",{expectedOutputCount:periods.length,actualOutputs:outputs.map((item)=>item.name)}));
  const classified=outputs.map((output)=>({...output,matchedPeriodIds:periods.map((candidate)=>{
      const columns=new Set((candidate.columns||[]).map(normalizeColumnKey));
      return descriptorHasRangeBinding(output.descriptor,columns,{...candidate.range,kind:candidate.value})?candidate.id:null;
    }).filter(Boolean)}));
  const assignments=[];
  for(const period of periods) {
    const expectedColumns=new Set((period.columns||[]).map(normalizeColumnKey));
    const candidates=classified.filter((output)=>output.matchedPeriodIds.length===1&&output.matchedPeriodIds[0]===period.id);
    if(expectedColumns.size===0||candidates.length!==1)errors.push(issue(
      "INTENT_COMPARISON_OUTPUT_PERIOD_MISMATCH",
      `对比期间“${period.surfaceText||period.role}”必须由唯一且只匹配该期间的输出列承担`,
      {expectedPeriodId:period.id,candidateOrdinals:candidates.map((item)=>item.index+1),outputs:classified.map((item)=>({ordinal:item.index+1,name:item.name,matchedPeriodIds:item.matchedPeriodIds}))},
    ));
    else assignments.push({periodId:period.id,ordinal:candidates[0].index+1});
  }
  if(assignments.length===periods.length&&assignments.some((item,index)=>index>0&&item.ordinal<=assignments[index-1].ordinal))errors.push(issue(
    "INTENT_COMPARISON_OUTPUT_PERIOD_MISMATCH",
    "对比输出列顺序必须与当前期、基准期的期间顺序一一对应",
    {expectedPeriodOrder:periods.map((item)=>item.id),actualAssignments:assignments},
  ));
}

function descriptorHasRangeBinding(descriptor,expectedColumns,range) {
  return hasTimeRangeBinding({rangePredicates:descriptor?.rangePredicates||[]},expectedColumns,range);
}

function exactTimeBucketItem(item,grain,expectedColumns) {
  if(!item||item.buckets?.length!==1||item.columns?.length!==1)return false;
  const bucket=item.buckets[0];
  return bucket.grain===grain&&bucket.columns.length===1&&expectedColumns.has(bucket.columns[0])&&item.columns[0]===bucket.columns[0];
}

function hasTimeRangeBinding(shape,expectedColumns,range) {
  for(const column of expectedColumns) {
    const predicates=shape.rangePredicates.filter((item)=>item.column===column);
    for(const group of new Set(predicates.map((item)=>item.group))) {
      const scoped=predicates.filter((item)=>item.group===group);
      const lower=scoped.some((item)=>item.operator===">="&&sameBoundary(item.value,range.start));
      const upper=scoped.some((item)=>item.operator==="<"&&sameBoundary(item.value,range.endExclusive));
      if(lower&&upper)return true;
    }
  }
  return false;
}

function ratioFormulaMatches(expected,actual) {
  return formulaSideMatches(expected?.numerator,actual?.numerator)&&formulaSideMatches(expected?.denominator,actual?.denominator);
}

function ratioPredicateDefinitionUsable(formula) {
  return [formula?.numerator,formula?.denominator].every((side)=>{
    if(!side)return false;
    if(side.predicateBinding==="unsupported")return false;
    if(side.predicateBinding!=="physical")return true; // legacy knowledge pages
    return (side.predicates||[]).every((item)=>physicalPredicate(item)!=null);
  });
}

function formulaSideMatches(expected,actual) {
  if(!expected||!actual)return false;
  if(String(expected.aggregation)!==String(actual.aggregation)||Boolean(expected.distinct)!==Boolean(actual.distinct))return false;
  const expectedColumns=[...(expected.columns||[])].map(normalizeColumnKey).sort();const actualColumns=[...(actual.columns||[])].map(normalizeColumnKey).sort();
  if(JSON.stringify(expectedColumns)!==JSON.stringify(actualColumns))return false;
  if(expected.predicateBinding==="unsupported"||actual.predicateBinding==="unsupported")return false;
  if(expected.predicateBinding==="physical") {
    if(actual.predicateBinding!=="physical")return false;
    const expectedPredicates=(expected.predicates||[]).map(physicalPredicate);
    const actualPredicates=(actual.predicates||[]).map(physicalPredicate);
    if(expectedPredicates.some((item)=>item==null)||actualPredicates.some((item)=>item==null))return false;
    return JSON.stringify(expectedPredicates.sort())===JSON.stringify(actualPredicates.sort());
  }
  // Compatibility for pre-v2 metric pages. New definitions declare a physical
  // binding and take the strict branch above; legacy operator:value signatures
  // remain readable while those pages are migrated.
  const expectedLegacy=(expected.predicates||[]).map(legacyPredicateSignature).filter(Boolean).sort();
  const actualLegacy=(actual.predicates||[]).map(legacyPredicateSignature).filter(Boolean).sort();
  return JSON.stringify(expectedLegacy)===JSON.stringify(actualLegacy);
}

function physicalPredicate(value) {
  if(!value||typeof value!=="object"||!value.column||!value.operator||!value.valueType||value.value===undefined)return null;
  const valueType=String(value.valueType).toLowerCase();return `${normalizeColumnKey(value.column)}|${normalizeComparisonOperator(value.operator)}|${valueType}|${normalizedTypedValue(value.value,valueType)}`;
}

function legacyPredicateSignature(value) {
  if(typeof value==="string")return value;
  if(!value||typeof value!=="object")return "";
  return `${normalizeComparisonOperator(value.operator)}:${String(value.value)}`;
}

function sameBoundary(actual,expected) {
  const value=String(actual||"");
  return value===String(expected||"")||value.startsWith(`${expected} `)||value.startsWith(`${expected}T`);
}

function measureGrainColumns(slot,slots,columnsByTable) {
  const subject=slots.find((item)=>item.kind==="subject"&&item.value===slot.grain);
  const tables=subject?.tables||[];
  const result=new Set();
  for(const table of tables)for(const column of columnsByTable[table]||[]) {
    const name=normalize(column.columnName);
    const comment=String(column.comment||"");
    if(column.isPrimary||column.isUnique||name==="id"||name===`${normalize(slot.grain)}_id`||new RegExp(`${escapeRegex(slot.grain)}(?:编号|主键|id)`,"i").test(comment))result.add(`${normalize(table)}.${name}`);
  }
  if(!result.size)for(const value of subject?.columns||[])if(/(?:^|_)(?:id|no)$/.test(value.split(".").at(-1)))result.add(normalizeColumnKey(value));
  return result;
}

function aggregationMatches(expected,item) {
  if(expected==="count_distinct")return item.name==="count"&&item.distinct;
  return item.name===expected;
}

function relationCatalogFromVerdict(verdict) {
  const result=new Map();const joins=verdict?.joins||[];const ids=verdict?.joinRelationIds||[];
  for(let index=0;index<joins.length&&index<ids.length;index++) {
    const relationId=relationIdentifier(ids[index]);const endpoints=parsePhysicalJoin(joins[index]);
    if(relationId&&endpoints)result.set(relationEdgeKey(endpoints[0],endpoints[1]),relationId);
  }
  return result;
}

function parsePhysicalJoin(value) {
  const match=String(value||"").match(/^\s*`?([^`.\s=]+)`?\.`?([^`\s=]+)`?\s*=\s*`?([^`.\s=]+)`?\.`?([^`\s=]+)`?\s*$/i);
  return match?[`${normalizeTableName(match[1])}.${normalize(match[2])}`,`${normalizeTableName(match[3])}.${normalize(match[4])}`]:null;
}

function relationEdgeKey(left,right) {return [normalizeColumnKey(left),normalizeColumnKey(right)].sort().join("\u0000");}

function selectScopeId(ast,context) {
  let value=context.scopeIds.get(ast);
  if(!value){value=`q${context.nextScopeId++}`;context.scopeIds.set(ast,value);}
  return value;
}

function ordinalOutputDescriptor(node,outputs,outputOrder,{allowAggregate=true}={}) {
  if(node?.type!=="number")return null;
  const ordinal=Number(node.value);if(!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>outputOrder.length)return null;
  const descriptor=outputs.get(outputOrder[ordinal-1]);
  if(!descriptor||!allowAggregate&&(descriptor.aggregates.length||descriptor.ratioExpressions))return null;
  return cloneDescriptor(descriptor);
}

function extractActiveJoinEdges(node,resolve,relationCatalog,joinType="inner") {
  const result=[];
  for(const item of conjunctivePredicates(node)) {
    if(item?.type!=="binary_expr"||String(item.operator)!=="="||item.left?.type!=="column_ref"||item.right?.type!=="column_ref")continue;
    const leftDescriptor=resolve(item.left);const rightDescriptor=resolve(item.right);
    if(leftDescriptor.columns.size!==1||rightDescriptor.columns.size!==1||leftDescriptor.origins.size!==1||rightDescriptor.origins.size!==1)continue;
    const leftColumn=[...leftDescriptor.columns][0];const rightColumn=[...rightDescriptor.columns][0];
    const leftInstance=[...leftDescriptor.origins][0];const rightInstance=[...rightDescriptor.origins][0];
    if(leftInstance===rightInstance)continue;
    result.push({
      relationId:relationCatalog.get(relationEdgeKey(leftColumn,rightColumn))||null,
      joinType:normalizeJoinType(joinType),
      left:{instance:leftInstance,table:normalizeColumnKey(leftColumn).split(".")[0],column:normalizeColumnKey(leftColumn)},
      right:{instance:rightInstance,table:normalizeColumnKey(rightColumn).split(".")[0],column:normalizeColumnKey(rightColumn)},
    });
  }
  return result;
}

function extractRowDomainAtoms(node,resolve,relationCatalog,{source,joinType="inner",scopeId}) {
  if(!node)return [];
  if(node.type==="binary_expr"&&String(node.operator||"").toUpperCase()==="AND")return [
    ...extractRowDomainAtoms(node.left,resolve,relationCatalog,{source,joinType,scopeId}),
    ...extractRowDomainAtoms(node.right,resolve,relationCatalog,{source,joinType,scopeId}),
  ];
  const operator=normalizeComparisonOperator(node.operator);
  if(node.type!=="binary_expr")return [{kind:"unsupported",source,scopeId,operator:String(node.operator||node.type||"unknown").toLowerCase(),reason:"unsupported_expression"}];
  if(operator==="or")return [{kind:"unsupported",source,scopeId,operator,reason:"disjunction_not_declared"}];
  const left=describeExpression(node.left,resolve);const right=describeExpression(node.right,resolve);
  if(operator==="="&&classifyExpression(node.left,left)==="direct_column"&&classifyExpression(node.right,right)==="direct_column"&&left.columns.size===1&&right.columns.size===1&&left.origins.size===1&&right.origins.size===1) {
    const leftColumn=[...left.columns][0];const rightColumn=[...right.columns][0];
    const leftInstance=[...left.origins][0];const rightInstance=[...right.origins][0];
    return [{
      kind:"relation",source,scopeId,joinType:normalizeJoinType(joinType),
      relationId:relationCatalog.get(relationEdgeKey(leftColumn,rightColumn))||null,
      left:{instance:leftInstance,table:normalizeColumnKey(leftColumn).split(".")[0],column:normalizeColumnKey(leftColumn)},
      right:{instance:rightInstance,table:normalizeColumnKey(rightColumn).split(".")[0],column:normalizeColumnKey(rightColumn)},
    }];
  }
  if(new Set(["in","not in"]).has(operator)&&left.columns.size===1&&right.columns.size===0&&node.right?.type==="expr_list") {
    const values=(node.right.value||[]).map(typedLiteral);
    if(values.length&&(values.every(Boolean)))return [{
      kind:"predicate",source,scopeId,column:[...left.columns][0],operator,
      valueType:"list",value:values.map((item)=>item.value),values,
      expressionKind:classifyExpression(node.left,left),origins:[...left.origins],
    }];
  }
  if((left.columns.size===1)!==(right.columns.size===1)) {
    const descriptor=left.columns.size?left:right;const boundary=left.columns.size?node.right:node.left;
    const comparison=normalizeComparisonOperator(left.columns.size?operator:reverseOperator(operator));
    const literal=typedLiteral(boundary);const dynamicKind=literal?null:recognizedDynamicBoundary(boundary);
    if(new Set(["=","!=",">",">=","<","<=","is","is not","like","not like"]).has(comparison)&&(literal||dynamicKind))return [{
      kind:"predicate",source,scopeId,column:[...descriptor.columns][0],operator:comparison,
      valueType:literal?.valueType||"dynamic",value:literal?.value??null,dynamicKind,expressionKind:classifyExpression(left.columns.size?node.left:node.right,descriptor),origins:[...descriptor.origins],
    }];
  }
  return [{kind:"unsupported",source,scopeId,operator,reason:"predicate_not_physically_bound"}];
}

function cloneRowDomainAtom(item){return structuredClone(item);}
function uniqueRowDomainAtoms(values){return [...new Map((values||[]).map((item)=>[JSON.stringify(item),item])).values()];}

function cloneJoinEdge(item){return {relationId:item?.relationId??null,joinType:item?.joinType||"unknown",left:{...(item?.left||{})},right:{...(item?.right||{})}};}
function uniqueJoinEdges(values){return [...new Map((values||[]).map((item)=>[`${item.relationId||""}|${item.joinType||""}|${[`${item.left?.instance}:${item.left?.column}`,`${item.right?.instance}:${item.right?.column}`].sort().join("|")}`,item])).values()];}
function publicJoinEdges(values){return (values||[]).map((item)=>({relationId:item.relationId,joinType:item.joinType,left:{table:item.left?.table,column:item.left?.column,aliasInstance:item.left?.instance},right:{table:item.right?.table,column:item.right?.column,aliasInstance:item.right?.instance}}));}
function publicInstances(values){return [...(values||new Map()).entries()].map(([id,item])=>({id,table:item.table,alias:item.alias,scopeId:item.scopeId}));}

function normalizeJoinType(value) {
  const join=String(value||"").trim().toUpperCase();
  if(!join||join==="JOIN"||join.includes("INNER"))return "inner";
  if(join.includes("LEFT"))return "left";
  if(join.includes("RIGHT"))return "right";
  if(join.includes("FULL"))return "full";
  if(join.includes("CROSS"))return "cross";
  return "unknown";
}

function describeSql(ast,{usedTables=[],columnsByTable={},sql="",relationCatalog=new Map()}={}) {
  const empty=emptyAnalysis();empty.rawSql=String(sql||"");
  if(!ast||ast.type!=="select")return empty;
  const catalog=new Map(Object.entries(columnsByTable||{}).map(([table,columns])=>[normalize(table),new Set((columns||[]).map((column)=>normalize(column.columnName??column))) ]));
  const context={catalog,usedTables:new Set((usedTables||[]).map(normalize)),relationCatalog,memo:new WeakMap(),scopeIds:new WeakMap(),nextScopeId:1};
  const result=analyzeSelect(ast,context,new Map(),new Set());
  result.rawSql=String(sql||"");
  return result;
}

function analyzeSelect(ast,context,parentCtes,stack) {
  if(context.memo.has(ast))return cloneAnalysis(context.memo.get(ast));
  if(stack.has(ast))return emptyAnalysis();
  const nextStack=new Set(stack);nextStack.add(ast);
  const scopeId=selectScopeId(ast,context);
  const ctes=new Map(parentCtes);
  for(const item of ast.with||[]) {
    const name=normalize(item.name?.value??item.name);
    const body=item.stmt?.ast||item.stmt;
    if(name&&body?.type==="select")ctes.set(name,{ast:body,declared:(item.columns||[]).map((column)=>normalize(column?.value??column))});
  }
  const sources=new Map();const sourceAnalyses=[];const effectiveTables=new Set();const activeInstances=new Map();const activeJoinEdges=[];const rowDomainAtoms=[];
  for(const [sourceIndex,source] of (ast.from||[]).entries()) {
    const alias=normalize(source.as||source.table||"");
    if(source.table) {
      const table=normalize(source.table);
      const definition=ctes.get(table);
      if(definition) {
        let analysis=analyzeSelect(definition.ast,context,ctes,nextStack);
        if(definition.declared.length)analysis=renameAnalysisOutputs(analysis,definition.declared);
        sources.set(alias||table,{kind:"derived",analysis});sourceAnalyses.push(analysis);
        for(const item of analysis.effectiveTables)effectiveTables.add(item);
      } else {
        const instanceId=`${scopeId}:${alias||table}:${sourceIndex+1}`;
        sources.set(alias||table,{kind:"physical",table,instanceId});effectiveTables.add(table);activeInstances.set(instanceId,{table,alias:alias||table,scopeId});
      }
      continue;
    }
    const body=source.expr?.ast||source.ast;
    if(body?.type==="select") {
      const analysis=analyzeSelect(body,context,ctes,nextStack);
      sources.set(alias,{kind:"derived",analysis});sourceAnalyses.push(analysis);
      for(const item of analysis.effectiveTables)effectiveTables.add(item);
    }
  }
  const resolve=(ref,outputAliases=null)=>resolveReference(ref,sources,context,outputAliases);
  const outputs=new Map();const outputOrder=[];const selectedColumns=new Set();const selectedDescriptors=[];const selectedRangePredicates=[];
  for(const [index,column] of (ast.columns||[]).entries()) {
    const outputName=normalize(column.as||(column.expr?.type==="column_ref"?column.expr.column:`column_${index+1}`));
    const descriptor=describeExpression(column.expr,(ref)=>resolve(ref));
    descriptor.expressionKind=classifyExpression(column.expr,descriptor);
    descriptor.aggregates=descriptor.aggregates.map((item)=>({...item,alias:outputName||item.alias||""}));
    descriptor.rangePredicates.push(...extractConditionalRangePredicates(column.expr,(ref)=>resolve(ref),`select:${index}`));
    outputs.set(outputName,descriptor);outputOrder.push(outputName);selectedDescriptors.push(descriptor);
    for(const item of descriptor.columns)selectedColumns.add(item);
    selectedRangePredicates.push(...descriptor.rangePredicates);
  }
  const whereDescriptor=describeExpression(ast.where,(ref)=>resolve(ref));
  const whereColumns=new Set(whereDescriptor.columns);const rangePredicates=[...selectedRangePredicates,...extractRangePredicates(ast.where,(ref)=>resolve(ref),"where")];
  const filterPredicates=[];filterPredicates.push(...extractPhysicalFilterPredicates(ast.where,(ref)=>resolve(ref)));
  rowDomainAtoms.push(...extractRowDomainAtoms(ast.where,(ref)=>resolve(ref),context.relationCatalog,{source:"where",scopeId}));
  rowDomainAtoms.push(...extractRowDomainAtoms(ast.having,(ref)=>resolve(ref),context.relationCatalog,{source:"having",scopeId}));
  const groupColumns=new Set();const groupBuckets=[];const groupItems=[];
  for(const [index,item] of (ast.groupby?.columns||[]).entries()) {
    const ordinalDescriptor=ordinalOutputDescriptor(item,outputs,outputOrder,{allowAggregate:false});
    const descriptor=ordinalDescriptor||describeExpression(item,(ref)=>resolve(ref));
    const expressionKind=ordinalDescriptor?ordinalDescriptor.expressionKind:classifyExpression(item,descriptor);
    for(const column of descriptor.columns)groupColumns.add(column);
    groupBuckets.push(...descriptor.buckets);
    groupItems.push({ordinal:index+1,expressionKind,columns:[...descriptor.columns],origins:[...descriptor.origins],buckets:uniqueBuckets(descriptor.buckets)});
  }
  const referencedColumns=new Set([...selectedColumns,...whereColumns,...groupColumns]);
  for(const source of ast.from||[]) {
    const descriptor=describeExpression(source.on,(ref)=>resolve(ref));
    for(const column of descriptor.columns)referencedColumns.add(column);
    filterPredicates.push(...extractPhysicalFilterPredicates(source.on,(ref)=>resolve(ref)));
    const joinType=normalizeJoinType(source.join);
    activeJoinEdges.push(...extractActiveJoinEdges(source.on,(ref)=>resolve(ref),context.relationCatalog,joinType));
    rowDomainAtoms.push(...extractRowDomainAtoms(source.on,(ref)=>resolve(ref),context.relationCatalog,{source:"join_on",joinType,scopeId}));
  }
  for(const analysis of sourceAnalyses) {
    for(const item of analysis.whereColumns)whereColumns.add(item);
    for(const item of analysis.groupColumns)groupColumns.add(item);
    for(const item of analysis.referencedColumns)referencedColumns.add(item);
    rangePredicates.push(...analysis.rangePredicates);groupBuckets.push(...analysis.groupBuckets);groupItems.push(...analysis.groupItems.map((item)=>structuredClone(item)));filterPredicates.push(...analysis.filterPredicates.map((item)=>({...item})));
    for(const [id,item] of analysis.activeInstances)activeInstances.set(id,{...item});
    activeJoinEdges.push(...analysis.activeJoinEdges.map(cloneJoinEdge));
    rowDomainAtoms.push(...analysis.rowDomainAtoms.map(cloneRowDomainAtom));
  }
  const aggregates=uniqueAggregates(selectedDescriptors.flatMap((item)=>item.aggregates));
  const ratioExpressions=selectedDescriptors.reduce((sum,item)=>sum+item.ratioExpressions,0);
  const ratioColumns=new Set(selectedDescriptors.flatMap((item)=>[...item.ratioColumns]));
  const ratioSignatures=selectedDescriptors.flatMap((item)=>item.ratioSignatures);
  const orderBy=[];
  for(const item of ast.orderby||[]) {
    const field=item.expr?.type==="column_ref"?String(item.expr.column||""):"";
    const ordinalDescriptor=ordinalOutputDescriptor(item.expr,outputs,outputOrder);
    const outputAlias=Boolean(item.expr?.type==="column_ref"&&!item.expr.table&&outputs.has(normalize(item.expr.column)));
    const descriptor=ordinalDescriptor||describeExpression(item.expr,(ref)=>resolve(ref,outputs));
    const expressionKind=ordinalDescriptor?"ordinal":outputAlias?"output_alias":classifyExpression(item.expr,descriptor);
    orderBy.push({field,expressionKind,direction:String(item.type||"ASC").toLowerCase(),aggregate:descriptor.aggregates.length>0,aggregateAliases:unique(descriptor.aggregates.map((entry)=>entry.alias)),aggregates:descriptor.aggregates.map(cloneAggregate),columns:[...descriptor.columns],origins:[...descriptor.origins],buckets:uniqueBuckets(descriptor.buckets)});
  }
  const limit=limitSpec(ast.limit);
  const analysis={selectedColumns,whereColumns,rangePredicates,filterPredicates:uniquePredicates(filterPredicates),rowDomainAtoms:uniqueRowDomainAtoms(rowDomainAtoms),groupColumns,groupBuckets:uniqueBuckets(groupBuckets),groupItems:uniqueGroupItems(groupItems),aggregates,ratioExpressions,ratioColumns,ratioSignatures,orderBy,effectiveTables,referencedColumns,outputs,outputOrder,activeInstances,activeJoinEdges:uniqueJoinEdges(activeJoinEdges),limit:limit.rowCount,offset:limit.offset,rawSql:""};
  context.memo.set(ast,cloneAnalysis(analysis));
  return analysis;
}

function resolveReference(ref,sources,context,outputAliases) {
  if(ref?.type!=="column_ref"||String(ref.column)==="*")return emptyDescriptor();
  const column=normalize(ref.column);
  if(!ref.table&&outputAliases?.has(column))return cloneDescriptor(outputAliases.get(column));
  if(ref.table) {
    const source=sources.get(normalize(ref.table));
    return sourceDescriptor(source,column,context);
  }
  const candidates=[];
  for(const source of sources.values()) {
    const descriptor=sourceDescriptor(source,column,context);
    if(descriptor.columns.size||descriptor.aggregates.length||descriptor.buckets.length)candidates.push(descriptor);
  }
  return candidates.length===1?candidates[0]:emptyDescriptor();
}

function sourceDescriptor(source,column,context) {
  if(!source)return emptyDescriptor();
  if(source.kind==="derived")return cloneDescriptor(source.analysis.outputs.get(column)||emptyDescriptor());
  const known=context.catalog.get(source.table);
  if(known&&!known.has(column))return emptyDescriptor();
  if(!known&&!context.usedTables.has(source.table))return emptyDescriptor();
  const descriptor=emptyDescriptor();descriptor.columns.add(`${source.table}.${column}`);descriptor.expressionKind="direct_column";if(source.instanceId)descriptor.origins.add(source.instanceId);return descriptor;
}

function describeExpression(node,resolve) {
  if(!node||typeof node!=="object")return emptyDescriptor();
  if(node.ast?.type==="select")return emptyDescriptor();
  if(Array.isArray(node))return mergeDescriptors(node.map((item)=>describeExpression(item,resolve)));
  if(node.type==="column_ref")return resolve(node);
  if(node.type==="aggr_func") {
    const args=describeExpression(node.args,resolve);
    const descriptor=cloneDescriptor(args);
    const predicateBinding=astPredicateBindings(node.args,resolve);
    const argumentKind=predicateBinding.conditional?"conditional":classifyExpression(node.args?.expr,args);
    descriptor.expressionKind="aggregate";
    descriptor.aggregates=[{name:String(node.name||"").toLowerCase(),distinct:Boolean(node.args?.distinct),argumentKind,columns:[...args.columns],predicates:predicateBinding.predicates,predicateBinding:predicateBinding.status,conditional:predicateBinding.conditional,alias:""}];
    return descriptor;
  }
  const children=[];
  for(const [key,value] of Object.entries(node))if(key!=="ast"&&key!=="tableList"&&key!=="columnList"&&value&&typeof value==="object")children.push(describeExpression(value,resolve));
  const descriptor=mergeDescriptors(children);
  const bucket=timeBucket(node,descriptor.columns);if(bucket)descriptor.buckets.push(bucket);
  if(node.type==="binary_expr"&&String(node.operator)==="/") {
    const left=describeExpression(node.left,resolve);const right=describeExpression(node.right,resolve);
    if(left.aggregates.length&&right.aggregates.length){descriptor.ratioExpressions++;for(const column of [...left.columns,...right.columns])descriptor.ratioColumns.add(column);descriptor.ratioSignatures.push({numerator:formulaSide(left.aggregates[0]),denominator:formulaSide(right.aggregates[0])});}
  }
  return descriptor;
}

function classifyExpression(node,descriptor=emptyDescriptor()) {
  if(!node||typeof node!=="object")return "expression";
  if(node.type==="column_ref")return descriptor.expressionKind||"direct_column";
  if(node.type==="aggr_func")return "aggregate";
  if(timeBucket(node,descriptor.columns))return "time_bucket";
  return "expression";
}

function extractRangePredicates(where,resolve,group="where") {
  const result=[];
  for(const item of conjunctivePredicates(where)) {
    if(item?.type!=="binary_expr"||![">=",">","<","<="].includes(String(item.operator)))continue;
    const left=describeExpression(item.left,resolve);const right=describeExpression(item.right,resolve);
    if(left.columns.size!==1&&right.columns.size!==1)continue;
    if(left.columns.size&&right.columns.size)continue;
    const column=[...(left.columns.size?left.columns:right.columns)][0];const boundary=left.columns.size?item.right:item.left;
    const operator=left.columns.size?String(item.operator):reverseOperator(String(item.operator));
    const value=literalBoundary(boundary);const dynamicKind=value==null?recognizedDynamicBoundary(boundary):null;
    result.push({column,operator,value,dynamicKind,group});
  }
  return result;
}

function extractConditionalRangePredicates(node,resolve,prefix) {
  const result=[];let index=0;
  walkExpressionNodes(node,(item)=>{if(item.type==="when"&&item.cond)result.push(...extractRangePredicates(item.cond,resolve,`${prefix}:when:${index++}`));});
  return result;
}

function walkExpressionNodes(value,visitor,seen=new Set()) {
  if(!value||typeof value!=="object"||seen.has(value)||value.ast?.type==="select")return;
  seen.add(value);visitor(value);
  for(const [key,child] of Object.entries(value))if(key!=="ast"&&child&&typeof child==="object")walkExpressionNodes(child,visitor,seen);
}

function conjunctivePredicates(node) {
  if(!node)return [];
  if(node.type==="binary_expr"&&String(node.operator).toUpperCase()==="AND")return [...conjunctivePredicates(node.left),...conjunctivePredicates(node.right)];
  if(node.type==="binary_expr"&&String(node.operator).toUpperCase()==="OR")return [];
  return [node];
}

function recognizedDynamicBoundary(node) {
  const text=JSON.stringify(node||{}).toLowerCase();
  if(!text.includes("date_format")||!text.includes("%y-%m-01"))return null;
  if(text.includes("date_add")&&text.includes("month"))return "next_month_start";
  if(text.includes("date_sub")&&text.includes("month"))return "previous_month_start";
  if(text.includes("current_date")||text.includes("curdate"))return "current_month_start";
  return null;
}

function timeBucket(node,columns) {
  if(!columns.size)return null;
  const name=functionName(node);let grain=null;
  if(name==="date")grain="day";
  else if(name==="week"||name==="weekofyear")grain="week";
  else if(name==="month")grain="month";
  else if(name==="quarter")grain="quarter";
  else if(name==="year")grain="year";
  else if(name==="date_format") {
    const text=JSON.stringify(node).toLowerCase();
    if(/%[yv].*%[mu].*%d/.test(text)||text.includes("%y-%m-%d"))grain="day";
    else if(text.includes("%v")||text.includes("%u"))grain="week";
    else if(text.includes("%m"))grain="month";
    else if(text.includes("%y"))grain="year";
  }
  return grain?{grain,columns:[...columns]}:null;
}

function functionName(node) {
  if(!new Set(["function","aggr_func"]).has(node?.type))return "";
  const raw=node.name?.name?.at?.(-1)?.value??node.name?.value??node.name;
  return String(raw||"").toLowerCase();
}

function astPredicateBindings(node,resolve) {
  const conditions=[];
  walkExpressionNodes(node,(item)=>{if(item.type==="when"&&item.cond)conditions.push(item.cond);});
  if(!conditions.length) {
    let conditional=false;
    walkExpressionNodes(node,(item)=>{
      const operator=normalizeComparisonOperator(item.operator);
      if(new Set(["=","!=",">",">=","<","<=","is","is not","like","not like","in","not in","between","not between","or","and","not"]).has(operator))conditional=true;
      if(new Set(["if","iif","nullif"]).has(functionName(item)))conditional=true;
    });
    return conditional?{status:"unsupported",predicates:[],conditional:true}:{status:"physical",predicates:[],conditional:false};
  }
  // Multiple WHEN branches encode disjunction/precedence semantics that a flat
  // predicate list cannot faithfully represent.
  if(conditions.length!==1)return {status:"unsupported",predicates:[],conditional:true};
  return {...physicalPredicateBindings(conditions[0],resolve),conditional:true};
}

function extractPhysicalFilterPredicates(node,resolve) {
  if(!node||containsUnsupportedBoolean(node))return [];
  const predicates=[];
  for(const item of conjunctivePredicates(node)) {
    const binding=physicalPredicateBindings(item,resolve);
    // JOIN identity atoms (column = column) and other non-literal atoms are not
    // validity predicates. They must not erase a sibling `is_deleted = 0` atom.
    if(binding.status==="physical")predicates.push(...binding.predicates);
  }
  return uniquePredicates(predicates);
}

function physicalPredicateBindings(node,resolve) {
  if(!node)return {status:"physical",predicates:[]};
  if(containsUnsupportedBoolean(node))return {status:"unsupported",predicates:[]};
  const predicates=[];
  for(const item of conjunctivePredicates(node)) {
    if(item?.type!=="binary_expr")return {status:"unsupported",predicates:[]};
    const left=describeExpression(item.left,resolve);const right=describeExpression(item.right,resolve);
    if((left.columns.size===1)===(right.columns.size===1))return {status:"unsupported",predicates:[]};
    const literal=typedLiteral(left.columns.size?item.right:item.left);
    if(!literal)return {status:"unsupported",predicates:[]};
    const operator=normalizeComparisonOperator(left.columns.size?item.operator:reverseOperator(String(item.operator)));
    if(!new Set(["=","!=",">",">=","<","<=","is","is not","like","not like"]).has(operator))return {status:"unsupported",predicates:[]};
    const descriptor=left.columns.size?left:right;
    if(classifyExpression(left.columns.size?item.left:item.right,descriptor)!=="direct_column")return {status:"unsupported",predicates:[]};
    predicates.push({column:[...descriptor.columns][0],operator,valueType:literal.valueType,value:literal.value,expressionKind:"direct_column",origins:[...descriptor.origins]});
  }
  return {status:"physical",predicates:uniquePredicates(predicates)};
}

function containsUnsupportedBoolean(node) {
  let unsupported=false;
  walkExpressionNodes(node,(item)=>{
    const operator=String(item.operator||"").toUpperCase();
    if(operator==="OR"||operator==="NOT"||item.type==="unary_expr"&&operator==="NOT")unsupported=true;
  });
  return unsupported;
}

function typedLiteral(node) {
  if(!node||typeof node!=="object")return null;
  if(node.type==="number")return {valueType:"number",value:canonicalNumericLiteral(node.value)??String(node.value)};
  if(["single_quote_string","double_quote_string","string"].includes(node.type))return {valueType:"string",value:String(node.value)};
  if(node.type==="bool")return {valueType:"boolean",value:String(node.value).toLowerCase()};
  if(node.type==="null")return {valueType:"null",value:"null"};
  return null;
}

function formulaSide(item){return {aggregation:item?.name||"",distinct:Boolean(item?.distinct),argumentKind:item?.argumentKind||"expression",columns:[...(item?.columns||[])],predicates:structuredClone(item?.predicates||[]),predicateBinding:item?.predicateBinding||"unsupported"};}

function emptyDescriptor(){return {expressionKind:null,columns:new Set(),origins:new Set(),aggregates:[],buckets:[],rangePredicates:[],ratioExpressions:0,ratioColumns:new Set(),ratioSignatures:[]};}
function cloneAggregate(item){return {...item,columns:[...(item?.columns||[])],predicates:structuredClone(item?.predicates||[])};}
function cloneDescriptor(value){return {expressionKind:value?.expressionKind||null,columns:new Set(value?.columns||[]),origins:new Set(value?.origins||[]),aggregates:(value?.aggregates||[]).map(cloneAggregate),buckets:(value?.buckets||[]).map((item)=>({...item,columns:[...(item.columns||[])]})),rangePredicates:(value?.rangePredicates||[]).map((item)=>({...item})),ratioExpressions:Number(value?.ratioExpressions||0),ratioColumns:new Set(value?.ratioColumns||[]),ratioSignatures:structuredClone(value?.ratioSignatures||[])};}
function mergeDescriptors(values){const result=emptyDescriptor();for(const value of values){for(const item of value.columns)result.columns.add(item);for(const item of value.origins||[])result.origins.add(item);result.aggregates.push(...value.aggregates);result.buckets.push(...value.buckets);result.rangePredicates.push(...(value.rangePredicates||[]));result.ratioExpressions+=value.ratioExpressions;for(const item of value.ratioColumns)result.ratioColumns.add(item);result.ratioSignatures.push(...value.ratioSignatures);}result.aggregates=uniqueAggregates(result.aggregates);result.buckets=uniqueBuckets(result.buckets);return result;}
function emptyAnalysis(){return {selectedColumns:new Set(),whereColumns:new Set(),rangePredicates:[],filterPredicates:[],rowDomainAtoms:[],groupColumns:new Set(),groupBuckets:[],groupItems:[],aggregates:[],ratioExpressions:0,ratioColumns:new Set(),ratioSignatures:[],orderBy:[],effectiveTables:new Set(),referencedColumns:new Set(),outputs:new Map(),outputOrder:[],activeInstances:new Map(),activeJoinEdges:[],limit:null,offset:0,rawSql:""};}
function cloneAnalysis(value){return {...value,selectedColumns:new Set(value.selectedColumns),whereColumns:new Set(value.whereColumns),rangePredicates:value.rangePredicates.map((item)=>({...item})),filterPredicates:(value.filterPredicates||[]).map((item)=>({...item})),rowDomainAtoms:(value.rowDomainAtoms||[]).map(cloneRowDomainAtom),groupColumns:new Set(value.groupColumns),groupBuckets:value.groupBuckets.map((item)=>({...item,columns:[...item.columns]})),groupItems:(value.groupItems||[]).map((item)=>structuredClone(item)),aggregates:value.aggregates.map(cloneAggregate),ratioColumns:new Set(value.ratioColumns),ratioSignatures:structuredClone(value.ratioSignatures||[]),orderBy:value.orderBy.map((item)=>({...item,aggregates:(item.aggregates||[]).map(cloneAggregate),columns:[...item.columns],origins:[...(item.origins||[])],buckets:item.buckets.map((bucket)=>({...bucket,columns:[...bucket.columns]}))})),effectiveTables:new Set(value.effectiveTables),referencedColumns:new Set(value.referencedColumns),outputs:new Map([...value.outputs].map(([key,item])=>[key,cloneDescriptor(item)])),outputOrder:[...value.outputOrder],activeInstances:new Map([...(value.activeInstances||new Map())].map(([id,item])=>[id,{...item}])),activeJoinEdges:(value.activeJoinEdges||[]).map(cloneJoinEdge)};}
function renameAnalysisOutputs(analysis,names){const next=cloneAnalysis(analysis);const outputs=new Map();for(const [index,oldName] of next.outputOrder.entries())outputs.set(names[index]||oldName,next.outputs.get(oldName));next.outputs=outputs;next.outputOrder=[...outputs.keys()];return next;}
function uniqueAggregates(values){return [...new Map(values.map((item)=>[`${item.alias}|${item.name}|${item.distinct}|${item.argumentKind}|${item.conditional}|${item.predicateBinding}|${(item.columns||[]).join(",")}|${predicateListKey(item.predicates||[])}`,item])).values()];}
function uniqueBuckets(values){return [...new Map((values||[]).map((item)=>[`${item.grain}|${(item.columns||[]).join(",")}`,item])).values()];}
function uniqueGroupItems(values){return [...new Map((values||[]).map((item)=>[`${item.expressionKind||""}|${(item.columns||[]).join(",")}|${(item.origins||[]).join(",")}|${(item.buckets||[]).map((bucket)=>`${bucket.grain}:${bucket.columns.join(",")}`).join(";")}`,item])).values()];}
function limitSpec(limit){const values=limit?.value||[];const numbers=values.map((node)=>node?.type==="number"?Number(node.value):null);if(numbers.some((item)=>item==null))return {rowCount:null,offset:0};if(numbers.length===1)return {rowCount:numbers[0],offset:0};if(String(limit?.seperator||"").toLowerCase()===",")return {rowCount:numbers[1],offset:numbers[0]};if(String(limit?.seperator||"").toLowerCase()==="offset")return {rowCount:numbers[0],offset:numbers[1]};return {rowCount:null,offset:0};}

function publicShape(shape) {return {selectedColumns:[...shape.selectedColumns],whereColumns:[...shape.whereColumns],rangePredicates:shape.rangePredicates,filterPredicates:shape.filterPredicates,rowDomainAtoms:shape.rowDomainAtoms,groupColumns:[...shape.groupColumns],groupBuckets:shape.groupBuckets,groupItems:shape.groupItems,aggregates:shape.aggregates.map(publicAggregate),ratioExpressions:shape.ratioExpressions,ratioColumns:[...shape.ratioColumns],ratioSignatures:shape.ratioSignatures,orderBy:shape.orderBy,effectiveTables:[...shape.effectiveTables],activeInstances:publicInstances(shape.activeInstances),activeJoinEdges:publicJoinEdges(shape.activeJoinEdges),requestedLimit:shape.requestedLimit,requestedOffset:shape.requestedOffset,limit:shape.limit,offset:shape.offset};}
function publicAggregate(item){return {name:item.name,distinct:item.distinct,columns:item.columns,alias:item.alias};}
function publicSlot(slot){return {id:slot.id,kind:slot.kind,value:slot.value,values:slot.values,role:slot.role,required:slot.required,immutable:slot.immutable,source:slot.source,evidenceLevel:slot.evidenceLevel,ontologySchemaVersion:slot.ontologySchemaVersion,rootObject:slot.rootObject,object:slot.object,owner:slot.owner,table:slot.table,column:slot.column,tables:slot.tables,columns:slot.columns,filterBindings:slot.filterBindings||[],labelColumns:slot.labelColumns,identityColumns:slot.identityColumns,bindingTables:slot.bindingTables,bindingColumns:slot.bindingColumns,bindingRelationIds:slot.bindingRelationIds,bindingValidityPredicates:slot.bindingValidityPredicates,executionValidityPredicates:slot.executionValidityPredicates};}
function issue(code,message,details={}) {return {code,stage:"intent",retryable:true,message,details};}
function requirementCode(kind){return {subject:"INTENT_SUBJECT_DROPPED",dimension:"INTENT_DIMENSION_DROPPED",measure:"INTENT_MEASURE_DROPPED",time:"INTENT_TIME_ROLE_DROPPED"}[kind]||"INTENT_REQUIREMENT_DROPPED";}
function kindLabel(kind){return {subject:"业务对象",dimension:"分析维度",measure:"统计指标",time:"时间角色"}[kind]||"语义要求";}
function unique(values){return [...new Set(values.filter(Boolean))];}
function stableFacetValues(facets,key) {
  if(!facets.length)return [];
  const groups=facets.map((facet)=>unique(facet?.[key]||[]).sort());
  const signature=JSON.stringify(groups[0]);
  return groups.every((group)=>JSON.stringify(group)===signature)?groups[0]:[];
}
function stableFacetObjects(facets,key,keyOf) {
  if(!facets.length)return [];
  const groups=facets.map((facet)=>[...(facet?.[key]||[])].sort((left,right)=>keyOf(left).localeCompare(keyOf(right))));
  const signatures=groups.map((group)=>JSON.stringify(group.map(keyOf)));
  return signatures.every((signature)=>signature===signatures[0])?groups[0]:[];
}
function filterBindingKey(item){const valueType=String(item?.valueType||"").toLowerCase();return `${normalizeColumnKey(item?.column)}|${normalizeFilterOperator(item?.operator)}|${valueType}|${normalizedTypedValue(item?.value,valueType)}`;}
function normalizeSemanticContract(value) {
  if(!value)return {binding:null,slots:[],errors:[]};
  const errors=[];const slots=[];const schemaVersion=Number(value.ontologySchemaVersion);const rootObject=String(value.rootObject||"").trim();const sourceSlots=Array.isArray(value.rowDomainSlots)?value.rowDomainSlots:[];
  const binding={version:String(value.version||""),ontologySchemaVersion:Number.isSafeInteger(schemaVersion)&&schemaVersion>0?schemaVersion:null,rootObject,immutable:value.immutable===true};
  if(sourceSlots.length&&binding.ontologySchemaVersion==null)errors.push({message:"子类判别条件未绑定有效的 Ontology Schema 版本",details:{ontologySchemaVersion:value.ontologySchemaVersion??null,rootObject}});
  if(sourceSlots.length&&!rootObject)errors.push({message:"子类判别条件未绑定 Query Plan 根对象",details:{ontologySchemaVersion:binding.ontologySchemaVersion}});
  if(sourceSlots.length&&value.immutable!==true)errors.push({message:"子类判别合同必须为不可变绑定",details:{ontologySchemaVersion:binding.ontologySchemaVersion,rootObject}});
  const ids=new Set();
  for(const [index,raw] of sourceSlots.entries()) {
    const table=normalizeTableName(raw?.table);const columnName=normalize(raw?.column);const column=table&&columnName?`${table}.${columnName}`:"";
    const values=Array.isArray(raw?.values)?raw.values.map((item)=>({value:item?.value,valueType:String(item?.valueType||"").toLowerCase()})):[];
    const id=String(raw?.id||"");
    const validTypes=new Set(["string","number","boolean","null"]);
    const expectedOperator=values.length===1?"eq":"in";
    const structurallyValid=id&&raw?.kind==="semantic_row_domain"&&raw?.role==="ontology_subtype_discriminator"&&raw?.required===true&&raw?.immutable===true&&raw?.source==="published_ontology"&&Number(raw?.ontologySchemaVersion)===binding.ontologySchemaVersion&&raw?.rootObject===rootObject&&raw?.operator===expectedOperator&&column&&values.length&&values.every((item)=>validTypes.has(item.valueType)&&item.value!==undefined);
    if(!structurallyValid||ids.has(id)) {
      errors.push({message:"子类判别 slot 绑定不完整或与 Schema 版本/根对象不一致",details:{index,id:id||null,ontologySchemaVersion:binding.ontologySchemaVersion,rootObject}});
      continue;
    }
    ids.add(id);
    slots.push({...raw,id,table,column:columnName,tables:[table],columns:[column],values,operator:values.length===1?"eq":"in",required:true,immutable:true});
  }
  return {binding,slots,errors};
}
function semanticLiteralKey(item) {
  const valueType=String(item?.valueType||"").toLowerCase();
  return `${valueType}:${normalizedTypedValue(item?.value,valueType)}`;
}
function uniqueValues(values){return [...new Map((values||[]).filter((item)=>item!==null&&item!==undefined).map((item)=>[String(item),item])).values()];}
function uniquePaths(values){return [...new Map((values||[]).filter(Array.isArray).map((item)=>[item.map(normalize).join("\u0000"),item])).values()];}
function uniquePredicates(values){return [...new Map((values||[]).map((item)=>[typeof item==="string"?item:`${physicalPredicate(item)||JSON.stringify(item)}|${[...(item?.origins||[])].sort().join(",")}`,item])).values()];}
function predicateListKey(values){return (values||[]).map((item)=>typeof item==="string"?item:physicalPredicate(item)||JSON.stringify(item)).sort().join(";");}
function reverseOperator(operator){return ({">=":"<=",">":"<","<":">","<=":">="})[operator]||operator;}
function normalizeComparisonOperator(operator){const value=String(operator||"").trim().toLowerCase();if(value==="==")return "=";if(value==="<>")return "!=";return value;}
function normalizedTypedValue(value,valueType){return valueType==="number"?(canonicalNumericLiteral(value)??String(value??"")):String(value??"");}
function canonicalNumericLiteral(value){const match=String(value??"").trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);if(!match)return null;const integer=String(match[2]||"0").replace(/^0+(?=\d)/,"")||"0";const fraction=String(match[3]??match[4]??"").replace(/0+$/,"");const sign=match[1]==="-"&&!(integer==="0"&&!fraction)?"-":"";return `${sign}${integer}${fraction?`.${fraction}`:""}`;}
function literalBoundary(node){if(!node||typeof node!=="object")return null;if(["single_quote_string","double_quote_string","string","number"].includes(node.type))return String(node.value);return null;}
function normalize(value){return String(value||"").replaceAll("`","").replaceAll("'","").replaceAll('"',"").split(".").at(-1).toLowerCase();}
function normalizeTableName(value){return String(value||"").replaceAll("`","").replaceAll("'","").replaceAll('"',"").toLowerCase();}
function normalizeColumnKey(value){const parts=String(value||"").replaceAll("`","").split(".");return `${normalize(parts.at(-2)||"")}.${normalize(parts.at(-1)||"")}`;}
function escapeRegex(value){return String(value||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}

export const _internal={describeSql,measureGrainColumns};
