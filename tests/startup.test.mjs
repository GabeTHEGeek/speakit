import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

test("speech model loads alongside the permission checks at launch", async () => {
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(source, /await Promise\.all\(\[setupPermissions\(\), prepareSpeechModel\(\)\]\)/);
});

test("the overlay window does not load the main app bundle", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .* from "\.\/app"/m);
  assert.match(source, /import\("\.\/app"\)/);
  assert.match(source, /import\("\.\/ui\/overlayView"\)/);
});

test("the in-app icon stays small", async () => {
  const { size } = await stat(new URL("../src/assets/speakit-mark.png", import.meta.url));
  assert.ok(size < 64 * 1024, `icon is ${size} bytes`);
});
