import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

const currentWindow = getCurrentWindow();
// A 160px copy of the app icon: the UI shows it at 52px at most, and the
// 1024px original is ~1 MB to read and decode on every launch.
const speakitIconUrl = new URL("./assets/speakit-mark.png", import.meta.url).href;

// Each window loads only the code it needs: the hidden overlay window starts
// at launch too, so keeping the main app out of its bundle saves parse time.
if (currentWindow.label === "overlay") {
  void import("./ui/overlayView").then(({ renderOverlay }) => renderOverlay(currentWindow));
} else {
  void import("./app").then(({ startMainApp }) => startMainApp(speakitIconUrl));
}
