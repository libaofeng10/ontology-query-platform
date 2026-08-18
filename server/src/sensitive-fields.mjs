const NAME_PATTERNS = [
  /(?:^|_)(?:mobile|phone|tel|telephone)(?:_|$)/i,
  /(?:^|_)(?:email|e_?mail|mail_?address)(?:_|$)/i,
  /(?:^|_)(?:id_card|identity|passport|ssn)(?:_|$)/i,
  /(?:^|_)(?:real_?name|full_?name|contact_?name|user_?name|seller_?name|employee_?name|owner_?name|person_?name|customer_?name)(?:_|$)/i,
  /(?:^|_)(?:address|addr|location_detail)(?:_|$)/i,
  /(?:^|_)(?:bank_?card|card_?no|account_?no)(?:_|$)/i,
  /(?:^|_)(?:password|passwd|secret|token)(?:_|$)/i,
];

const VALUE_PATTERNS = [
  /^1[3-9]\d{9}$/,
  /^\d{17}[\dXx]$/,
  /^(?:\d[ -]*?){13,19}$/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
];

const COMMENT_PATTERNS=[/(?:姓名|联系人|手机号|联系电话|邮箱|电子邮件|身份证|护照|银行卡|详细地址)/i,/(?:e-?mail|phone|telephone|passport|identity card|bank card|contact name)/i];

export function detectSensitiveField(columnName, samples = [], comment = "") {
  const nameMatch = NAME_PATTERNS.some((pattern) => pattern.test(columnName));
  const commentMatch = COMMENT_PATTERNS.some((pattern)=>pattern.test(String(comment||"")));
  const valueMatch = samples.filter((value) => value != null).slice(0, 20).some((value) => VALUE_PATTERNS.some((pattern) => pattern.test(String(value).trim())));
  return { sensitive: nameMatch || commentMatch || valueMatch, reason: nameMatch ? "字段名规则" : commentMatch ? "字段注释规则" : valueMatch ? "值格式规则" : null };
}

export function redactSensitive(value) {
  if (typeof value !== "string") return value;
  return VALUE_PATTERNS.some((pattern) => pattern.test(value.trim())) ? "[REDACTED]" : value;
}
