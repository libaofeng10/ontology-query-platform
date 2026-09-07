import { createHash } from "node:crypto";
import { relationKey, relationPairs } from "./physical-relation.mjs";
import { columnsAreUnique, uniqueColumnSets } from "./catalog-identity.mjs";

const REFERENCE_SUFFIX = /(?:^|_)(id|no|code|key|uuid)$/i;
const GENERIC_TABLE_TOKENS = new Set(["t", "tbl", "table", "sys", "biz", "data", "info", "base", "dim", "fact", "record", "records", "detail", "details"]);
const SELF_REFERENCE_STEMS = new Set(["parent", "root", "upper", "previous", "prev", "manager", "supervisor"]);

/**
 * Builds a bounded, table-balanced candidate set before any model call.
 * Generic primary-key pairs such as unrelated `id = id` are deliberately excluded.
 */
export function generateRelationCandidates({schema, eligibleTableNames, maxCandidates=600, maxTargetsPerColumn=4}) {
  const eligible=new Set(eligibleTableNames || schema.tables.map((table)=>table.tableName));
  const tables=(schema.tables||[]).filter((table)=>eligible.has(table.tableName));
  const columnsByTable=Object.groupBy((schema.columns||[]).filter((column)=>eligible.has(column.tableName)),(column)=>column.tableName);
  const targetColumnsByTable=columnsByTable;
  const uniqueKeysByTable=Object.fromEntries(Object.entries(columnsByTable).map(([name,columns])=>[name,uniqueColumnSets(columns)]));
  const candidates=new Map();

  for(const sourceTable of tables) {
    const sourceColumns=columnsByTable[sourceTable.tableName]||[];
    for(const sourceColumn of sourceColumns) {
      const reference=referenceStem(sourceColumn.columnName)||{stem:normalizeName(sourceColumn.columnName),suffix:"semantic"};
      const ranked=[];
      for(const targetTable of tables) {
        const semanticScore=tableSemanticScore(reference.stem,sourceColumn,sourceTable,targetTable);
        const isSelf=sourceTable.tableName===targetTable.tableName;
        if(isSelf&&!SELF_REFERENCE_STEMS.has(reference.stem)) continue;
        for(const targetColumn of targetColumnsByTable[targetTable.tableName]||[]) {
          const sameColumn=normalizeName(targetColumn.columnName)===normalizeName(sourceColumn.columnName);
          const targetIsKey=Boolean(targetColumn.isPrimary||targetColumn.isUnique);
          if(!targetIsKey&&(uniqueKeysByTable[targetTable.tableName]||[]).some(key=>key.length>1&&key.includes(targetColumn.columnName)))continue;
          const genericId=normalizeName(sourceColumn.columnName)==="id"&&normalizeName(targetColumn.columnName)==="id";
          const unindexedSemanticKey=semanticScore>=0.55&&(normalizeName(targetColumn.columnName)==="id"||sameColumn);
          if(genericId || (!targetIsKey&&!(sameColumn&&targetColumn.isIndexed)&&!unindexedSemanticKey)) continue;
          if(isSelf&&sameColumn)continue;
          if((reference.suffix==="semantic"||sourceColumn.isPrimary)&&semanticScore<0.55)continue;
          if(semanticScore<0.18&&!sameColumn) continue;

          const typeCompatible=compatibleType(sourceColumn.dataType,targetColumn.dataType);
          if(!typeCompatible) continue;
          const targetName=normalizeName(targetColumn.columnName);
          const keyNameScore=targetName==="id"||targetName===reference.suffix?0.11:sameColumn?0.13:0.04;
          const structuralScore=clamp(
            0.18 + semanticScore*0.44 + (targetColumn.isPrimary?0.14:targetColumn.isUnique?0.11:0.05)
            + (sourceColumn.isIndexed?0.05:0) + keyNameScore + (sameColumn?0.08:0) + 0.06,
          );
          const reasons=[
            reference.suffix==="semantic"?"字段名称或注释有业务引用语义":`字段后缀 ${reference.suffix}`,
            semanticReason(reference.stem,targetTable.tableName,semanticScore),
            targetColumn.isPrimary?"目标字段为主键":targetColumn.isUnique?"目标字段有唯一索引":targetColumn.isIndexed?"目标字段已建索引":"目标没有唯一性约束，需验证实际匹配",
            sameColumn?"字段名完全一致":null,
            "字段类型兼容",
          ].filter(Boolean);
          ranked.push(makeCandidate(sourceTable,sourceColumn,targetTable,targetColumn,structuralScore,reasons));
        }
      }
      ranked.sort(compareCandidate);
      for(const candidate of ranked.slice(0,maxTargetsPerColumn)) candidates.set(candidate.key,candidate);
    }
  }

  for(const targetTable of tables){
    const targetColumns=columnsByTable[targetTable.tableName]||[];
    for(const key of uniqueColumnSets(targetColumns).filter(key=>key.length>1&&key.length<=8)){
      for(const sourceTable of tables){
        if(sourceTable.tableName===targetTable.tableName)continue;
        const sourceColumns=columnsByTable[sourceTable.tableName]||[];
        const pairs=key.map(toCol=>{
          const target=targetColumns.find(column=>column.columnName===toCol);
          const options=sourceColumns.filter(column=>compatibleType(column.dataType,target.dataType)&&(
            column.columnName===toCol||normalizeName(column.columnName)===`${singular(normalizeName(targetTable.tableName))}_${normalizeName(toCol)}`||
            (referenceStem(column.columnName)?.suffix===toCol&&tableSemanticScore(referenceStem(column.columnName).stem,column,sourceTable,targetTable)>=.55)
          ));
          return options.length===1?{fromCol:options[0].columnName,toCol}:null;
        });
        if(pairs.some(pair=>!pair)||pairs.every(pair=>pair.fromCol===pair.toCol&&/^(tenant|org|company)_id$|^id$/i.test(pair.fromCol)))continue;
        const candidate=validateRelationProposal({fromTable:sourceTable.tableName,toTable:targetTable.tableName,columnPairs:pairs,reason:"匹配完整联合唯一键，需验证元组与业务语义"},{schema,eligibleTableNames,origin:"rule",structuralScore:.65});
        if(candidate)candidates.set(candidate.key,candidate);
      }
    }
  }
  return fairLimit([...candidates.values()],maxCandidates);
}

