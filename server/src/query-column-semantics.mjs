import { detectSensitiveValue } from "./column-profile.mjs";

const KIND_PATTERNS=[
  ["phone",/(?:mobile|phone|telephone|tel(?:ephone)?|cell|手机号|联系电话|手机号码|电话)/i],
  ["email",/(?:e_?mail|mail_?address|邮箱|电子邮件)/i],
  ["china_id",/(?:id_?card|identity|身份证|证件号)/i],
  ["bank_card",/(?:bank_?card|card_?no|银行卡|银行账号)/i],
];

export function buildQueryColumnSemantics(columnsByTable={}) {
  const allowedColumns={};const columnKinds={};
  for(const [tableName,columns] of Object.entries(columnsByTable)) {
    allowedColumns[tableName]=(columns||[]).map((column)=>column.columnName);
    for(const column of columns||[]){const kind=columnSemanticKind(column);if(kind)columnKinds[`${tableName}.${column.columnName}`]=kind;}
  }
  return {columnsByTable,allowedColumns,columnKinds};
}

export function columnSemanticKind(column={}) {
  const profileKinds=Array.isArray(column.profile?.sensitiveKinds)?column.profile.sensitiveKinds:[];
  if(profileKinds.length===1&&["phone","email","china_id","bank_card"].includes(profileKinds[0]))return profileKinds[0];
  const text=`${column.columnName||""} ${column.comment||""}`;
  return KIND_PATTERNS.find(([,pattern])=>pattern.test(text))?.[0]||null;
}

export function detectQuestionValueKinds(question) {
  const text=String(question||"");const matches=[];
  for(const pattern of [/[\w.+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,}/g,/(?:\+?86[-\s]?)?1[3-9]\d{9}/g,/\d{17}[\dXx]/g,/(?:\d[ -]?){12,19}/g]) {
    for(const match of text.matchAll(pattern)) {
      const value=match[0].trim();const detected=detectSensitiveValue(value);
      if(detected.sensitive&&!matches.some((item)=>item.value===value))matches.push({value,kind:detected.kind});
    }
  }
  return matches;
}

export function redactTypedLiterals(value) {
  let result=String(value??"");
  for(const item of detectQuestionValueKinds(result).sort((left,right)=>right.value.length-left.value.length))result=result.replaceAll(item.value,"[REDACTED]");
  return result;
}

export const queryColumnSemanticsInternal={KIND_PATTERNS};
