import { createHash } from "node:crypto";
import { detectSensitiveField } from "./sensitive-fields.mjs";

const REFERENCE_SUFFIX = /(?:^|_)(id|no|code|key|uuid)$/i;
const GENERIC_TABLE_TOKENS = new Set(["t", "tbl", "table", "sys", "biz", "data", "info", "base", "dim", "fact", "record", "records", "detail", "details"]);
const SELF_REFERENCE_STEMS = new Set(["parent", "root", "upper", "previous", "prev"]);

/**
 * Builds a bounded, table-balanced candidate set before any model call.
 * Generic primary-key pairs such as unrelated `id = id` are deliberately excluded.
 */
export function generateRelationCandidates({schema, eligibleTableNames, maxCandidates=600, maxTargetsPerColumn=4}) {
  const eligible=new Set(eligibleTableNames || schema.tables.map((table)=>table.tableName));
  const tables=(schema.tables||[]).filter((table)=>eligible.has(table.tableName));
  const columnsByTable=Object.groupBy((schema.columns||[]).filter((column)=>eligible.has(column.tableName)),(column)=>column.tableName);
  const targetColumnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,(columnsByTable[table.tableName]||[]).filter((column)=>!detectSensitiveField(column.columnName).sensitive&&Boolean(column.isPrimary||column.isUnique||column.isIndexed))]));
  const candidates=new Map();

  for(const sourceTable of tables) {
    const sourceColumns=columnsByTable[sourceTable.tableName]||[];
    for(const sourceColumn of sourceColumns) {
      const reference=referenceStem(sourceColumn.columnName);
      if(!reference || sourceColumn.isPrimary || detectSensitiveField(sourceColumn.columnName).sensitive) continue;
      const ranked=[];
      for(const targetTable of tables) {
        const semanticScore=tableSemanticScore(reference.stem,sourceColumn,sourceTable,targetTable);
        const isSelf=sourceTable.tableName===targetTable.tableName;
        if(isSelf&&!SELF_REFERENCE_STEMS.has(reference.stem)) continue;
        for(const targetColumn of targetColumnsByTable[targetTable.tableName]) {
          const sameColumn=normalizeName(targetColumn.columnName)===normalizeName(sourceColumn.columnName);
          const targetIsKey=Boolean(targetColumn.isPrimary||targetColumn.isUnique);
          const genericId=normalizeName(sourceColumn.columnName)==="id"&&normalizeName(targetColumn.columnName)==="id";
          if(genericId || (!targetIsKey&&!(sameColumn&&targetColumn.isIndexed))) continue;
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
            `字段后缀 ${reference.suffix}`,
            semanticReason(reference.stem,targetTable.tableName,semanticScore),
            targetColumn.isPrimary?"目标字段为主键":targetColumn.isUnique?"目标字段有唯一索引":"目标字段已建索引",
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

  return fairLimit([...candidates.values()],maxCandidates);
}

function makeCandidate(fromTable,fromColumn,toTable,toColumn,structuralScore,reasons) {
  const key=`${fromTable.tableName}.${fromColumn.columnName}>${toTable.tableName}.${toColumn.columnName}`;
  return {
    id:`rel_${createHash("sha256").update(key).digest("hex").slice(0,16)}`,
    key,
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
