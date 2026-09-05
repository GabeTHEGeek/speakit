import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveAudioLevel } from "../src/services/audioLevel.ts";

test("quiet background noise does not animate the waveform", () => {
  const meter = new AdaptiveAudioLevel();
  for (let index = 0; index < 30; index++) assert.equal(meter.update(0.003), 0);
});

test("speech raises the waveform quickly and silence lets it settle", () => {
  const meter = new AdaptiveAudioLevel();
  for (let index = 0; index < 10; index++) meter.update(0.003);
  const spoken = meter.update(0.08);
  assert.ok(spoken > 0.5);
  let settled = spoken;
  for (let index = 0; index < 30; index++) settled = meter.update(0.003);
  assert.equal(settled, 0);
});

test("reset removes the previous recording level", () => {
  const meter = new AdaptiveAudioLevel();
  assert.ok(meter.update(0.1) > 0);
  meter.reset();
  assert.equal(meter.update(0.003), 0);
});
