// Shared between the query hero counter and the knowledge workspace cards so the
// two views can never drift apart on how coverage is counted.
export const KNOWLEDGE_PAGE_TYPES=["term","metric","join","rule","table"];

export function coverageByType(pages) {
  const list=Array.isArray(pages)?pages:[];
  const result={};
  for(const type of KNOWLEDGE_PAGE_TYPES)result[type]={total:0,verified:0};
  for(const page of list) {
    const bucket=result[page?.pageType];
    if(!bucket)continue;
    bucket.total++;
    if(page.verified)bucket.verified++;
  }
  return result;
}

const MISSING_ASSET_KIND_LABELS={metric:"指标定义",term:"业务术语",subject:"业务对象",dimension:"分组维度",filter:"筛选口径",time:"时间口径",entity:"机构名录",product:"产品口径"};

// Renders sanitized {kind,label} gap descriptors into user-facing lines.
// Tolerates a missing or malformed field so older responses cannot break the card.
export function missingAssetLines(missingAssets) {
  if(!Array.isArray(missingAssets))return [];
  return missingAssets
    .filter((item)=>item&&typeof item==="object"&&String(item.label||"").trim())
    .map((item)=>({kind:String(item.kind||"facet"),label:String(item.label).trim(),text:`缺少『${String(item.label).trim()}』的${MISSING_ASSET_KIND_LABELS[String(item.kind)]||"业务定义"}`}));
}
