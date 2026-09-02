import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
import { startMainApp } from "./app";
import { renderOverlay } from "./ui/overlayView";

const currentWindow = getCurrentWindow();
const speakitIconUrl = new URL("../src-tauri/icons/speakit-icon-v3.png", import.meta.url).href;

if (currentWindow.label === "overlay") renderOverlay(currentWindow);
else startMainApp(speakitIconUrl);
