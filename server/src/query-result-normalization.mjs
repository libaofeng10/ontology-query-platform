export function normalizeQueryRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,normalizeQueryValue(value)]));
}

function normalizeQueryValue(value) {
  if(value instanceof Date) return Number.isNaN(value.getTime())?null:value.toISOString();
  if(typeof value==="bigint") return Number(value);
  if(Buffer.isBuffer(value)) return "[BINARY]";
  return value;
}
