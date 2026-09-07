import test from "node:test";
import assert from "node:assert/strict";
import { OperationTimeoutError, withTimeout } from "../src/services/promiseTimeout.ts";

test("returns an operation that completes before its deadline", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 50, "too slow"), "ready");
});

test("rejects a stalled operation instead of waiting forever", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, "microphone stalled"),
    (error) => error instanceof OperationTimeoutError && error.message === "microphone stalled",
  );
});

test("cleans up a result that arrives after the timeout", async () => {
  let resolveOperation;
  let lateValue = "";
  const operation = new Promise((resolve) => { resolveOperation = resolve; });
  await assert.rejects(withTimeout(operation, 5, "late", (value) => { lateValue = value; }));
  resolveOperation("unused stream");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lateValue, "unused stream");
});
