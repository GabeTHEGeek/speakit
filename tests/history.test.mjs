import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryStore } from "../src/features/history/historyStore.ts";

function memoryStorage(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}

test("keeps only the five newest entries and survives restart", () => {
  const storage = memoryStorage();
  const history = createHistoryStore(storage);
  for (let index = 1; index <= 7; index++) history.add(`Entry ${index}`);
  assert.deepEqual(history.list().map((entry) => entry.text), ["Entry 7", "Entry 6", "Entry 5", "Entry 4", "Entry 3"]);
  assert.deepEqual(createHistoryStore(storage).list(), history.list());
});

test("deletes one entry permanently, including duplicate transcriptions", () => {
  const storage = memoryStorage();
  const history = createHistoryStore(storage);
  history.add("Same words");
  history.add("Same words");
  const id = history.list()[0].id;
  history.remove(id);
  assert.equal(history.list().length, 1);
  assert.notEqual(history.list()[0].id, id);
  assert.deepEqual(createHistoryStore(storage).list(), history.list());
  history.remove(history.list()[0].id);
  assert.deepEqual(createHistoryStore(storage).list(), []);
});

test("ignores empty text and malformed persisted data", () => {
  for (const input of ["invalid JSON", "{}", '[null,{}, {"id":2}]']) {
    const history = createHistoryStore(memoryStorage(input));
    history.add("   ");
    assert.deepEqual(history.list(), []);
  }
});

test("storage errors are reported without pretending data was saved or deleted", () => {
  const storage = memoryStorage();
  const history = createHistoryStore(storage);
  history.add("Keep this");
  const before = history.list();
  storage.setItem = () => { throw new Error("Storage full"); };
  assert.throws(() => history.add("Cannot save"));
  assert.throws(() => history.remove(before[0].id));
  assert.deepEqual(history.list(), before);
});
