// Shared test fixture: create a real (non-demo) catalog source that has been
// marked as passing the read-only connection test, so integration-style tests
// no longer rely on the removed demo source. Callers may then seed whichever
// tables/columns/relations/knowledge the specific test needs.
import { randomUUID } from "node:crypto";

export function createTestSource(store, { name = "test-source", credential = "encrypted-fixture" } = {}) {
  const source = store.createSource({ name, kind: "mysql", host: "db", port: 3306, dbName: "sales", userName: "ro", credential, isDemo: false });
  store.markSourceTest(source.id, true);
  return store.getSource(source.id);
}

export function uniqueId() {
  return randomUUID();
}
