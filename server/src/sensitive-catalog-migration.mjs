export const SENSITIVE_FIELD_RULE_VERSION="sensitive-fields-disabled-2026-09-04";
const SETTING_KEY="system.sensitiveFieldRuleVersion";

// 2026-09-04 应用户要求移除敏感列逻辑：迁移改为 no-op，不再自动把手机号/邮箱等
// 列提升为 isSensitive。已有的 isSensitive 标记留在目录里（不再被查询链消费）。
export function applySensitiveCatalogMigration(store) {
  if(!store)throw new Error("sensitive catalog migration 需要 store");
  const current=readVersion(store.getSetting(SETTING_KEY));
  if(current!==SENSITIVE_FIELD_RULE_VERSION)store.upsertSetting({key:SETTING_KEY,valueJson:JSON.stringify(SENSITIVE_FIELD_RULE_VERSION),encrypted:0,updatedBy:"system:sensitive-catalog-migration"});
  return {version:SENSITIVE_FIELD_RULE_VERSION,previousVersion:current,scannedColumns:0,promotedColumns:0,affectedSources:[],skipped:true};
}

function readVersion(row){if(!row?.valueJson)return null;try{return JSON.parse(row.valueJson);}catch{return null;}}
