import { invoke } from "@tauri-apps/api/core";
import type { ActiveTarget, DiagnosticReport, PasteResult } from "../types";

export function errorDetails(error: unknown) {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function logEvent(event: string, details = "") {
  void invoke("log_event", { event, details }).catch(() => undefined);
}

export const native = {
  accessibilityReady: () => invoke<boolean>("accessibility_ready"),
  appInstallLocation: () => invoke<string>("app_install_location"),
  diagnostics: () => invoke<DiagnosticReport>("diagnostics"),
  downloadModel: () => invoke("download_model"),
  eraseTriggerSpace: () => invoke("erase_trigger_space"),
  frontmostTarget: () => invoke<ActiveTarget>("frontmost_target"),
  hideOverlay: () => invoke("hide_overlay"),
  mainWindowTarget: () => invoke<ActiveTarget>("main_window_target"),
  modelReady: () => invoke<boolean>("model_ready"),
  pasteText: (text: string, appName: string, targetPid: number) =>
    invoke<PasteResult>("paste_text", { text, appName, targetPid }),
  playActivationSound: () => invoke("play_activation_sound"),
  playStopSound: () => invoke("play_stop_sound"),
  prepareModel: () => invoke("prepare_model"),
  requestAccessibilityPermission: () => invoke("request_accessibility_permission"),
  showOverlay: (anchorX: number, anchorY: number) => invoke("show_overlay", { anchorX, anchorY }),
  transcribe: (samples: Float32Array) => invoke<string>("transcribe", { samples: Array.from(samples) }),
};
