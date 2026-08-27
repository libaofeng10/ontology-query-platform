import { ENUM_NAME_BLACKLIST } from "./db-probe.mjs";

export const ENUM_DICTIONARY_RULE_VERSION="enum-dictionary-v2-identifier-blacklist";
const SETTING_KEY="system.enumDictionaryRuleVersion";

// Cleans up dictionaries registered before probeTable learned to reject identifier-shaped
// columns. Only the naming blacklist is applied: cardinality-ratio cleanup would need row
// estimates from a probe run, and re-probing is the operator's call, not a migration's.
export function applyEnumCatalogMigration(store) {
  if(!store)throw new Error("enum catalog migration 需要 store");
  const current=readVersion(store.getSetting(SETTING_KEY));
  if(current===ENUM_DICTIONARY_RULE_VERSION)return {version:ENUM_DICTIONARY_RULE_VERSION,previousVersion:current,scannedColumns:0,removedColumns:0,removedValues:0,removedHumanMeanings:0,affectedSources:[],skipped:true};
  const registered=store.listEnumColumns();
  const doomed=registered.filter((item)=>ENUM_NAME_BLACKLIST.test(String(item.columnName??"")));
  const removedValues=store.deleteEnumColumns(doomed.map(({sourceId,tableName,columnName})=>({sourceId,tableName,columnName})));
  store.upsertSetting({key:SETTING_KEY,valueJson:JSON.stringify(ENUM_DICTIONARY_RULE_VERSION),encrypted:0,updatedBy:"system:enum-catalog-migration"});
  return {
    version:ENUM_DICTIONARY_RULE_VERSION,
    previousVersion:current,
    scannedColumns:registered.length,
    removedColumns:doomed.length,
    removedValues,
    removedHumanMeanings:doomed.reduce((sum,item)=>sum+Number(item.humanMeaningCount||0),0),
    affectedSources:[...new Set(doomed.map((item)=>item.sourceId))].sort((left,right)=>left-right),
    skipped:false,
  };
}

function readVersion(row){if(!row?.valueJson)return null;try{return JSON.parse(row.valueJson);}catch{return null;}}
