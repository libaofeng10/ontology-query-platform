import { detectSensitiveField } from "./sensitive-fields.mjs";

export const SENSITIVE_FIELD_RULE_VERSION="sensitive-fields-v2-email-person-name-comments";
const SETTING_KEY="system.sensitiveFieldRuleVersion";

export function applySensitiveCatalogMigration(store) {
  if(!store)throw new Error("sensitive catalog migration 需要 store");
  const current=readVersion(store.getSetting(SETTING_KEY));
  if(current===SENSITIVE_FIELD_RULE_VERSION)return {version:SENSITIVE_FIELD_RULE_VERSION,previousVersion:current,scannedColumns:0,promotedColumns:0,affectedSources:[],skipped:true};
  const promotions=[];let scannedColumns=0;
  for(const source of store.listSources())for(const table of store.listTables(source.id))for(const column of store.listColumns(source.id,table.tableName)){
    scannedColumns++;
    if(column.isSensitive)continue;
    const detected=detectSensitiveField(column.columnName,[],column.comment);
    if(detected.sensitive)promotions.push({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,reason:detected.reason});
  }
  const promotedColumns=store.promoteSensitiveColumns(promotions);
  store.upsertSetting({key:SETTING_KEY,valueJson:JSON.stringify(SENSITIVE_FIELD_RULE_VERSION),encrypted:0,updatedBy:"system:sensitive-catalog-migration"});
  return {version:SENSITIVE_FIELD_RULE_VERSION,previousVersion:current,scannedColumns,promotedColumns,affectedSources:[...new Set(promotions.map((item)=>item.sourceId))].sort((left,right)=>left-right),skipped:false};
}

function readVersion(row){if(!row?.valueJson)return null;try{return JSON.parse(row.valueJson);}catch{return null;}}
