import test from "node:test";
import assert from "node:assert/strict";

const saved = new Map();
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: (key) => saved.delete(key),
};

const { settings, languageForEngine, isDictationLanguage, dictationLanguages } = await import("../src/services/settings.ts");
const { setupLanguagePicker } = await import("../src/ui/languagePicker.ts");

test("dictation language defaults to English and ignores unknown values", () => {
  saved.clear();
  assert.equal(settings.dictationLanguage, "en");
  saved.set("dictationLanguage", "it");
  assert.equal(settings.dictationLanguage, "en");
  settings.dictationLanguage = "fr";
  assert.equal(settings.dictationLanguage, "fr");
});

test("the picker offers exactly the languages Canary Flash supports", () => {
  assert.deepEqual(dictationLanguages.map((language) => language.code), ["en", "de", "fr", "es"]);
  assert.equal(isDictationLanguage("de"), true);
  assert.equal(isDictationLanguage("it"), false);
});

test("Whisper always transcribes English whatever language is chosen", () => {
  assert.equal(languageForEngine("canary", "es"), "es");
  assert.equal(languageForEngine("whisper", "es"), "en");
});

test("the picker shows the saved language and saves a new choice", () => {
  saved.clear();
  settings.dictationLanguage = "de";
  const listeners = [];
  const select = { value: "", addEventListener: (_type, listener) => listeners.push(listener) };
  const logged = [];
  setupLanguagePicker({ languageSelect: select }, settings, (event, details) => logged.push(`${event} ${details}`));
  assert.equal(select.value, "de");

  select.value = "es";
  listeners.forEach((listener) => listener());
  assert.equal(settings.dictationLanguage, "es");
  assert.deepEqual(logged, ["settings.language language=es"]);

  select.value = "xx";
  listeners.forEach((listener) => listener());
  assert.equal(settings.dictationLanguage, "es");
  assert.equal(select.value, "es");
  assert.deepEqual(logged, ["settings.language language=es", "settings.language language=es"]);
});
