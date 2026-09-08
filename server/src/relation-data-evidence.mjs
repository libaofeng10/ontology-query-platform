// SQL performs the equality comparison, preserving the database's type/collation semantics.
// Both sides count complete matching tuples; only sampled keys and returned rows are bounded.
export async function sampleRelationEvidence(connector,source,left,right,limit,{timeoutMs=10_000,stratify=false,columns=[],maxQueries=4,round=0}={}) {
  const sampleLimit=Math.max(1,Math.min(2000,Math.floor(Number(limit)||500)));
  const configuredTimeout=Number(timeoutMs);
  const executionTimeoutMs=Number.isFinite(configuredTimeout)?Math.max(100,Math.min(4_294_967_295,Math.floor(configuredTimeout))):10_000;
  const deadlineAt=performance.now()+executionTimeoutMs;
  const sampledAt=new Date().toISOString();
  const base={method:stratify?"source_stratified_target_lookup":"source_extremes_target_lookup",scope:"sample",sampledAt,sampleLimit,round,strata:[],strataFailures:[],queryCount:0,sourceMultipleMatchCount:null,sourceMaxMatches:null};
  const from=quoteIdentifier(left.tableName),to=quoteIdentifier(right.tableName);
  const fromCols=(left.columnNames||[left.columnName]).map(quoteIdentifier),toCols=(right.columnNames||[right.columnName]).map(quoteIdentifier);
  if(!fromCols.length||fromCols.length!==toCols.length||fromCols.length>8)throw new Error("关系采样的列组不完整");
  const alias=index=>index?`value${index}`:"value";
  const projection=fromCols.map((column,index)=>`${column} AS ${alias(index)}`).join(", "),nonnull=fromCols.map(column=>`${column} IS NOT NULL`).join(" AND ");
  const order=direction=>fromCols.map(column=>`${column} ${direction}`).join(", ");
  // A second round changes the ordering, so increasing LIMIT does not merely repeat extremes.
  const hashOrder=direction=>`CRC32(CONCAT_WS('#', ${Math.max(0,Math.floor(Number(round)||0))}, ${fromCols.join(", ")})) ${direction}, ${order(direction)}`;
  const part=(predicate,count,direction="ASC")=>`(SELECT DISTINCT ${projection} FROM ${from} WHERE ${nonnull}${predicate?` AND ${predicate}`:""} ORDER BY ${round?hashOrder(direction):order(direction)} LIMIT ${count})`;
  const controller=new AbortController();let timer;
  const unavailable=(reason)=>({...base,status:"unavailable",reason,sampleSize:null,matchRatio:null});
  // Closing a client connection can leave its SELECT running on MySQL 5.7.
  // Put the remaining deadline on the first SELECT of every statement: the hint
  // covers the entire UNION/subquery and also stops work after client cancellation.
  const query=(sql,params=[])=>connector.query(source,sql.replace(/\bSELECT\b/,`SELECT /*+ MAX_EXECUTION_TIME(${Math.max(1,Math.floor(deadlineAt-performance.now()))}) */`),params,controller.signal);
  const work=(async()=>{
    const predicates=[],params=[];
    const queryBudget=Math.max(1,Math.min(7,Math.floor(Number(maxQueries)||4)));
    const strata=stratify?chooseStrata(columns.filter(column=>column.tableName===left.tableName)).slice(0,Math.min(3,queryBudget-1,sampleLimit-1)):[];
    for(const column of strata){
      if(controller.signal.aborted)break;
      const quoted=quoteIdentifier(column.columnName),expression=/date|time/i.test(column.dataType)?`DATE_FORMAT(${quoted}, '%Y-%m')`:quoted;
      const select=direction=>`(SELECT DISTINCT ${expression} AS stratum FROM ${from} WHERE ${quoted} IS NOT NULL ORDER BY stratum ${direction} LIMIT 2)`;
      try{
        base.queryCount++;
        const [values]=await query(`${select("ASC")} UNION ${select("DESC")}`);
        if(controller.signal.aborted)return unavailable("timeout");
        const selected=[...new Set((values||[]).map(row=>row.stratum).filter(value=>typeof value==="string"||typeof value==="number"))].slice(0,4);
        if(!selected.length)continue;
        // Keep strata distinct in the source subqueries, then UNION tuples in SQL. The
        // database deduplicates with its own collation; JS never approximates equality.
        predicates.push(...selected.map(()=>`${expression} = ?`));params.push(...selected);
        base.strata.push({column:column.columnName,kind:/date|time/i.test(column.dataType)?"month":"category",valueCount:selected.length});
      }catch{base.strataFailures.push(column.columnName);}
    }
    const parts=[],bound=[];
    if(controller.signal.aborted)return unavailable("timeout");
    base.method=base.strata.length?"source_stratified_target_lookup":round?"source_hash_target_lookup":"source_extremes_target_lookup";
    const budgetPerPart=Math.max(1,Math.floor(sampleLimit/(predicates.length+2)));
    let remaining=sampleLimit;
    for(let index=0;index<predicates.length&&remaining>2;index++){
      const count=Math.min(budgetPerPart,remaining-2);parts.push(part(predicates[index],count));bound.push(params[index]);remaining-=count;
    }
    if(remaining){const low=Math.ceil(remaining/2),high=Math.floor(remaining/2);parts.push(part("",low));if(high)parts.push(part("",high,"DESC"));}
    const sql=`SELECT ${fromCols.map((_,index)=>`sampled.${alias(index)}`).join(", ")}, (SELECT COUNT(*) FROM ${to} AS target WHERE ${toCols.map((column,index)=>`target.${column} = sampled.${alias(index)}`).join(" AND ")}) AS matchCount, (SELECT COUNT(*) FROM ${from} AS source_rows WHERE ${fromCols.map((column,index)=>`source_rows.${column} = sampled.${alias(index)}`).join(" AND ")}) AS sourceCount FROM (${parts.join(" UNION ")}) AS sampled`;
    base.queryCount++;
    const [rows]=await query(sql,bound);
    if(!Array.isArray(rows)||rows.length>sampleLimit||rows.some(row=>!Number.isSafeInteger(Number(row.matchCount))||row.matchCount==null||Number(row.matchCount)<0))return unavailable("invalid_probe_result");
    // Legacy connector results have no source count. Missing evidence stays unknown;
    // a partial/malformed new result cannot be treated as a zero-duplicate sample.
    const hasSourceCounts=rows.some(row=>Object.hasOwn(row,"sourceCount"));
    if(hasSourceCounts&&rows.some(row=>row.sourceCount==null||!Number.isSafeInteger(Number(row.sourceCount))||Number(row.sourceCount)<1))return unavailable("invalid_probe_result");
    const matchedRows=rows.filter(row=>Number(row.matchCount)>0);
    const sourceMultipleMatchCount=hasSourceCounts?matchedRows.filter(row=>Number(row.sourceCount)>1).length:null;
    const sourceMaxMatches=hasSourceCounts?Math.max(0,...matchedRows.map(row=>Number(row.sourceCount))):null;
    const sampleSize=rows.length,matchedCount=rows.filter(row=>Number(row.matchCount)>0).length,multipleMatchCount=rows.filter(row=>Number(row.matchCount)>1).length;
    return {...base,status:sampleSize?"sampled":"empty",sampleSize,matchedCount,multipleMatchCount,maxMatches:Math.max(0,...rows.map(row=>Number(row.matchCount))),sourceMultipleMatchCount,sourceMaxMatches,matchRatio:sampleSize?matchedCount/sampleSize:null,orphanRatio:sampleSize?1-matchedCount/sampleSize:null};
  })().catch(error=>unavailable(controller.signal.aborted||["ER_QUERY_TIMEOUT","QUERY_TIMEOUT"].includes(error?.code)?"timeout":"query_failed"));
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable("timeout"));},executionTimeoutMs);});
  try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer);}
}

