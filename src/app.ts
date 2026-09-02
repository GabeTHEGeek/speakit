import { listen } from "@tauri-apps/api/event";
import { DictationFlow } from "./features/dictation/dictationFlow";
import { errorDetails, logEvent, native } from "./platform/native";
import { AudioRecorder, requestMicrophoneStream } from "./services/audioRecorder";
import { GlobalHotkeys, shortcutFromEvent, shortcutLabel } from "./services/globalHotkeys";
import { settings } from "./services/settings";
import { renderMainView } from "./ui/mainView";

export function startMainApp(iconUrl: string) {
  const view = renderMainView(iconUrl);
  const recorder = new AudioRecorder();
  let shortcut = settings.shortcut;
  let captureShortcut = false;
  let microphoneReady = settings.microphoneReady;
  let accessibilityReady = false;
  let modelIsReady = false;

  let dictation: DictationFlow;
  const hotkeys = new GlobalHotkeys(shortcut, () => void dictation.start(true), () => void dictation.stop());
  dictation = new DictationFlow(view, recorder, () => shortcut, () => hotkeys.isHeld);
  dictation.attachManualControls();

  function renderShortcut() {
    const parts = shortcutLabel(shortcut).split(" ");
    view.shortcutDisplay.innerHTML = `${parts.map((part) => `<kbd>${part}</kbd>`).join("")}<span>Hold anywhere</span>`;
    view.shortcutEditor.textContent = shortcutLabel(shortcut);
  }

  function updatePermissionSetup() {
    view.micCheck.textContent = microphoneReady ? "✓ Ready" : "Enable";
    view.accessCheck.textContent = accessibilityReady ? "✓ Ready" : "Enable";
    view.micCheck.classList.toggle("granted", microphoneReady);
    view.accessCheck.classList.toggle("granted", accessibilityReady);
    view.finishSetup.disabled = !(microphoneReady && accessibilityReady);
    view.finishSetup.textContent = accessibilityReady ? "Finish setup" : "Enable Accessibility to continue";
  }

  async function ensureShortcutRegistration(reason: string) {
    try {
      await hotkeys.ensure(reason, modelIsReady && !captureShortcut);
    } catch {
      if (dictation.isReady) dictation.setStatus("error", "Shortcut unavailable — quit other SpeakIt copies and reopen");
    }
  }

  window.addEventListener("focus", () => void ensureShortcutRegistration("window.focus"));
  window.addEventListener("blur", () => window.setTimeout(() => void ensureShortcutRegistration("window.blur"), 150));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ensureShortcutRegistration("document.visible");
  });
  window.setInterval(() => void ensureShortcutRegistration("watchdog"), 5_000);

  view.shortcutEditor.addEventListener("click", () => {
    captureShortcut = true;
    view.shortcutEditor.classList.add("capturing");
    view.shortcutEditor.textContent = "Hold modifiers…";
    view.shortcutEditor.focus();
  });
  view.shortcutEditor.addEventListener("blur", () => {
    captureShortcut = false;
    view.shortcutEditor.classList.remove("capturing");
    renderShortcut();
  });
  document.addEventListener("keydown", async (event) => {
    if (!captureShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const next = shortcutFromEvent(event);
      if (!next) {
        const held = [event.metaKey && "⌘", event.ctrlKey && "⌃", event.altKey && "⌥", event.shiftKey && "⇧"].filter(Boolean).join(" ");
        view.shortcutEditor.textContent = held || "Hold modifiers…";
        return;
      }
      const previous = shortcut;
      await hotkeys.bind(next, previous);
      shortcut = next;
      settings.shortcut = shortcut;
      captureShortcut = false;
      view.shortcutEditor.classList.remove("capturing");
      view.shortcutEditor.blur();
      renderShortcut();
      dictation.setStatus("ready", `Shortcut changed to ${shortcutLabel(shortcut)}`);
    } catch (error) {
      dictation.setStatus("error", String(error));
      renderShortcut();
    }
  }, true);

  view.copyButton.addEventListener("click", async () => {
    if (!view.transcript.classList.contains("placeholder")) await navigator.clipboard.writeText(view.transcript.textContent || "");
  });

  view.enableMic.addEventListener("click", async () => {
    try {
      view.enableMic.disabled = true;
      view.micCheck.textContent = "Waiting…";
      const stream = await requestMicrophoneStream();
      stream.getTracks().forEach((track) => { track.enabled = false; });
      recorder.setPreparedStream(stream);
      microphoneReady = true;
      settings.microphoneReady = true;
      logEvent("permission.microphone.granted", stream.getAudioTracks()[0]?.label || "audio track");
    } catch (error) {
      microphoneReady = false;
      settings.microphoneReady = false;
      logEvent("permission.microphone.failed", errorDetails(error));
      view.micCheck.textContent = "Try again";
    } finally {
      view.enableMic.disabled = false;
      updatePermissionSetup();
    }
  });

  view.enableAccess.addEventListener("click", async () => {
    view.accessCheck.textContent = "Open Settings…";
    await native.requestAccessibilityPermission();
  });
  view.finishSetup.addEventListener("click", () => {
    settings.permissionSetupComplete = true;
    view.permissionSetup.classList.add("hidden");
  });

  void listen<number>("model-download-progress", (event) => {
    const percent = Math.max(0, Math.min(100, event.payload));
    view.downloadProgress.style.width = `${percent}%`;
    view.downloadLabel.textContent = `Downloading… ${Math.round(percent)}%`;
  });
  view.downloadModelButton.addEventListener("click", async () => {
    view.downloadModelButton.disabled = true;
    view.downloadModelButton.textContent = "Downloading…";
    view.downloadLabel.textContent = "Starting download…";
    view.modelState.textContent = "Downloading Whisper small.en…";
    try {
      await native.downloadModel();
      modelIsReady = true;
      dictation.setModelReady(true);
      view.downloadProgress.style.width = "100%";
      view.downloadLabel.textContent = "Preparing speech model…";
      view.modelState.textContent = "Preparing Whisper small.en…";
      await native.prepareModel();
      view.downloadLabel.textContent = "Download complete";
      view.modelState.textContent = "Whisper small.en ready";
      if (!hotkeys.isRegistered) await hotkeys.bind(shortcut);
      window.setTimeout(() => view.modelSetup.classList.add("hidden"), 450);
    } catch (error) {
      view.downloadLabel.textContent = `Download failed: ${String(error)}`;
      view.downloadModelButton.disabled = false;
      view.downloadModelButton.textContent = "Try download again";
      view.modelState.textContent = "Speech model required";
    }
  });

  async function refreshAccessibility() {
    accessibilityReady = await native.accessibilityReady().catch(() => false);
    updatePermissionSetup();
  }

  view.runDiagnosticsButton.addEventListener("click", async () => {
    view.runDiagnosticsButton.disabled = true;
    view.diagnosticOutput.classList.remove("hidden");
    view.diagnosticOutput.textContent = "Testing microphone input…";
    logEvent("diagnostics.started");
    let micResult = "FAILED";
    let micPeak = 0;
    let micLabel = "unknown";
    try {
      const signal = await recorder.testSignal();
      micLabel = signal.label;
      micPeak = signal.peak;
      micResult = micPeak > 0.0001 ? "PASS — audio signal detected" : "WARNING — microphone is available, but the room was quiet during this test";
      logEvent("diagnostics.microphone", `${micResult} peak=${micPeak.toFixed(5)} label=${micLabel}`);
    } catch (error) {
      micResult = `FAILED — ${errorDetails(error)}`;
      logEvent("diagnostics.microphone.failed", errorDetails(error));
    }
    const report = await native.diagnostics();
    view.diagnosticOutput.textContent = [
      `SpeakIt ${report.version}`,
      `Microphone: ${micResult}`,
      `Microphone device: ${micLabel}`,
      `Microphone peak: ${micPeak.toFixed(5)}`,
      `Accessibility: ${report.accessibilityReady ? "PASS" : "FAILED"}`,
      `Speech model: ${report.modelReady ? `PASS (${report.modelSizeMb.toFixed(1)} MB)` : "FAILED"}`,
      `Installation: ${report.installLocation}`,
      `Executable: ${report.executablePath}`,
      `Log: ${report.logPath}`,
      "",
      "Recent events:",
      report.recentLog || "No events logged yet.",
    ].join("\n");
    view.runDiagnosticsButton.disabled = false;
  });
  view.copyDiagnosticsButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(view.diagnosticOutput.textContent || "Run the system check first.");
    view.copyDiagnosticsButton.textContent = "Copied";
    window.setTimeout(() => { view.copyDiagnosticsButton.textContent = "Copy"; }, 1200);
  });

  async function initialize() {
    logEvent("app.initialize", `userAgent=${navigator.userAgent}`);
    renderShortcut();
    updatePermissionSetup();
    await refreshAccessibility();
    if (!accessibilityReady) void native.requestAccessibilityPermission();
    try {
      const stream = await requestMicrophoneStream();
      stream.getTracks().forEach((track) => { track.enabled = false; });
      microphoneReady = true;
      settings.microphoneReady = true;
      logEvent("permission.microphone.startup.granted", stream.getAudioTracks()[0]?.label || "audio track");
    } catch (error) {
      microphoneReady = false;
      settings.microphoneReady = false;
      logEvent("permission.microphone.startup.failed", errorDetails(error));
    }
    updatePermissionSetup();
    const installLocation = await native.appInstallLocation().catch(() => "unknown");
    if (installLocation === "disk-image") {
      view.installWarning.textContent = "You are running SpeakIt from the installer. Drag SpeakIt into Applications, quit this copy, and open the Applications copy so macOS grants permission to the correct app.";
      view.installWarning.classList.remove("hidden");
    }
    if (settings.permissionSetupComplete && microphoneReady && accessibilityReady) view.permissionSetup.classList.add("hidden");
    window.setInterval(() => void refreshAccessibility(), 1_200);

    try {
      view.modelState.textContent = "Checking speech model…";
      modelIsReady = await native.modelReady();
      dictation.setModelReady(modelIsReady);
      if (modelIsReady) {
        view.modelSetup.classList.add("hidden");
        view.modelState.textContent = "Preparing Whisper small.en…";
        await native.prepareModel();
        view.modelState.textContent = "Whisper small.en ready";
        await hotkeys.bind(shortcut);
      } else {
        view.modelSetup.classList.remove("hidden");
        view.modelState.textContent = "Speech model required";
      }
    } catch (error) {
      view.modelState.textContent = `Setup needed: ${String(error)}`;
    }
  }

  window.addEventListener("beforeunload", () => recorder.dispose());
  void initialize();
}
