import test from "node:test";
import assert from "node:assert/strict";

const saved = new Map();
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: (key) => saved.delete(key),
};

const { LivePreview, previewTail } = await import("../src/features/dictation/livePreview.ts");
const { settings, livePreviewAvailable } = await import("../src/services/settings.ts");
const { setupLivePreviewToggle } = await import("../src/ui/livePreviewToggle.ts");

/** A fake clock: each wait resolves when the test calls tick(). */
function manualClock() {
  const waiting = [];
  return {
    wait: () => new Promise((resolve) => waiting.push(resolve)),
    async tick() {
      for (let i = 0; i < 20 && waiting.length === 0; i++) await new Promise((r) => setImmediate(r));
      waiting.shift()?.();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

test("preview shows each pass as more audio arrives, and the newer pass replaces the older", async () => {
  const clock = manualClock();
  let audio = new Float32Array(16_000);
  const shown = [];
  const sent = [];
  const replies = ["So I think", "So I think we should go."];
  const preview = new LivePreview({
    snapshot: () => audio,
    transcribe: async (samples) => { sent.push(samples.length); return replies.shift() ?? null; },
    show: (text) => shown.push(text),
    wait: clock.wait,
  });
  preview.start();
  await clock.tick();
  audio = new Float32Array(32_000);
  await clock.tick();
  preview.stop();
  assert.deepEqual(sent, [16_000, 32_000]);
  assert.deepEqual(shown, ["", "So I think", "So I think we should go.", ""]);
});

test("preview skips clips that are too short or have no new audio", async () => {
  const clock = manualClock();
  let audio = new Float32Array(4_000);
  const sent = [];
  const preview = new LivePreview({
    snapshot: () => audio,
    transcribe: async (samples) => { sent.push(samples.length); return "hi"; },
    show: () => {},
    wait: clock.wait,
  });
  preview.start();
  await clock.tick();
  audio = new Float32Array(16_000);
  await clock.tick();
  await clock.tick();
  preview.stop();
  assert.deepEqual(sent, [16_000]);
});

test("a pass that finishes after stop is never shown", async () => {
  const clock = manualClock();
  let finish;
  const shown = [];
  const preview = new LivePreview({
    snapshot: () => new Float32Array(16_000),
    transcribe: () => new Promise((resolve) => { finish = resolve; }),
    show: (text) => shown.push(text),
    wait: clock.wait,
  });
  preview.start();
  await clock.tick();
  preview.stop();
  finish("late words");
  await clock.tick();
  assert.deepEqual(shown, ["", ""]);
  assert.equal(preview.active, false);
});

test("a busy engine or a failed pass keeps the previous text", async () => {
  const clock = manualClock();
  let audio = new Float32Array(16_000);
  const shown = [];
  const replies = [async () => "Hello there", async () => null, async () => { throw new Error("boom"); }];
  const preview = new LivePreview({
    snapshot: () => audio,
    transcribe: () => replies.shift()(),
    show: (text) => shown.push(text),
    wait: clock.wait,
  });
  preview.start();
  for (const length of [16_000, 24_000, 32_000]) {
    audio = new Float32Array(length);
    await clock.tick();
  }
  preview.stop();
  assert.deepEqual(shown, ["", "Hello there", ""]);
});

test("long previews keep the newest words", () => {
  assert.equal(previewTail("  short text "), "short text");
  const long = `${"early words ".repeat(20)}the newest words`;
  const tail = previewTail(long, 40);
  assert.ok(tail.startsWith("… "));
  assert.ok(tail.endsWith("the newest words"));
  assert.ok(tail.length <= 42);
});

test("live preview is on by default, Canary only, and the toggle saves changes", () => {
  saved.clear();
  assert.equal(settings.livePreview, true);
  assert.equal(livePreviewAvailable("canary"), true);
  assert.equal(livePreviewAvailable("whisper"), false);
  const listeners = [];
  const toggle = { checked: false, addEventListener: (_type, listener) => listeners.push(listener) };
  const logged = [];
  setupLivePreviewToggle({ livePreviewToggle: toggle }, settings, (event, details) => logged.push(`${event} ${details}`));
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  listeners.forEach((listener) => listener());
  assert.equal(settings.livePreview, false);
  assert.deepEqual(logged, ["settings.livePreview enabled=false"]);
});

test("an empty pass keeps the last words on screen instead of blanking them", async () => {
  const clock = manualClock();
  let audio = new Float32Array(16_000);
  const shown = [];
  const replies = ["Hello there", "", "   ", "Hello there", "Hello there friend"];
  const preview = new LivePreview({
    snapshot: () => audio,
    transcribe: async () => replies.shift() ?? null,
    show: (text) => shown.push(text),
    wait: clock.wait,
  });
  preview.start();
  for (const length of [16_000, 24_000, 32_000, 40_000, 48_000]) {
    audio = new Float32Array(length);
    await clock.tick();
  }
  preview.stop();
  assert.deepEqual(shown, ["", "Hello there", "Hello there friend", ""]);
});

test("a slow pass is followed by the next one without an extra wait", async () => {
  const waits = [];
  let now = 1_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    let passes = 0;
    let preview;
    preview = new LivePreview({
      snapshot: () => new Float32Array(16_000 * (passes + 1)),
      transcribe: async () => {
        passes += 1;
        now += passes === 1 ? 600 : 50;
        if (passes === 2) preview.stop();
        return "words";
      },
      show: () => {},
      wait: async (ms) => { waits.push(ms); },
      intervalMs: 250,
    });
    preview.start();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(waits, [250, 0]);
});
