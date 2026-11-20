import type { DictationLanguage } from "../services/settings";
import type { MainView } from "./mainView";

type LanguageStore = { dictationLanguage: DictationLanguage };

/** Shows the saved dictation language and saves a new choice for the next recording. */
export function setupLanguagePicker(
  view: Pick<MainView, "languageSelect">,
  store: LanguageStore,
  log: (event: string, details: string) => void,
) {
  view.languageSelect.value = store.dictationLanguage;
  view.languageSelect.addEventListener("change", () => {
    // The store ignores anything that is not a supported language.
    store.dictationLanguage = view.languageSelect.value as DictationLanguage;
    view.languageSelect.value = store.dictationLanguage;
    log("settings.language", `language=${store.dictationLanguage}`);
  });
}
