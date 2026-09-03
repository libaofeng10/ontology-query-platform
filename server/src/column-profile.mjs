import { createHash } from "node:crypto";

export const COLUMN_PROFILE_VERSION="column-profile-v1";

const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/i;
const PHONE=/^(?:\+?86[-\s]?)?1[3-9]\d{9}$/;
// International numbers are only treated as phone values when they carry an
// explicit `+` country prefix.  This avoids classifying ordinary 10–15 digit
// business identifiers as phone numbers while still covering values such as
// `+1 (415) 555-2671`.
const INTERNATIONAL_PHONE=/^\+\d{10,15}$/;
const CHINA_ID=/^\d{17}[\dX]$/i;
const BANK_CARD=/^\d{12,19}$/;
const NUMBER_TYPE=/int|decimal|numeric|float|double|real/i;
const TIME_TYPE=/date|time|timestamp/i;

export function detectSensitiveValue(value) {
  if(value==null)return {sensitive:false,kind:null};
  const text=String(value).trim();
  if(!text)return {sensitive:false,kind:null};
  if(EMAIL.test(text))return {sensitive:true,kind:"email"};
  // Keep the detector tolerant of the common display formats used by CRM
  // exports.  The compact form is only used after the anchored shape checks
  // below, so punctuation cannot turn an arbitrary sentence into a match.
  const compact=text.replace(/[\s().-]/g,"");
  if(PHONE.test(compact))return {sensitive:true,kind:"phone"};
  if(INTERNATIONAL_PHONE.test(compact))return {sensitive:true,kind:"phone"};
  if(CHINA_ID.test(compact))return {sensitive:true,kind:"china_id"};
  if(BANK_CARD.test(compact))return {sensitive:true,kind:"bank_card"};
  return {sensitive:false,kind:null};
}

export function buildColumnProfile({values=[],dataType="",enums=[]}={}) {
  const normalizedValues=Array.isArray(values)?values:[];
  const enumItems=Array.isArray(enums)?enums:[];
  const sampleSize=enumItems.length?enumItems.reduce((sum,item)=>sum+Math.max(0,Number(item?.count)||0),0):normalizedValues.length;
  const rawNonNull=enumItems.length?enumItems.map((item)=>item?.value).filter((value)=>value!=null):normalizedValues.filter((value)=>value!=null);
  const serialized=rawNonNull.map(serializedValue);
  const sensitiveKinds=new Set(serialized.map((value)=>detectSensitiveValue(value)).filter((item)=>item.sensitive).map((item)=>item.kind));
  const suppressValues=sensitiveKinds.size>0;
  const frequencies=new Map();
  if(enumItems.length)for(const item of enumItems){const value=serializedValue(item?.value);frequencies.set(value,(frequencies.get(value)||0)+Math.max(0,Number(item?.count)||0));}
  else for(const value of serialized)frequencies.set(value,(frequencies.get(value)||0)+1);
  const sampleValues=suppressValues?[]:[...frequencies.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])).slice(0,5).map(([value])=>truncate(value,64));
  const nullCount=enumItems.length?0:normalizedValues.length-rawNonNull.length;
  const minMax=suppressValues?null:profileMinMax(rawNonNull,dataType);
  return {
    profile:{
      sampleValues,
      formatPattern:formatPattern(serialized,sensitiveKinds),
      distinctCount:frequencies.size,
      nullRatio:sampleSize?Number((nullCount/sampleSize).toFixed(6)):0,
      minMax,
      sensitiveValuesSuppressed:suppressValues,
      ...(sensitiveKinds.size?{sensitiveKinds:[...sensitiveKinds].sort()}:{}),
    },
    sampleSize,
    profileVersion:COLUMN_PROFILE_VERSION,
  };
}

export function columnProfileDigest(profile) {
  if(!profile)return null;
  const stable={profileVersion:profile.profileVersion||COLUMN_PROFILE_VERSION,profile:profile.profile||profile};
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function formatPattern(values,sensitiveKinds) {
  if(!values.length)return null;
  if(sensitiveKinds.size)return [...sensitiveKinds].sort().map((kind)=>`<${kind}>`).join("|");
  const counts=new Map();
  for(const value of values.slice(0,200)){
    const pattern=patternFor(value);
    counts.set(pattern,(counts.get(pattern)||0)+1);
  }
  return [...counts.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))[0]?.[0]||null;
}

function patternFor(value) {
  const text=truncate(String(value),64);
  let result="";
  for(let index=0;index<text.length;){
    const char=text[index];
    if(/\d/.test(char)){let end=index+1;while(end<text.length&&/\d/.test(text[end]))end++;result+=`\\d{${end-index}}`;index=end;continue;}
    if(/[A-Z]/.test(char)){let end=index+1;while(end<text.length&&/[A-Z]/.test(text[end]))end++;result+=text.slice(index,end);index=end;continue;}
    if(/[a-z]/.test(char)){let end=index+1;while(end<text.length&&/[a-z]/.test(text[end]))end++;result+=text.slice(index,end);index=end;continue;}
    if(/[\u3400-\u9fff]/u.test(char)){let end=index+1;while(end<text.length&&/[\u3400-\u9fff]/u.test(text[end]))end++;result+=`[\\u4E00-\\u9FFF]{${end-index}}`;index=end;continue;}
    result+=/[.*+?^${}()|[\]\\]/.test(char)?`\\${char}`:char;
    index++;
  }
  return result;
}

function profileMinMax(values,dataType) {
  if(NUMBER_TYPE.test(dataType)){
    const numbers=values.map(Number).filter(Number.isFinite);
    return numbers.length?{min:Math.min(...numbers),max:Math.max(...numbers)}:null;
  }
  if(TIME_TYPE.test(dataType)){
    const times=values.map((value)=>new Date(value)).filter((value)=>!Number.isNaN(value.getTime())).sort((left,right)=>left-right);
    return times.length?{min:times[0].toISOString(),max:times.at(-1).toISOString()}:null;
  }
  return null;
}

function serializedValue(value) {
  if(value instanceof Date)return value.toISOString();
  if(Buffer.isBuffer(value))return `<binary:${value.length}>`;
  return String(value);
}
function truncate(value,length){return [...String(value)].slice(0,length).join("");}
