import type { MainView } from "./mainView";

type PreviewStore = { livePreview: boolean };

/** Shows whether live preview is on and saves a change for the next recording. */
export function setupLivePreviewToggle(
  view: Pick<MainView, "livePreviewToggle">,
  store: PreviewStore,
  log: (event: string, details: string) => void,
) {
  view.livePreviewToggle.checked = store.livePreview;
  view.livePreviewToggle.addEventListener("change", () => {
    store.livePreview = view.livePreviewToggle.checked;
    log("settings.livePreview", `enabled=${store.livePreview}`);
  });
}
