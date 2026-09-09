import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("home screen includes the recent captures panel", async () => {
  const source = await readFile(new URL("../src/ui/mainView.ts", import.meta.url), "utf8");
  assert.match(source, /id="home-view"/);
  assert.match(source, /id="recent-captures-title">Recent captures/);
  assert.match(source, /id="recent-history"/);
  assert.match(source, /id="view-all-history"/);
  assert.ok(source.indexOf('id="recent-captures-title"') > source.indexOf('id="run-diagnostics"'));
});

test("shortcut assignment requires a modifier combination", async () => {
  const source = await readFile(new URL("../src/services/globalHotkeys.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!modifiers\.length\) throw new Error\("Include at least one modifier key"\)/);
});

test("Space shortcuts never delete existing text before recording", async () => {
  const source = await readFile(new URL("../src/features/dictation/dictationFlow.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /eraseTriggerSpace|triggerCleanup/);
  assert.match(source, /const sampleRate = await this\.recorder\.start\(\)/);
  assert.match(source, /runDiagnosticsButton\.disabled = next !== "ready"/);
});
