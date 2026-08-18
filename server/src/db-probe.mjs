import { detectSensitiveField } from "./sensitive-fields.mjs";
import { buildColumnProfile } from "./column-profile.mjs";

const TIME_TYPE = /date|time|timestamp/i;
const LOW_CARDINALITY_TYPE = /tinyint|enum|boolean|bool|char|varchar/i;
const DEFAULT_SAMPLE_ROWS = 10_000;

function quoteIdentifier(value) {
  const identifier=String(value??"");
  if (!identifier || identifier.length>64 || /[\0\r\n]/.test(identifier)) throw new Error(`无效的数据库标识符：${identifier}`);
  return `\`${identifier.replaceAll("`","``")}\``;
}

export async function probeTable(connector, source, table, columns, { maxEnumValues=20, sampleRows=DEFAULT_SAMPLE_ROWS, profiling={} } = {}) {
  const tableName = quoteIdentifier(table.tableName);
  const sampleLimit = Math.max(1,Math.floor(Number(sampleRows)||DEFAULT_SAMPLE_ROWS));
  const results = [];
  const timeColumn = columns.find((column)=>TIME_TYPE.test(column.dataType) && /(?:updated?|modified|created|paid|refund).*?(?:at|time|date)$/i.test(column.columnName));
  const estimatedRows = Number(table.rowEstimate)||0;
  let lastWrite = table.updateTime??null;
  if (timeColumn && estimatedRows > 0 && estimatedRows <= sampleLimit) {
    try { const [rows] = await connector.query(source,`SELECT MAX(${quoteIdentifier(timeColumn.columnName)}) AS lastWrite FROM ${tableName}`); lastWrite=rows[0]?.lastWrite??null; } catch { /* Degrade to schema only. */ }
  }
  for (const column of columns) {
    const sensitive = detectSensitiveField(column.columnName,[],column.comment);
    const item = { ...column, isSensitive:sensitive.sensitive?1:0, sensitiveReason:sensitive.reason, nullRate:null, cardinality:null, enums:[] };
    if (!sensitive.sensitive && LOW_CARDINALITY_TYPE.test(column.dataType)) {
      try {
        const col = quoteIdentifier(column.columnName);
        const [rows] = await connector.query(source,`SELECT ${col} AS value, COUNT(*) AS count FROM (SELECT ${col} FROM ${tableName} WHERE ${col} IS NOT NULL LIMIT ${sampleLimit}) AS ontoquery_sample GROUP BY ${col} ORDER BY count DESC LIMIT ${Number(maxEnumValues)+1}`);
        if (rows.length && rows.length <= maxEnumValues) {
          const total = rows.reduce((sum,row)=>sum+Number(row.count),0);
          item.cardinality=rows.length;
          item.enums=rows.map((row)=>({value:String(row.value),count:Number(row.count),ratio:total?Number(row.count)/total:0}));
        }
      } catch { /* Individual probes are best effort and sequential. */ }
    }
    results.push(item);
  }
  if(profiling?.enabled)await attachProfiles(connector,source,table,results,{sampleLimit:profiling.sampleLimit,timeoutMs:profiling.timeoutMs});
  return { columns:results, lastWrite };
}

async function attachProfiles(connector,source,table,columns,{sampleLimit,timeoutMs}={}) {
  const safeLimit=Math.max(1,Math.min(1000,Math.floor(Number(sampleLimit)||1000)));
  const sampled=columns.filter((column)=>!column.isSensitive&&!column.enums?.length);
  let rows=[];
  let sampledOk=sampled.length===0;
  if(sampled.length) {
    const select=sampled.map((column)=>quoteIdentifier(column.columnName)).join(", ");
    const orderColumn=columns.find((column)=>column.isPrimary)||columns.find((column)=>TIME_TYPE.test(column.dataType)&&/(?:updated?|modified|created|paid|refund).*?(?:at|time|date)$/i.test(column.columnName));
    const order=orderColumn?` ORDER BY ${quoteIdentifier(orderColumn.columnName)} DESC`:"";
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(100,Number(timeoutMs)||10_000));
    try { [rows]=await connector.query(source,`SELECT ${select} FROM ${quoteIdentifier(table.tableName)}${order} LIMIT ${safeLimit}`,[],controller.signal);sampledOk=true; }
    catch { rows=[];sampledOk=false; }
    finally { clearTimeout(timer); }
  }
  for(const column of columns) {
    if(column.isSensitive){column.profile=null;continue;}
    if(!column.enums?.length&&!sampledOk){column.profile=null;continue;}
    const values=column.enums?.length?[]:rows.map((row)=>row?.[column.columnName]);
    column.profile=buildColumnProfile({values,dataType:column.dataType,enums:column.enums});
  }
}

export const dbProbeInternal={quoteIdentifier,attachProfiles};