export function validateRelationProposal(raw,{schema,eligibleTableNames,origin="model_proposal",structuralScore=.35}) {
  const eligible=new Set(eligibleTableNames||schema.tables.map(table=>table.tableName));
  if(!eligible.has(raw?.fromTable)||!eligible.has(raw?.toTable)||typeof raw.reason!=="string"||!raw.reason.trim())return null;
  let pairs;try{pairs=relationPairs(raw);}catch{return null;}
  if(pairs.length>8||new Set(pairs.map(pair=>pair.fromCol)).size!==pairs.length||new Set(pairs.map(pair=>pair.toCol)).size!==pairs.length)return null;
  if(raw.fromTable===raw.toTable&&pairs.every(pair=>pair.fromCol===pair.toCol))return null;
  const side=(tableName,field)=>{
    const table=schema.tables.find(table=>table.tableName===tableName);
    const all=schema.columns.filter(column=>column.tableName===tableName);
    const columns=pairs.map(pair=>all.find(column=>column.columnName===pair[field]));
    if(!table||columns.some(column=>!column))return null;
    return {tableName,tableComment:table.comment||null,...columns[0],columnName:columns[0].columnName,columnNames:columns.map(column=>column.columnName),columns,isUnique:columnsAreUnique(all,columns.map(column=>column.columnName))};
  };
  const from=side(raw.fromTable,"fromCol"),to=side(raw.toTable,"toCol");
  if(!from||!to||from.columns.some((column,index)=>!compatibleType(column.dataType,to.columns[index].dataType)))return null;
  if(!to.isUnique&&uniqueColumnSets(schema.columns.filter(column=>column.tableName===raw.toTable)).some(key=>to.columnNames.length<key.length&&to.columnNames.every(name=>key.includes(name))))return null;
  const key=relationKey({...raw,columnPairs:pairs});
  return {id:`rel_${createHash("sha256").update(key).digest("hex").slice(0,16)}`,key,from,to,columnPairs:pairs,origin,structuralScore,structuralReasons:[raw.reason.trim().slice(0,1000)]};
}

