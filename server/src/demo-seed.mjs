import { encryptCredential } from "./crypto.mjs";
import { createSemanticSchemaService } from "./semantic-schema-service.mjs";
import { gradeTable } from "./table-grading.mjs";

const tables = [
  { tableName:"crm_customer", rowEstimate:3_482_600, inboundRelations:4, daysSinceWrite:0, comment:"CRM 客户主档，一客户一行" },
  { tableName:"sales_order", rowEstimate:12_048_200, inboundRelations:3, daysSinceWrite:0, comment:"销售订单，一订单一行" },
  { tableName:"payment_transaction", rowEstimate:24_182_000, inboundRelations:1, daysSinceWrite:0, comment:"支付流水" },
  { tableName:"sales_refund", rowEstimate:861_000, inboundRelations:0, daysSinceWrite:0, comment:"退款记录" },
  { tableName:"channel_config", rowEstimate:142, inboundRelations:1, daysSinceWrite:12, comment:"渠道配置字典" },
  { tableName:"order_history_bak", rowEstimate:9_800_000, inboundRelations:0, daysSinceWrite:724, comment:"历史订单备份" },
];

const columns = {
  crm_customer: [
    ["customer_id","bigint",1,"客户编号"],["customer_type","varchar",0,"客户类型"],["cert_status","tinyint",0,"实名认证状态"],["certified_at","datetime",0,"认证完成时间"],["deleted_at","datetime",0,"软删除时间"],["is_test","tinyint",0,"测试账号"],["mobile","varchar",0,"手机号"],
  ],
  sales_order: [["order_id","bigint",1,"订单编号"],["order_no","varchar",0,"业务订单号"],["customer_id","bigint",0,"客户编号"],["pay_time","datetime",0,"支付时间"],["amount","bigint",0,"订单金额，分"],["status","tinyint",0,"订单状态"]],
  payment_transaction: [["payment_id","bigint",1,"支付流水编号"],["order_no","varchar",0,"订单号"],["channel","varchar",0,"支付渠道"],["pay_status","tinyint",0,"支付状态"],["amount","bigint",0,"支付金额，分"],["paid_at","datetime",0,"支付时间"]],
  sales_refund: [["refund_id","bigint",1,"退款编号"],["refund_no","varchar",0,"业务退款号"],["order_no","varchar",0,"订单号"],["amount","bigint",0,"退款金额，分"],["refund_status","tinyint",0,"退款状态"],["refunded_at","datetime",0,"退款时间"]],
};

export function seedDemo(store, appSecret) {
  let source = store.listSources().find((item)=>item.isDemo);
  if(!source) source = store.createSource({ name:"演示数据源", kind:"demo", host:"localhost", port:3306, dbName:"billing_demo", userName:"readonly_demo", credential:encryptCredential("demo",appSecret), isDemo:true });
  for (const table of tables) {
    const result = gradeTable(table);
    store.upsertTable({ sourceId:source.id, ...table, grade:result.grade, active:result.grade === "C" ? 0 : 1 });
    for (const [columnName,dataType,isPrimary,comment] of columns[table.tableName] || []) {
      store.upsertColumn({ sourceId:source.id, tableName:table.tableName, columnName, dataType, isPrimary, comment, nullable:isPrimary?0:1, isSensitive:0 });
    }
  }
  const customerOrder=store.upsertRelation({sourceId:source.id,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:.997,overlapRatio:.997,status:"confirmed"});
  const orderPayment=store.upsertRelation({sourceId:source.id,fromTable:"payment_transaction",fromCol:"order_no",toTable:"sales_order",toCol:"order_no",cardinality:"N:1",confidence:.992,overlapRatio:.992,status:"confirmed"});
  store.upsertRelation({sourceId:source.id,fromTable:"sales_refund",fromCol:"order_no",toTable:"sales_order",toCol:"order_no",cardinality:"N:1",confidence:.9973,overlapRatio:.9973,status:"review"});
  for (const item of [
    {kind:"金额单位",scope:"global",tableName:"payment_transaction",columnName:"amount",question:"amount 字段是否统一以“分”为单位？",evidence:"采样值中位数 8,900，P95 86,420；18 张表字段类型与分布一致。",options:["全部按分处理","逐表确认","仅支付域按分"]},
    {kind:"JOIN 路径",scope:"table",tableName:"sales_refund",columnName:"order_no",question:"退款记录应通过 order_no 关联销售订单吗？",evidence:"采样 10,000 行值域重叠 99.73%，右侧唯一，推断 N:1。",options:["确认该关联","标记为候选","不允许关联"]},
    {kind:"枚举含义",scope:"column",tableName:"payment_transaction",columnName:"pay_status",enumValue:"30",question:"支付状态 30 是否表示“已退款”？",evidence:"值 30 占 3.8%，99.1% 可找到退款记录。",options:["已退款","退款处理中","补充说明"]},
  ]) store.addQuestion({sourceId:source.id,...item});
  store.addRule({sourceId:source.id,name:"排除测试账号",content:"crm_customer.is_test = 0",appliesTo:"crm_customer",verified:1});
  store.addRule({sourceId:source.id,name:"软删除过滤规则",content:"crm_customer.deleted_at IS NULL",appliesTo:"crm_customer",verified:1});
  for(const page of [
    {pageType:"term",slug:"有效客户",title:"有效客户",aliases:["有效户","实名客户"],tables:["crm_customer"],content:"已完成实名认证且未注销的客户，不含测试账号。",sqlContent:"crm_customer.cert_status = 1 AND crm_customer.deleted_at IS NULL AND crm_customer.is_test = 0",antiExamples:"不要使用 status = 1；它表示登录状态。"},
    {pageType:"metric",slug:"复购率",title:"复购率",aliases:["客户复购率"],tables:["crm_customer","sales_order"],content:"周期内下单不少于两次的有效客户，占当期有下单有效客户的比例。",sqlContent:"SELECT COUNT(DISTINCT CASE WHEN order_cnt >= 2 THEN customer_id END) / COUNT(DISTINCT customer_id) AS repurchase_rate FROM (...) t",antiExamples:"按 pay_time 而不是 create_time 过滤。"},
    {pageType:"metric",slug:"支付成功率",title:"支付成功率",aliases:["支付通过率"],tables:["payment_transaction"],content:"成功支付笔数占全部有效支付尝试的比例。",sqlContent:"SUM(pay_status = 20) / COUNT(*)",antiExamples:"主动关闭的支付单不进入分母。"},
    {pageType:"term",slug:"退款金额",title:"退款金额",aliases:["退费金额"],tables:["sales_refund"],content:"退款成功记录的退款金额，底层单位为分，展示时换算为元。",sqlContent:"sales_refund.amount / 100.0",antiExamples:"退款申请中状态不计入已退款金额。"},
  ]) store.upsertKnowledge({sourceId:source.id,...page,aliases:JSON.stringify(page.aliases),tablesJson:JSON.stringify(page.tables),verified:1,owner:"演示数据维护者",verifiedAt:"2026-08-12T00:00:00.000Z"});
  if(!store.listOntologySchemaVersions(source.id).length) {
    const semanticSchemas=createSemanticSchemaService({store});
    const draft=semanticSchemas.saveDraft(source.id,demoSemanticSchema(customerOrder.id,orderPayment.id),"demo-seed");
    if(draft.validation.ok) semanticSchemas.publish(draft.id,"demo-seed");
  }
}

