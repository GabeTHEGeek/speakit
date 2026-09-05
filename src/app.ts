import { listen } from "@tauri-apps/api/event";
import { DictationFlow } from "./features/dictation/dictationFlow";
import { errorDetails, logEvent, native } from "./platform/native";
import { AudioRecorder, requestMicrophoneStream } from "./services/audioRecorder";
import { GlobalHotkeys, shortcutFromEvent, shortcutLabel } from "./services/globalHotkeys";
import { settings } from "./services/settings";
import type { SpeechEngine } from "./services/settings";
import { renderMainView } from "./ui/mainView";
import { createHistoryStore } from "./features/history/historyStore";
import { renderHistory } from "./ui/historyView";
import { setupNavigation } from "./ui/navigation";

export function startMainApp(iconUrl: string) {
  const view = renderMainView(iconUrl);
  setupNavigation(view);
  const recorder = new AudioRecorder();
  let shortcut = settings.shortcut;
  let speechEngine: SpeechEngine = settings.speechEngine;
  if (!settings.canaryDefaultApplied) {
    speechEngine = "canary";
    settings.speechEngine = speechEngine;
    settings.canaryDefaultApplied = true;
  }
  let captureShortcut = false;
  let microphoneReady = settings.microphoneReady;
  let accessibilityReady = false;
  let modelIsReady = false;
  let canaryInstalled = false;
  let whisperInstalled = false;

  let dictation: DictationFlow;
  const hotkeys = new GlobalHotkeys(shortcut, () => void dictation.start(true), () => void dictation.stop());
  const history = createHistoryStore(localStorage);
  const refreshHistory = () => renderHistory(view.history, history, (message) => {
    view.statusLabel.textContent = message;
  });
  dictation = new DictationFlow(view, recorder, () => shortcut, () => hotkeys.isHeld, () => speechEngine, (text) => {
    history.add(text);
    refreshHistory();
  });
  refreshHistory();
  dictation.attachManualControls();

  function renderModels() {
    const canarySelected = speechEngine === "canary";
    view.canaryCard.classList.toggle("selected", canarySelected);
    view.whisperCard.classList.toggle("selected", !canarySelected);
    view.canaryState.textContent = canaryInstalled ? "Installed" : "Not installed";
    view.whisperState.textContent = whisperInstalled ? "Installed" : "Not installed";
    view.selectCanary.textContent = canarySelected ? "Selected" : "Use Canary";
    view.selectWhisper.textContent = canarySelected ? "Use Whisper" : "Selected";
    view.selectCanary.disabled = canarySelected;
    view.selectWhisper.disabled = !canarySelected;
    view.selectCanary.classList.toggle("primary", !canarySelected);
    view.selectWhisper.classList.toggle("primary", canarySelected);
    view.downloadCanary.classList.toggle("hidden", canaryInstalled);
    view.downloadWhisper.classList.toggle("hidden", whisperInstalled);
    view.downloadCanary.disabled = false;
    view.downloadWhisper.disabled = false;
    view.downloadCanary.textContent = "Download · 214 MB";
    view.downloadWhisper.textContent = "Download · 466 MB";
  }

  function configureModelSetup(engine: SpeechEngine) {
    const canary = engine === "canary";
    view.modelSetupCopy.textContent = canary
      ? "SpeakIt uses Canary Flash by default. Its free model is about 214 MB and stays entirely on this Mac."
      : "Whisper small.en is about 466 MB and stays entirely on this Mac.";
    view.downloadProgress.style.width = "0";
    view.downloadLabel.textContent = "Ready to download";
    view.downloadModelButton.textContent = `Download ${canary ? "Canary Flash" : "Whisper"}`;
    view.downloadModelButton.disabled = false;
    view.modelSetup.classList.remove("hidden");
  }

  async function selectEngine(next: SpeechEngine) {
    if (!dictation.isReady) return;
    speechEngine = next;
    settings.speechEngine = next;
    modelIsReady = next === "canary" ? canaryInstalled : whisperInstalled;
    dictation.setModelReady(modelIsReady);
    renderModels();
    if (!modelIsReady) {
      configureModelSetup(next);
      dictation.setStatus("error", `Download ${next === "canary" ? "Canary Flash" : "Whisper"} before dictating`);
      window.setTimeout(() => dictation.setStatus("ready", "Focus a text box, then hold the shortcut"), 2200);
      return;
    }
    view.modelSetup.classList.add("hidden");
    view.modelState.textContent = `Preparing ${next === "canary" ? "Canary Flash" : "Whisper small.en"}…`;
    try {
      if (next === "canary") await native.prepareCanaryModel();
      else await native.prepareModel();
      if (!hotkeys.isRegistered) await hotkeys.bind(shortcut);
      view.modelState.textContent = `${next === "canary" ? "Canary Flash (experimental)" : "Whisper small.en"} ready`;
      dictation.setStatus("ready", `${next === "canary" ? "Canary Flash" : "Whisper"} selected`);
    } catch (error) {
      modelIsReady = false;
      dictation.setModelReady(false);
      dictation.setStatus("error", `Could not prepare ${next}: ${String(error)}`);
    }
  }

  view.selectCanary.addEventListener("click", () => void selectEngine("canary"));
  view.selectWhisper.addEventListener("click", () => void selectEngine("whisper"));
  void listen<number>("canary-download-progress", (event) => {
    const percent = Math.round(Math.max(0, Math.min(100, event.payload)));
    view.downloadProgress.style.width = `${percent}%`;
    view.downloadLabel.textContent = `Downloading… ${percent}%`;
    view.downloadCanary.textContent = `Downloading… ${percent}%`;
  });

  async function installEngine(engine: SpeechEngine) {
    speechEngine = engine;
    settings.speechEngine = engine;
    renderModels();
    const action = engine === "canary" ? view.downloadCanary : view.downloadWhisper;
    action.disabled = true;
    action.textContent = "Starting…";
    view.downloadModelButton.disabled = true;
    view.downloadModelButton.textContent = "Downloading…";
    try {
      if (engine === "canary") await native.downloadCanaryModel();
      else await native.downloadModel();
      action.textContent = "Preparing…";
      view.downloadLabel.textContent = "Preparing speech model…";
      if (engine === "canary") {
        await native.prepareCanaryModel();
        canaryInstalled = true;
      } else {
        await native.prepareModel();
        whisperInstalled = true;
      }
      modelIsReady = true;
      dictation.setModelReady(true);
      if (!hotkeys.isRegistered) await hotkeys.bind(shortcut);
      renderModels();
      view.downloadProgress.style.width = "100%";
      view.downloadLabel.textContent = "Download complete";
      view.modelState.textContent = `${engine === "canary" ? "Canary Flash" : "Whisper small.en"} ready`;
      dictation.setStatus("ready", `${engine === "canary" ? "Canary Flash" : "Whisper"} is ready`);
      window.setTimeout(() => view.modelSetup.classList.add("hidden"), 450);
    } catch (error) {
      action.disabled = false;
      action.textContent = "Try again";
      view.downloadModelButton.disabled = false;
      view.downloadModelButton.textContent = "Try download again";
      view.downloadLabel.textContent = `Download failed: ${String(error)}`;
      dictation.setStatus("error", `Model setup failed: ${String(error)}`);
    }
  }

  view.downloadCanary.addEventListener("click", () => void installEngine("canary"));
  view.downloadWhisper.addEventListener("click", () => void installEngine("whisper"));

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
    view.downloadWhisper.textContent = `Downloading… ${Math.round(percent)}%`;
  });
  view.downloadModelButton.addEventListener("click", () => void installEngine(speechEngine));

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
    const report = await native.diagnostics(speechEngine);
    view.diagnosticOutput.textContent = [
      `SpeakIt ${report.version}`,
      `Microphone: ${micResult}`,
      `Microphone device: ${micLabel}`,
      `Microphone peak: ${micPeak.toFixed(5)}`,
      `Accessibility: ${report.accessibilityReady ? "PASS" : "FAILED"}`,
      `Speech model: ${speechEngine === "canary" ? "Canary Flash" : "Whisper small.en"} — ${report.modelReady ? `PASS (${report.modelSizeMb.toFixed(1)} MB)` : "FAILED"}`,
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
    renderModels();
    updatePermissionSetup();
    await refreshAccessibility();
    if (!accessibilityReady) void native.requestAccessibilityPermission();
    try {
      const stream = await requestMicrophoneStream();
      stream.getTracks().forEach((track) => { track.enabled = false; });
      recorder.setPreparedStream(stream);
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
      whisperInstalled = await native.modelReady();
      canaryInstalled = await native.canaryReady().catch(() => false);
      modelIsReady = speechEngine === "canary" ? canaryInstalled : whisperInstalled;
      dictation.setModelReady(modelIsReady);
      renderModels();
      if (modelIsReady) {
        view.modelSetup.classList.add("hidden");
        view.modelState.textContent = `Preparing ${speechEngine === "canary" ? "Canary Flash" : "Whisper small.en"}…`;
        if (speechEngine === "canary") await native.prepareCanaryModel();
        else await native.prepareModel();
        view.modelState.textContent = `${speechEngine === "canary" ? "Canary Flash (experimental)" : "Whisper small.en"} ready`;
        await hotkeys.bind(shortcut);
      } else {
        configureModelSetup(speechEngine);
        view.modelState.textContent = "Speech model required";
      }
    } catch (error) {
      view.modelState.textContent = `Setup needed: ${String(error)}`;
    }
  }

  window.addEventListener("beforeunload", () => recorder.dispose());
  void initialize();
}
