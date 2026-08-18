import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, authorize, canAccessSource, createRateLimiter } from "../src/auth.mjs";

test("role identities authenticate with constant-time tokens and enforce source scope",()=>{
  const runtime={apiIdentities:[{name:"analyst-a",role:"analyst",token:"secret-a",sourceIds:[2,3]}]};
  const identity=authenticate({headers:{authorization:"Bearer secret-a"}},runtime);
  assert.equal(identity.name,"analyst-a");assert.equal(identity.role,"analyst");
  assert.doesNotThrow(()=>authorize(identity,"viewer",2));
  assert.doesNotThrow(()=>authorize(identity,"analyst",3));
  assert.throws(()=>authorize(identity,"editor",2),/editor/);
  assert.throws(()=>authorize(identity,"viewer",1),/无权访问/);
  assert.equal(canAccessSource(identity,3),true);assert.equal(canAccessSource(identity,4),false);
});

test("rate limiter returns a retry window after the configured budget",()=>{
  const limiter=createRateLimiter({windowMs:60_000});
  assert.equal(limiter.check("identity:query",2).remaining,1);
  assert.equal(limiter.check("identity:query",2).remaining,0);
  assert.throws(()=>limiter.check("identity:query",2),(error)=>error.status===429&&error.retryAfter>0);
});
