const C_NAME = /(?:^|_)(?:log|logs|tmp|temp|bak|backup|history|archive|snapshot)(?:_|$)/i;
const C_COPY_OR_NUMBERED_NAME = /copy|\d/i;
const B_NAME = /(?:^|_)(?:config|dict|dictionary|mapping|setting|type|category)(?:_|$)/i;

export function gradeTable(table) {
  if (table.gradeOverride) return { grade: table.gradeOverride, score: null, reasons: ["人工覆盖"] };
  if (C_COPY_OR_NUMBERED_NAME.test(table.tableName || "")) return { grade: "C", score: null, reasons: ["表名含数字或 copy，疑似版本/复制表"] };
  let score = 0;
  const reasons = [];
  if ((table.inboundRelations || 0) >= 2) { score += 3; reasons.push("被多表引用"); }
  if ((table.rowEstimate || 0) >= 100_000) { score += 2; reasons.push("数据量较大"); }
  if ((table.daysSinceWrite ?? 9999) <= 30) { score += 2; reasons.push("近期活跃"); }
  if ((table.rowEstimate || 0) === 0) { score -= 3; reasons.push("空表"); }
  if (C_NAME.test(table.tableName || "")) { score -= 4; reasons.push("疑似日志/临时/备份表"); }
  if ((table.daysSinceWrite ?? 0) >= 365) { score -= 2; reasons.push("长期无写入"); }
  if (B_NAME.test(table.tableName || "") || (table.rowEstimate || 0) < 1_000) { score -= 1; reasons.push("疑似配置/字典表"); }
  return { grade: score >= 4 ? "A" : score <= -2 ? "C" : "B", score, reasons };
}
