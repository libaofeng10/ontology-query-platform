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
  // Restrict typed-literal matches to standalone values.  Otherwise a
  // 12–19-digit fragment inside a SHA-256 fingerprint (or another opaque
  // identifier) can be mistaken for a bank-card value and corrupt audit
  // metadata when redacted.  ASCII identifier boundaries still allow values
  // adjacent to Chinese text and normal SQL punctuation.
  const patterns=[
    /(?<![A-Za-z0-9_])[\w.+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,}(?![A-Za-z0-9_])/g,
    // Mainland China mobile numbers, with optional country code and the
    // separators commonly emitted by spreadsheets/CRM displays.
    /(?<![A-Za-z0-9_+])(?:\+?86[\s().-]*)?1[3-9](?:[\s().-]*\d){9}(?![A-Za-z0-9_])/g,
    // Explicit international country-code numbers (for example
    // `+1 415 555 2671`).  The detector below enforces the E.164 digit bound.
    /(?<![A-Za-z0-9_])\+\d{1,3}(?:[\s().-]*\d){8,12}(?![A-Za-z0-9_])/g,
    // Chinese resident identity numbers, allowing display separators while
    // requiring all 18 logical characters.
    /(?<![A-Za-z0-9_])\d(?:[\s-]?\d){16}[\dXx](?![A-Za-z0-9_])/g,
    // 12–19 digit card/account values, allowing one display separator between
    // adjacent digits.  A leading `+` is excluded so an international phone
    // cannot be reclassified from a substring as a bank card.
    /(?<![A-Za-z0-9_+])(?:\d[\s.-]?){11,18}\d(?![A-Za-z0-9_])/g,
  ];
  for(const pattern of patterns) {
    for(const match of text.matchAll(pattern)) {
      const value=match[0].trim();
      const start=match.index??0;const end=start+match[0].length;
      // Do not accept a candidate that is merely a separated fragment of a
      // longer numeric token (e.g. the tail of a card number).  Chinese text
      // and normal SQL punctuation remain valid neighbors.
      if(!standaloneCandidate(text,start,end))continue;
      const detected=detectSensitiveValue(value);
      if(!detected.sensitive)continue;
      const candidate={value,kind:detected.kind,start,end};
      const overlapping=matches.filter((item)=>item.start<end&&start<item.end);
      if(!overlapping.length){matches.push(candidate);continue;}
      const preferred=[...overlapping,candidate].sort((left,right)=>right.value.length-left.value.length||kindPriority(right.kind)-kindPriority(left.kind))[0];
      for(const item of overlapping){const index=matches.indexOf(item);if(index>=0)matches.splice(index,1);}
      if(preferred===candidate||!matches.some((item)=>item.start===preferred.start&&item.end===preferred.end))matches.push(preferred);
    }
  }
  return matches.sort((left,right)=>left.start-right.start||kindPriority(right.kind)-kindPriority(left.kind)).map(({value,kind})=>({value,kind}));
}

export function redactTypedLiterals(value) {
  let result=String(value??"");
  for(const item of detectQuestionValueKinds(result).sort((left,right)=>right.value.length-left.value.length))result=result.replaceAll(item.value,"[REDACTED]");
  return result;
}

export const queryColumnSemanticsInternal={KIND_PATTERNS};

function standaloneCandidate(text,start,end) {
  const before=text[start-1]||"";const after=text[end]||"";
  if(/[A-Za-z0-9_]/.test(before)||/[A-Za-z0-9_]/.test(after))return false;
  // A separator immediately next to a candidate can be part of a larger
  // number.  Reject only when that separator bridges to another digit; this
  // still permits `(13800138000)` and ordinary punctuation.
  if(/[\s().-]/.test(before)&&/\d/.test(text[start-2]||""))return false;
  if(/[\s().-]/.test(after)&&/\d/.test(text[end+1]||""))return false;
  return true;
}

function kindPriority(kind) {
  return kind==="phone"?4:kind==="email"?3:kind==="china_id"?2:1;
}
