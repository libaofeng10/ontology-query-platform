import type { OntologyQuestion, QueryAnswer } from "./types";

export const NAV_ITEMS = [
  { id: "query", label: "问数工作台", hint: "自然语言分析" },
  { id: "discovery", label: "数据探查", hint: "结构与分级" },
  { id: "questions", label: "消歧队列", hint: "12 个待确认" },
  { id: "knowledge", label: "知识资产", hint: "本体与口径" },
  { id: "evaluation", label: "评测中心", hint: "准确率回归" },
  { id: "audit", label: "审计日志", hint: "全链路追溯" },
] as const;

export const QUERY_SUGGESTIONS = [
  "今年每月有效客户数和环比趋势",
  "7 月复购率最高的客户类型",
  "近 30 天支付成功率，按渠道对比",
  "退款金额异常增长发生在哪一天",
];

export const DEFAULT_ANSWER: QueryAnswer = {
  id: "demo-20260812-01",
  question: "今年每月有效客户数和环比趋势",
  conclusion: "7 月有效客户达到 12.8 万，较 6 月增长 9.4%，连续第三个月上升。",
  delta: "+9.4% 环比",
  columns: [
    { key: "month", label: "月份", type: "text" },
    { key: "customers", label: "有效客户", type: "number" },
    { key: "growth", label: "环比", type: "percent" },
  ],
  rows: [
    { month: "2026-02", customers: 98420, growth: -1.8 },
    { month: "2026-03", customers: 103680, growth: 5.3 },
    { month: "2026-04", customers: 108240, growth: 4.4 },
    { month: "2026-05", customers: 113560, growth: 4.9 },
    { month: "2026-06", customers: 117180, growth: 3.2 },
    { month: "2026-07", customers: 128240, growth: 9.4 },
  ],
  chart: { type: "line", xKey: "month", yKey: "customers" },
  evidence: {
    pages: ["有效客户", "客户主表", "客户月度趋势", "软删除过滤规则"],
    rules: ["排除测试账号", "排除软删除客户", "按认证完成时间归属月份"],
    tables: ["crm_customer"],
    sql: `SELECT DATE_FORMAT(c.certified_at, '%Y-%m') AS month,
       COUNT(DISTINCT c.customer_id) AS customers
FROM crm_customer c
WHERE c.cert_status = 1
  AND c.deleted_at IS NULL
  AND c.is_test = 0
  AND c.certified_at >= '2026-01-01'
  AND c.certified_at < '2026-08-01'
GROUP BY DATE_FORMAT(c.certified_at, '%Y-%m')
ORDER BY month
LIMIT 500`,
    durationMs: 842,
    scannedRows: 348260,
  },
};

export const OTHER_ANSWERS: Record<string, QueryAnswer> = {
  "7 月复购率最高的客户类型": {
    ...DEFAULT_ANSWER,
    id: "demo-20260812-02",
    question: "7 月复购率最高的客户类型",
    conclusion: "企业客户复购率最高，为 31.6%，比个人客户高 10.2 个百分点。",
    delta: "+10.2pp",
    columns: [
      { key: "segment", label: "客户类型", type: "text" },
      { key: "rate", label: "复购率", type: "percent" },
      { key: "customers", label: "下单客户", type: "number" },
    ],
    rows: [
      { segment: "企业客户", rate: 31.6, customers: 18420 },
      { segment: "渠道客户", rate: 27.8, customers: 12860 },
      { segment: "个人客户", rate: 21.4, customers: 68940 },
    ],
    chart: { type: "bar", xKey: "segment", yKey: "rate" },
    evidence: {
      ...DEFAULT_ANSWER.evidence,
      pages: ["复购率", "有效客户", "客户-订单", "时间字段口径"],
      tables: ["crm_customer", "sales_order"],
      scannedRows: 1104820,
    },
  },
  "近 30 天支付成功率，按渠道对比": {
    ...DEFAULT_ANSWER,
    id: "demo-20260812-03",
    question: "近 30 天支付成功率，按渠道对比",
    conclusion: "支付宝成功率最高（96.8%）；银行卡为 91.2%，需要进一步关注失败码分布。",
    delta: "总体 94.7%",
    columns: [
      { key: "channel", label: "支付渠道", type: "text" },
      { key: "rate", label: "成功率", type: "percent" },
      { key: "attempts", label: "支付笔数", type: "number" },
    ],
    rows: [
      { channel: "支付宝", rate: 96.8, attempts: 48200 },
      { channel: "微信支付", rate: 95.4, attempts: 61380 },
      { channel: "银行卡", rate: 91.2, attempts: 24620 },
    ],
    chart: { type: "bar", xKey: "channel", yKey: "rate" },
    evidence: {
      ...DEFAULT_ANSWER.evidence,
      pages: ["支付成功率", "订单-支付", "支付状态枚举", "时间字段口径"],
      tables: ["sales_order", "payment_transaction"],
      scannedRows: 890432,
    },
  },
  "退款金额异常增长发生在哪一天": {
    ...DEFAULT_ANSWER,
    id: "demo-20260812-04",
    question: "退款金额异常增长发生在哪一天",
    conclusion: "8 月 8 日退款金额为 86.4 万元，是近 30 天中位数的 2.7 倍。",
    delta: "2.7× 中位数",
    columns: [
      { key: "date", label: "日期", type: "text" },
      { key: "amount", label: "退款金额（元）", type: "number" },
      { key: "count", label: "退款笔数", type: "number" },
    ],
    rows: [
      { date: "08-05", amount: 304820, count: 1280 },
      { date: "08-06", amount: 318640, count: 1314 },
      { date: "08-07", amount: 297180, count: 1228 },
      { date: "08-08", amount: 864230, count: 2891 },
      { date: "08-09", amount: 362410, count: 1450 },
      { date: "08-10", amount: 331920, count: 1372 },
    ],
    chart: { type: "line", xKey: "date", yKey: "amount" },
    evidence: {
      ...DEFAULT_ANSWER.evidence,
      pages: ["退款金额", "订单-退款", "金额单位规则", "退款状态枚举"],
      tables: ["sales_refund", "sales_order"],
      scannedRows: 426810,
    },
  },
};

