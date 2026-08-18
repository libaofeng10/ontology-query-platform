import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQueryRow } from "../src/query-result-normalization.mjs";

test("query result normalization tolerates invalid Date values",()=>{
  const row=normalizeQueryRow({
    valid_time:new Date("2026-08-17T00:00:00.000Z"),
    invalid_time:new Date(Number.NaN),
    identifier:7n,
    payload:Buffer.from("binary"),
  });

  assert.deepEqual(row,{
    valid_time:"2026-08-17T00:00:00.000Z",
    invalid_time:null,
    identifier:7,
    payload:"[BINARY]",
  });
});
