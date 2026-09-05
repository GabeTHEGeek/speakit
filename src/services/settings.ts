const keys = {
  microphoneReady: "microphoneReady",
  permissionSetupComplete: "permissionSetupComplete",
  shortcut: "dictationShortcut",
  overlayX: "lastOverlayAnchorX",
  overlayY: "lastOverlayAnchorY",
  speechEngine: "speechEngine",
  canaryDefaultApplied: "canaryDefaultAppliedV1",
} as const;

export type SpeechEngine = "whisper" | "canary";

export const settings = {
  get shortcut() { return localStorage.getItem(keys.shortcut) || "CommandOrControl+Shift+Space"; },
  set shortcut(value: string) { localStorage.setItem(keys.shortcut, value); },
  get speechEngine(): SpeechEngine { return localStorage.getItem(keys.speechEngine) === "whisper" ? "whisper" : "canary"; },
  set speechEngine(value: SpeechEngine) { localStorage.setItem(keys.speechEngine, value); },
  get canaryDefaultApplied() { return localStorage.getItem(keys.canaryDefaultApplied) === "true"; },
  set canaryDefaultApplied(value: boolean) { localStorage.setItem(keys.canaryDefaultApplied, String(value)); },
  get microphoneReady() { return localStorage.getItem(keys.microphoneReady) === "true"; },
  set microphoneReady(value: boolean) {
    if (value) localStorage.setItem(keys.microphoneReady, "true");
    else localStorage.removeItem(keys.microphoneReady);
  },
  get permissionSetupComplete() { return localStorage.getItem(keys.permissionSetupComplete) === "true"; },
  set permissionSetupComplete(value: boolean) {
    if (value) localStorage.setItem(keys.permissionSetupComplete, "true");
    else localStorage.removeItem(keys.permissionSetupComplete);
  },
  get overlayAnchor() {
    return {
      x: Number(localStorage.getItem(keys.overlayX)) || 0,
      y: Number(localStorage.getItem(keys.overlayY)) || 0,
    };
  },
  set overlayAnchor(value: { x: number; y: number }) {
    localStorage.setItem(keys.overlayX, String(value.x));
    localStorage.setItem(keys.overlayY, String(value.y));
  },
};