function chooseStrata(columns){
  const choices=[
    columns.find(column=>/(?:^|_)(tenant|org|company)(?:_id|_code)?$/i.test(column.columnName)),
    columns.find(column=>/(?:^|_)(status|state|type)$/i.test(column.columnName)),
    columns.find(column=>/date|time/i.test(column.dataType)&&/(creat|occur|event|order|time|date)/i.test(column.columnName)),
  ];
  return [...new Set(choices.filter(Boolean))];
}

export async function sampleRelationOverlap(...args) {return (await sampleRelationEvidence(...args)).matchRatio;}
function quoteIdentifier(value){const text=String(value??"");if(!text||text.length>64||/[\0\r\n]/.test(text))throw new Error("无效的数据库标识符");return `\`${text.replaceAll("`","``")}\``;}

export function describeRelationEvidence(relation){
  const evidence=relation.dataEvidence;
  if(!evidence)return relation.inferenceSource==="foreign_key"?"依据数据库外键约束；未执行数据匹配采样":relation.overlapRatio==null?"未取得数据匹配样本":`源值样本匹配率 ${(relation.overlapRatio*100).toFixed(2)}%（历史采样方式未记录）`;
  if(evidence.status!=="sampled")return `数据采样${evidence.status==="empty"?"为空":"不可用"}（${evidence.reason||evidence.status}）`;
  const sourceEvidence=Number.isSafeInteger(evidence.sourceMultipleMatchCount)?`已匹配元组中，源端重复 ${evidence.sourceMultipleMatchCount} 组，最多 ${evidence.sourceMaxMatches} 行；`:"";
  return `源值样本 ${evidence.sampleSize} 个，目标匹配 ${evidence.matchedCount} 个，重复匹配 ${evidence.multipleMatchCount} 个；${sourceEvidence}匹配率 ${(evidence.matchRatio*100).toFixed(2)}%。${evidence.method==="source_stratified_target_lookup"?`按 ${(evidence.strata||[]).map(item=>item.column).join("、")} 分层取样`:evidence.method==="source_hash_target_lookup"?"按哈希顺序补采样":"取源值两端"}后查询完整目标，采样于 ${evidence.sampledAt}${evidence.history?.length?`；已补采样 ${evidence.history.length} 轮`:""}；不代表全表统计`;
}
