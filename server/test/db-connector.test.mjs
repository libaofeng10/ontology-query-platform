import test from "node:test";
import assert from "node:assert/strict";
import { createConnector } from "../src/db-connector.mjs";
import { encryptCredential } from "../src/crypto.mjs";

const appSecret="connector-test-secret";
const source={id:9,host:"localhost",port:3306,dbName:"test",userName:"readonly",credential:encryptCredential("secret",appSecret),isDemo:false};

test("date and time columns are requested as strings to preserve MySQL zero dates",async()=>{
  let poolConfig;
  const pool=fakePool(()=>({async execute(){return [[{expire_time:"0000-00-00 00:00:00"}],[]];}}));
  const connector=createConnector({appSecret,timeoutMs:100,mysqlClient:{createPool(config){poolConfig=config;return pool;}}});

  const [rows]=await connector.query(source,"SELECT expire_time FROM alpha_user");

  assert.equal(poolConfig.dateStrings,true);
  assert.equal(rows[0].expire_time,"0000-00-00 00:00:00");
  await connector.close();
});

test("read queries retry once after a transient connection reset",async()=>{
  let attempts=0;
  const pool=fakePool(()=>({
    async execute(){attempts++;if(attempts===1){const error=new Error("read ECONNRESET");error.code="ECONNRESET";throw error;}return [[{ok:1}],[]];},
  }));
  const connector=createConnector({appSecret,timeoutMs:100,mysqlClient:{createPool:()=>pool}});

  const [rows]=await connector.query(source,"SELECT 1");

  assert.deepEqual(rows,[{ok:1}]);
  assert.equal(attempts,2);
  await connector.close();
});

test("query deadlines reject even if a destroyed driver promise never settles",async()=>{
  let destroyed=false;
  const pool=fakePool(()=>({
    execute:()=>new Promise(()=>{}),
    destroy(){destroyed=true;this.connection._closing=true;},
  }));
  const connector=createConnector({appSecret,timeoutMs:10,mysqlClient:{createPool:()=>pool}});

  await assert.rejects(connector.query(source,"SELECT SLEEP(10)"),(error)=>error.code==="QUERY_TIMEOUT"&&/10ms/.test(error.message));
  assert.equal(destroyed,true);
  await connector.close();
});

test("EXPLAIN executes the guarded SQL without query parameters",async()=>{
  let executed;const pool=fakePool(()=>({async execute(sql,params){executed={sql,params};return [[{rows:1}],[]];}}));
  const connector=createConnector({appSecret,timeoutMs:100,mysqlClient:{createPool:()=>pool}});
  const rows=await connector.explain(source,"SELECT expire_time FROM alpha_user WHERE alp_cell = '13774665233'");
  assert.deepEqual(rows,[{rows:1}]);assert.deepEqual(executed,{sql:"EXPLAIN SELECT expire_time FROM alpha_user WHERE alp_cell = '13774665233'",params:[]});
  await connector.close();
});

function fakePool(connectionFactory) {
  return {
    async getConnection(){
      const connection={connection:{_closing:false},release(){},destroy(){this.connection._closing=true;},...connectionFactory()};
      return connection;
    },
    async end(){},
  };
}