export const TABLES = [
  { name: "crm_customer", label: "客户主表", grade: "A", rows: "348 万", freshness: "2 分钟前", confidence: 98, state: "已确认" },
  { name: "sales_order", label: "销售订单", grade: "A", rows: "1,204 万", freshness: "1 分钟前", confidence: 96, state: "已确认" },
  { name: "payment_transaction", label: "支付流水", grade: "A", rows: "2,418 万", freshness: "刚刚", confidence: 93, state: "待复核" },
  { name: "sales_refund", label: "退款记录", grade: "A", rows: "86 万", freshness: "4 分钟前", confidence: 91, state: "待复核" },
  { name: "channel_config", label: "渠道配置", grade: "B", rows: "142", freshness: "12 天前", confidence: 88, state: "已确认" },
  { name: "order_history_bak", label: "历史订单备份", grade: "C", rows: "980 万", freshness: "724 天前", confidence: 97, state: "已排除" },
];

export const QUESTIONS: OntologyQuestion[] = [
  {
    id: 1,
    kind: "金额单位",
    title: "amount 字段是否统一以“分”为单位？",
    table: "payment_transaction · 影响 18 张表",
    evidence: "采样值中位数 8,900，P95 86,420；字段类型均为 bigint，注释包含“金额”。crm_customer.balance 已确认单位为分。",
    options: ["全部按分处理", "逐表确认", "仅支付域按分"],
    recommended: 0,
    affected: 18,
  },
  {
    id: 2,
    kind: "JOIN 路径",
    title: "退款记录应通过 order_no 关联销售订单吗？",
    table: "sales_refund → sales_order",
    evidence: "随机采样 10,000 个 sales_refund.order_no，与 sales_order.order_no 值域重叠 99.73%；右侧唯一，推断基数 N:1。",
    options: ["确认该关联", "标记为候选", "不允许关联"],
    recommended: 0,
    affected: 2,
  },
  {
    id: 3,
    kind: "枚举含义",
    title: "支付状态 30 是否表示“已退款”？",
    table: "payment_transaction.pay_status",
    evidence: "值 30 占 3.8%，这些记录 99.1% 可在 sales_refund 找到对应 refund_no，且最近仍有写入。",
    options: ["已退款", "退款处理中", "我来补充说明"],
    recommended: 0,
    affected: 4,
  },
];

export const ASSETS = [
  { type: "术语", count: 48, verified: 42, color: "cyan" },
  { type: "指标", count: 16, verified: 14, color: "amber" },
  { type: "JOIN", count: 27, verified: 23, color: "violet" },
  { type: "规则", count: 9, verified: 9, color: "green" },
];

export const EVAL_ROWS = [
  { category: "单表查询", passed: 28, total: 30, rate: 93.3, target: 85 },
  { category: "多表 JOIN", passed: 21, total: 28, rate: 75.0, target: 72 },
  { category: "指标口径", passed: 19, total: 24, rate: 79.2, target: 75 },
  { category: "时间对比", passed: 12, total: 16, rate: 75.0, target: 75 },
  { category: "应拒答", passed: 11, total: 12, rate: 91.7, target: 90 },
];