function makeCandidate(fromTable,fromColumn,toTable,toColumn,structuralScore,reasons) {
  const key=`${fromTable.tableName}.${fromColumn.columnName}>${toTable.tableName}.${toColumn.columnName}`;
  return {
    id:`rel_${createHash("sha256").update(key).digest("hex").slice(0,16)}`,
    key,
    columnPairs:[{fromCol:fromColumn.columnName,toCol:toColumn.columnName}],origin:"rule",
    from:{tableName:fromTable.tableName,tableComment:fromTable.comment||null,columnName:fromColumn.columnName,columnComment:fromColumn.comment||null,dataType:fromColumn.dataType,isPrimary:Boolean(fromColumn.isPrimary),isUnique:Boolean(fromColumn.isUnique),isIndexed:Boolean(fromColumn.isIndexed)},
    to:{tableName:toTable.tableName,tableComment:toTable.comment||null,columnName:toColumn.columnName,columnComment:toColumn.comment||null,dataType:toColumn.dataType,isPrimary:Boolean(toColumn.isPrimary),isUnique:Boolean(toColumn.isUnique),isIndexed:Boolean(toColumn.isIndexed)},
    structuralScore:Number(structuralScore.toFixed(4)),
    structuralReasons:reasons,
  };
}

function fairLimit(candidates,maxCandidates) {
  if(candidates.length<=maxCandidates) return candidates.sort(compareCandidate);
  const groups=Object.groupBy(candidates,(candidate)=>candidate.from.tableName);
  const queues=Object.values(groups).map((items)=>items.sort(compareCandidate));
  const selected=[];
  while(selected.length<maxCandidates) {
    const active=queues.filter((queue)=>queue.length).sort((left,right)=>compareCandidate(left[0],right[0]));
    if(!active.length) break;
    for(const queue of active) {
      if(selected.length>=maxCandidates) break;
      selected.push(queue.shift());
    }
  }
  return selected;
}

function referenceStem(columnName) {
  const normalized=normalizeName(columnName);
  const match=normalized.match(REFERENCE_SUFFIX);
  if(!match) return null;
  const stem=normalized.slice(0,match.index).replace(/_+$/g,"");
  if(!stem) return null;
  return {stem,suffix:match[1].toLowerCase()};
}

function tableSemanticScore(stem,sourceColumn,sourceTable,targetTable) {
  if(sourceTable.tableName===targetTable.tableName&&SELF_REFERENCE_STEMS.has(stem)) return 1;
  const normalizedTable=singular(normalizeName(targetTable.tableName));
  const normalizedStem=singular(stem);
  if(normalizedTable===normalizedStem) return 1;
  if(normalizedTable.endsWith(`_${normalizedStem}`)||normalizedStem.endsWith(`_${normalizedTable}`)) return 0.9;
  const stemTokens=meaningfulTokens(normalizedStem);
  const tableTokens=meaningfulTokens(normalizedTable);
  const shared=stemTokens.filter((token)=>tableTokens.includes(token));
  let score=stemTokens.length?shared.length/stemTokens.length*0.68:0;
  if(shared.some((token)=>token.length>=5)) score+=0.08;
  const columnComment=normalizeText(sourceColumn.comment);
  const tableComment=normalizeText(targetTable.comment);
  if(columnComment&&tableComment&&(columnComment.includes(tableComment)||tableComment.includes(columnComment))) score=Math.max(score,0.55);
  return clamp(score);
}

function semanticReason(stem,tableName,score) {
  return score>=0.85?`引用语义 ${stem} 与目标表 ${tableName} 高度匹配`:`引用语义 ${stem} 与目标表 ${tableName} 存在词元匹配`;
}

function meaningfulTokens(value) { return singular(value).split("_").filter((token)=>token&&!GENERIC_TABLE_TOKENS.has(token)); }
function normalizeName(value) { return String(value||"").replace(/([a-z0-9])([A-Z])/g,"$1_$2").replace(/[^A-Za-z0-9]+/g,"_").replace(/^_+|_+$/g,"").toLowerCase(); }
function normalizeText(value) { return String(value||"").replace(/\s+/g,"").toLowerCase(); }
function singular(value) { return value.split("_").map((token)=>token.length>3&&token.endsWith("ies")?`${token.slice(0,-3)}y`:token.length>3&&token.endsWith("s")?token.slice(0,-1):token).join("_"); }
function compatibleType(left,right) { const family=(value)=>/char|text|enum|set/i.test(value)?"text":/int|decimal|numeric|float|double|bit/i.test(value)?"number":/binary|blob/i.test(value)?"binary":String(value||"").toLowerCase();return family(left)===family(right); }
function compareCandidate(left,right) { return right.structuralScore-left.structuralScore||left.id.localeCompare(right.id); }
function clamp(value) { return Math.max(0,Math.min(1,value)); }

export const _internal={referenceStem,tableSemanticScore,compatibleType,fairLimit};