function demoSemanticSchema(customerOrderRelationId,orderPaymentRelationId) {
  return {
    name:"billing",displayName:"客户交易本体",description:"演示客户、订单和支付的业务对象与物理数据映射",
    objectTypes:[
      {apiName:"customer",displayName:"客户",description:"CRM 客户主档中的业务客户",primaryKey:"customer_id",properties:[
        {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}},
        {apiName:"customer_type",displayName:"客户类型",type:"string",required:false,mapping:{table:"crm_customer",column:"customer_type"}},
        {apiName:"cert_status",displayName:"实名认证状态",type:"integer",required:false,mapping:{table:"crm_customer",column:"cert_status"}},
        {apiName:"is_test",displayName:"测试账号",type:"boolean",required:false,mapping:{table:"crm_customer",column:"is_test"}},
      ]},
      {apiName:"order",displayName:"订单",description:"客户提交的销售订单",primaryKey:"order_id",properties:[
        {apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},
        {apiName:"order_no",displayName:"业务订单号",type:"string",required:true,mapping:{table:"sales_order",column:"order_no"}},
        {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"sales_order",column:"customer_id"}},
        {apiName:"amount",displayName:"订单金额（分）",type:"integer",required:false,constraints:{minimum:0},mapping:{table:"sales_order",column:"amount"}},
        {apiName:"pay_time",displayName:"支付时间",type:"datetime",required:false,mapping:{table:"sales_order",column:"pay_time"}},
      ]},
      {apiName:"payment",displayName:"支付",description:"订单对应的支付流水",primaryKey:"payment_id",properties:[
        {apiName:"payment_id",displayName:"支付流水编号",type:"integer",required:true,mapping:{table:"payment_transaction",column:"payment_id"}},
        {apiName:"order_no",displayName:"业务订单号",type:"string",required:true,mapping:{table:"payment_transaction",column:"order_no"}},
        {apiName:"channel",displayName:"支付渠道",type:"string",required:false,mapping:{table:"payment_transaction",column:"channel"}},
        {apiName:"amount",displayName:"支付金额（分）",type:"integer",required:false,constraints:{minimum:0},mapping:{table:"payment_transaction",column:"amount"}},
        {apiName:"paid_at",displayName:"支付时间",type:"datetime",required:false,mapping:{table:"payment_transaction",column:"paid_at"}},
      ]},
    ],
    linkTypes:[
      {apiName:"places_order",displayName:"客户下单",source:"customer",target:"order",cardinality:"one_to_many",sourceLabel:"订单",targetLabel:"客户",relationMappings:[{relationId:customerOrderRelationId}]},
      {apiName:"has_payment",displayName:"订单支付",source:"order",target:"payment",cardinality:"one_to_many",sourceLabel:"支付流水",targetLabel:"订单",relationMappings:[{relationId:orderPaymentRelationId}]},
    ],
  };
}
