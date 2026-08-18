function normalizedStem(column) {
  return String(column).toLowerCase().replace(/_?(?:id|no|code)$/i, "").replace(/[^a-z0-9]/g, "");
}

export function inferRelation(left, right) {
  const nameMatch = left.columnName.toLowerCase() === right.columnName.toLowerCase()
    ? 1
    : normalizedStem(left.columnName) === normalizedStem(right.columnName) ? .82 : 0;
  const overlap = Math.max(0, Math.min(1, Number(left.overlapRatio ?? right.overlapRatio ?? 0)));
  const leftCardinality = Number(left.cardinality || 0);
  const rightCardinality = Number(right.cardinality || 0);
  const cardinalitySignal = leftCardinality && rightCardinality ? Math.min(leftCardinality, rightCardinality) / Math.max(leftCardinality, rightCardinality) : .5;
  const typeMatch = normalizeType(left.type) === normalizeType(right.type) ? 1 : 0;
  const confidence = nameMatch * .35 + overlap * .45 + typeMatch * .15 + cardinalitySignal * .05;
  const cardinality = left.unique && right.unique ? "1:1" : left.unique ? "1:N" : right.unique ? "N:1" : "N:N";
  return { confidence: Number(confidence.toFixed(4)), cardinality, status: confidence > .9 ? "accepted" : confidence >= .6 ? "review" : "rejected" };
}

function normalizeType(type = "") {
  return String(type).toLowerCase().replace(/\(.*/, "").replace("integer", "int");
}
