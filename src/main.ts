import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./styles.css";

type AppStatus = "ready" | "starting" | "recording" | "transcribing" | "error";
type FocusTarget = { appName: string; role: string; canPaste: boolean };
type ActiveTarget = { appName: string; pid: number; anchorX: number; anchorY: number };
type PasteResult = { focusedRole: string; focusedSubrole: string };
type DiagnosticReport = {
  version: string; accessibilityReady: boolean; modelReady: boolean; modelSizeMb: number;
  installLocation: string; executablePath: string; logPath: string; recentLog: string;
};
const currentWindow = getCurrentWindow();

if (currentWindow.label === "overlay") renderOverlay();
else renderMainApp();

function renderOverlay() {
  document.documentElement.className = "overlay-html";
  document.body.className = "overlay-body";
  document.body.dataset.visible = "false";
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div class="voice-cube">
      <div class="waveform" aria-label="Live microphone level">
        ${Array.from({ length: 25 }, (_, index) => `<i style="--i:${index}"></i>`).join("")}
      </div>
      <strong>Listening</strong>
    </div>`;
  const bars = [...document.querySelectorAll<HTMLElement>(".waveform i")];
  let level = 0.08;
  let overlayVisible = false;
  let animationFrame: number | null = null;
  void listen<number>("waveform-level", (event) => { level = Math.max(0.06, Math.min(1, event.payload)); });
  void listen<boolean>("overlay-visibility", (event) => {
    overlayVisible = event.payload;
    document.body.dataset.visible = String(overlayVisible);
    if (overlayVisible && animationFrame === null) animationFrame = requestAnimationFrame(animate);
    if (!overlayVisible && animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      bars.forEach((bar) => { bar.style.transform = "scaleY(.2)"; });
    }
  });
  void (async () => {
    await currentWindow.setIgnoreCursorEvents(true).catch(() => undefined);
  })();
  const animate = () => {
    if (!overlayVisible) {
      animationFrame = null;
      return;
    }
    const now = performance.now() / 120;
    bars.forEach((bar, index) => {
      const shape = 0.38 + Math.abs(Math.sin(now + index * 0.72)) * 0.62;
      bar.style.transform = `scaleY(${0.18 + level * shape * 1.35})`;
    });
    animationFrame = requestAnimationFrame(animate);
  };
}

function renderMainApp() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <main class="shell">
      <header>
        <div class="brand"><span class="brand-mark">S</span><span>SpeakIt</span></div>
        <span class="local-pill"><i></i> 100% local</span>
      </header>
      <section class="hero">
        <div class="eyebrow">VOICE TO TEXT, INSTANTLY</div>
        <h1>Say it.<br><em>We'll type it.</em></h1>
        <p>Focus any text box, hold your shortcut, and speak. SpeakIt puts the words exactly where your cursor is.</p>
        <button id="record" class="record-button" type="button" aria-label="Hold to test dictation"><span class="mic">●</span></button>
        <div id="status" class="status">Focus a text box, then hold the shortcut</div>
        <div id="shortcut-display" class="shortcut"></div>
      </section>
      <section class="settings-card">
        <div><strong>Dictation shortcut</strong><span>Click the field, then press your preferred shortcut.</span></div>
        <button id="shortcut-editor" class="shortcut-editor" type="button">⌘ ⇧ Space</button>
      </section>
      <section class="settings-card diagnostics-card">
        <div><strong>System diagnostics</strong><span>Test permissions, microphone input, model, and paste logging.</span></div>
        <div class="diagnostic-actions"><button id="run-diagnostics" type="button">Run check</button><button id="copy-diagnostics" type="button">Copy</button></div>
        <pre id="diagnostic-output" class="hidden"></pre>
      </section>
      <section class="result-card">
        <div class="result-heading"><span>Latest dictation</span><button id="copy" type="button">Copy</button></div>
        <p id="transcript" class="placeholder">Your latest transcription will appear here.</p>
      </section>
      <footer><span>No cloud. No account. No subscription.</span><span id="model-state">Checking speech model…</span></footer>
    </main>
    <div id="permission-setup" class="permission-setup">
      <section class="permission-panel">
        <div class="permission-logo">S</div>
        <div class="eyebrow">QUICK SETUP</div>
        <h2>Give SpeakIt permission<br>to listen and type.</h2>
        <p>Both permissions stay on your Mac and are required before dictation can work.</p>
        <button id="enable-mic" class="permission-row" type="button">
          <span class="permission-icon">◉</span><span><strong>Microphone</strong><small>Record only while your shortcut is held</small></span><b id="mic-check">Enable</b>
        </button>
        <button id="enable-access" class="permission-row" type="button">
          <span class="permission-icon">⌨</span><span><strong>Accessibility</strong><small>Find your active app and paste your words</small></span><b id="access-check">Enable</b>
        </button>
        <button id="finish-setup" class="finish-setup" type="button" disabled>Finish setup</button>
        <div id="install-warning" class="install-warning hidden"></div>
        <small class="permission-help">After enabling Accessibility in System Settings, return here. SpeakIt checks automatically.</small>
      </section>
    </div>
    <div id="model-setup" class="permission-setup model-setup">
      <section class="permission-panel">
        <div class="permission-logo">↓</div>
        <div class="eyebrow">LOCAL SPEECH MODEL</div>
        <h2>Download transcription<br>before you begin.</h2>
        <p>SpeakIt needs the free Whisper small English model. It is about 466 MB and stays entirely on this Mac.</p>
        <div class="download-track"><i id="download-progress"></i></div>
        <div id="download-label" class="download-label">Ready to download</div>
        <button id="download-model" class="finish-setup" type="button">Download model</button>
        <small class="permission-help">Dictation remains disabled until the model is completely downloaded.</small>
      </section>
    </div>`;

  const recordButton = document.querySelector<HTMLButtonElement>("#record")!;
  const statusLabel = document.querySelector<HTMLDivElement>("#status")!;
  const transcript = document.querySelector<HTMLParagraphElement>("#transcript")!;
  const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
  const modelState = document.querySelector<HTMLSpanElement>("#model-state")!;
  const shortcutEditor = document.querySelector<HTMLButtonElement>("#shortcut-editor")!;
  const shortcutDisplay = document.querySelector<HTMLDivElement>("#shortcut-display")!;
  const permissionSetup = document.querySelector<HTMLDivElement>("#permission-setup")!;
  const enableMic = document.querySelector<HTMLButtonElement>("#enable-mic")!;
  const enableAccess = document.querySelector<HTMLButtonElement>("#enable-access")!;
  const micCheck = document.querySelector<HTMLElement>("#mic-check")!;
  const accessCheck = document.querySelector<HTMLElement>("#access-check")!;
  const finishSetup = document.querySelector<HTMLButtonElement>("#finish-setup")!;
  const installWarning = document.querySelector<HTMLDivElement>("#install-warning")!;
  const modelSetup = document.querySelector<HTMLDivElement>("#model-setup")!;
  const downloadModelButton = document.querySelector<HTMLButtonElement>("#download-model")!;
  const downloadProgress = document.querySelector<HTMLElement>("#download-progress")!;
  const downloadLabel = document.querySelector<HTMLDivElement>("#download-label")!;
  const runDiagnosticsButton = document.querySelector<HTMLButtonElement>("#run-diagnostics")!;
  const copyDiagnosticsButton = document.querySelector<HTMLButtonElement>("#copy-diagnostics")!;
  const diagnosticOutput = document.querySelector<HTMLPreElement>("#diagnostic-output")!;

  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let preparedStream: MediaStream | null = null;
  let samples: Float32Array[] = [];
  let status: AppStatus = "ready";
  let focusTarget: FocusTarget | null = null;
  let targetPid = 0;
  let shortcut = localStorage.getItem("dictationShortcut") || "CommandOrControl+Shift+Space";
  let lastOverlayAnchorX = Number(localStorage.getItem("lastOverlayAnchorX")) || 0;
  let lastOverlayAnchorY = Number(localStorage.getItem("lastOverlayAnchorY")) || 0;
  let lastLevelUpdate = 0;
  let shortcutHeld = false;
  let manualButtonHeld = false;
  let captureShortcut = false;
  let microphoneReady = localStorage.getItem("microphoneReady") === "true";
  let accessibilityReady = false;
  let modelIsReady = false;
  let shortcutRegistered = false;
  let shortcutRecoveryInProgress = false;
  let shortcutSafetyTimer: number | null = null;
  let microphoneReleaseTimer: number | null = null;
  const microphoneConstraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const microphoneIdleReleaseMs = 60_000;

  function errorDetails(error: unknown) {
    if (error instanceof DOMException) return `${error.name}: ${error.message}`;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }

  function logEvent(event: string, details = "") {
    void invoke("log_event", { event, details }).catch(() => undefined);
  }

  function cancelMicrophoneRelease() {
    if (microphoneReleaseTimer !== null) window.clearTimeout(microphoneReleaseTimer);
    microphoneReleaseTimer = null;
  }

  async function acquirePreparedStream() {
    cancelMicrophoneRelease();
    if (!preparedStream || !preparedStream.active) {
      preparedStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints });
      logEvent("microphone.acquired", "raw mono; voice processing disabled");
    }
    return preparedStream;
  }

  function scheduleMicrophoneRelease(reason: string) {
    cancelMicrophoneRelease();
    microphoneReleaseTimer = window.setTimeout(() => {
      microphoneReleaseTimer = null;
      if (status === "starting" || status === "recording") {
        scheduleMicrophoneRelease("recording still active");
        return;
      }
      preparedStream?.getTracks().forEach((track) => track.stop());
      preparedStream = null;
      logEvent("microphone.released", `reason=${reason} idle_ms=${microphoneIdleReleaseMs}`);
    }, microphoneIdleReleaseMs);
  }

  function setStatus(next: AppStatus, message: string) {
    status = next;
    document.body.dataset.status = next;
    statusLabel.textContent = message;
    recordButton.classList.toggle("active", next === "recording");
  }

  function shortcutLabel(value: string) {
    return value.split("+").map((part) => ({
      CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Shift: "⇧", Alt: "⌥", Option: "⌥", Space: "Space",
    }[part] || part.replace(/^Key/, ""))).join(" ");
  }

  function renderShortcut() {
    const parts = shortcutLabel(shortcut).split(" ");
    shortcutDisplay.innerHTML = `${parts.map((part) => `<kbd>${part}</kbd>`).join("")}<span>Hold anywhere</span>`;
    shortcutEditor.textContent = shortcutLabel(shortcut);
  }

  async function showOverlay(anchorX: number, anchorY: number) {
    await invoke("show_overlay", { anchorX, anchorY });
  }

  async function hideOverlay() {
    await invoke("hide_overlay");
  }

  async function startRecording(requireTextField = true) {
    if (status !== "ready") return;
    if (!modelIsReady) {
      modelSetup.classList.remove("hidden");
      setStatus("error", "Download the speech model before dictating");
      return;
    }
    setStatus("starting", "Starting microphone…");
    try {
      void invoke("play_activation_sound").catch((error) => logEvent("sound.start.failed", errorDetails(error)));
      logEvent("recording.start.requested", `shortcut=${shortcut} modelReady=${modelIsReady}`);
      const targetPromise = invoke<ActiveTarget>(requireTextField ? "frontmost_target" : "main_window_target")
        .catch(() => ({ appName: "", pid: 0, anchorX: 0, anchorY: 0 }));
      const earlyOverlayPromise = requireTextField
        ? showOverlay(lastOverlayAnchorX, lastOverlayAnchorY)
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)))
        : targetPromise
          .then((target) => showOverlay(target.anchorX, target.anchorY))
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)));
      if (requireTextField && shortcut.endsWith("+Space") && !/(Command|Control)/.test(shortcut)) {
        await invoke("erase_trigger_space");
      }
      preparedStream = await acquirePreparedStream();
      preparedStream.getTracks().forEach((track) => { track.enabled = true; });
      mediaStream = preparedStream;
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(mediaStream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      samples = [];
      processor.onaudioprocess = (event) => {
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        samples.push(chunk);
        const now = performance.now();
        if (now - lastLevelUpdate > 55) {
          let power = 0;
          for (let i = 0; i < chunk.length; i += 8) power += chunk[i] * chunk[i];
          const rms = Math.sqrt(power / Math.ceil(chunk.length / 8));
          void emitTo("overlay", "waveform-level", Math.min(1, rms * 9));
          lastLevelUpdate = now;
        }
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      const target = await targetPromise;
      await earlyOverlayPromise;
      await showOverlay(target.anchorX, target.anchorY);
      if (requireTextField && (target.anchorX !== 0 || target.anchorY !== 0)) {
        lastOverlayAnchorX = target.anchorX;
        lastOverlayAnchorY = target.anchorY;
        localStorage.setItem("lastOverlayAnchorX", String(target.anchorX));
        localStorage.setItem("lastOverlayAnchorY", String(target.anchorY));
      }
      targetPid = target.pid;
      focusTarget = { appName: target.appName || "your active app", role: "", canPaste: requireTextField };
      logEvent("recording.started", `sampleRate=${audioContext.sampleRate} target=${focusTarget.appName} pid=${targetPid} anchorX=${target.anchorX.toFixed(1)} anchorY=${target.anchorY.toFixed(1)}`);
      setStatus("recording", focusTarget.canPaste ? `Listening for ${focusTarget.appName}…` : "Listening…");
      if (requireTextField && !shortcutHeld) await stopRecording();
      if (!requireTextField && !manualButtonHeld) await stopRecording();
    } catch (error) {
      logEvent("recording.start.failed", errorDetails(error));
      await hideOverlay().catch(() => undefined);
      setStatus("error", String(error).includes("Accessibility") ? "Enable Accessibility access for SpeakIt" : "Microphone access is needed");
      setTimeout(() => setStatus("ready", "Focus a text box, then hold the shortcut"), 2800);
    }
  }

  async function stopRecording() {
    if (status !== "recording" || !audioContext) return;
    const activeAudioContext = audioContext;
    audioContext = null;
    setStatus("transcribing", "Turning speech into text…");
    void invoke("play_stop_sound").catch((error) => logEvent("sound.stop.failed", errorDetails(error)));
    await hideOverlay();
    const inputRate = activeAudioContext.sampleRate;
    processor?.disconnect();
    source?.disconnect();
    mediaStream?.getTracks().forEach((track) => { track.enabled = false; });
    scheduleMicrophoneRelease("dictation complete");
    await activeAudioContext.close();
    const merged = mergeSamples(samples);
    const downsampled = downsample(merged, inputRate, 16000);
    logEvent("recording.stopped", `inputSamples=${merged.length} outputSamples=${downsampled.length} inputRate=${inputRate}`);
    processor = null; source = null; mediaStream = null;
    if (downsampled.length < 4000) { setStatus("ready", "Too short — try again"); return; }
    let text: string;
    try {
      logEvent("transcription.requested", `samples=${downsampled.length}`);
      text = await invoke<string>("transcribe", { samples: Array.from(downsampled) });
      logEvent("transcription.succeeded", `chars=${text.length}`);
      transcript.textContent = text || "No speech detected.";
      transcript.classList.remove("placeholder");
    } catch (error) {
      logEvent("transcription.failed", errorDetails(error));
      transcript.textContent = String(error);
      transcript.classList.remove("placeholder");
      setStatus("error", `Transcription failed: ${String(error)}`);
      setTimeout(() => setStatus("ready", "Focus a text box, then hold the shortcut"), 2500);
      return;
    }
    if (!text) {
      setStatus("ready", "No speech detected");
      return;
    }
    if (!focusTarget?.canPaste) {
      setStatus("ready", "Copied — test dictation complete");
      return;
    }
    try {
      logEvent("paste.requested", `target=${focusTarget.appName} pid=${targetPid}`);
      const result = await invoke<PasteResult>("paste_text", { text, appName: focusTarget.appName, targetPid });
      logEvent("paste.succeeded", `target=${focusTarget.appName} role=${result.focusedRole} subrole=${result.focusedSubrole}`);
      setStatus("ready", "Pasted into your focused text field");
    } catch (error) {
      logEvent("paste.failed", errorDetails(error));
      setStatus("error", `Copied, but automatic paste failed: ${String(error)}`);
      setTimeout(() => setStatus("ready", "Press ⌘ V to paste the copied text"), 3200);
    }
  }

  async function bindShortcut(value: string, previous?: string) {
    if (previous && await isRegistered(previous).catch(() => false)) await unregister(previous);
    try {
      await register(value, (event) => {
        if (event.state === "Pressed" && !shortcutHeld) {
          logEvent("shortcut.pressed", event.shortcut);
          shortcutHeld = true;
          if (shortcutSafetyTimer !== null) window.clearTimeout(shortcutSafetyTimer);
          shortcutSafetyTimer = window.setTimeout(() => {
            if (!shortcutHeld) return;
            shortcutHeld = false;
            logEvent("shortcut.safety_reset", event.shortcut);
            void stopRecording();
          }, 60_000);
          void startRecording(true);
        }
        if (event.state === "Released" && shortcutHeld) {
          logEvent("shortcut.released", event.shortcut);
          shortcutHeld = false;
          if (shortcutSafetyTimer !== null) window.clearTimeout(shortcutSafetyTimer);
          shortcutSafetyTimer = null;
          void stopRecording();
        }
      });
      shortcutRegistered = true;
      logEvent("shortcut.registered", value);
    } catch (error) {
      shortcutRegistered = false;
      logEvent("shortcut.registration_failed", `${value} ${errorDetails(error)}`);
      if (previous) await bindShortcut(previous);
      throw error;
    }
  }

  async function ensureShortcutRegistration(reason: string) {
    if (!modelIsReady || captureShortcut || shortcutRecoveryInProgress) return;
    shortcutRecoveryInProgress = true;
    try {
      const registered = await isRegistered(shortcut);
      shortcutRegistered = registered;
      if (registered) return;
      shortcutHeld = false;
      await bindShortcut(shortcut);
      logEvent("shortcut.recovered", reason);
    } catch (error) {
      shortcutRegistered = false;
      logEvent("shortcut.recovery_failed", `${reason} ${errorDetails(error)}`);
      if (status === "ready") {
        setStatus("error", "Shortcut unavailable — quit other SpeakIt copies and reopen");
      }
    } finally {
      shortcutRecoveryInProgress = false;
    }
  }

  window.addEventListener("focus", () => void ensureShortcutRegistration("window.focus"));
  window.addEventListener("blur", () => window.setTimeout(() => void ensureShortcutRegistration("window.blur"), 150));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ensureShortcutRegistration("document.visible");
  });
  window.setInterval(() => void ensureShortcutRegistration("watchdog"), 5_000);

  function shortcutFromEvent(event: KeyboardEvent) {
    const modifiers: string[] = [];
    if (event.metaKey) modifiers.push("CommandOrControl");
    if (event.ctrlKey && !event.metaKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
    if (!modifiers.length) throw new Error("Include at least one modifier key");
    const key = event.code === "Space" ? "Space" : event.code.replace(/^Key/, "").replace(/^Digit/, "");
    return [...modifiers, key].join("+");
  }

  shortcutEditor.addEventListener("click", () => {
    captureShortcut = true;
    shortcutEditor.classList.add("capturing");
    shortcutEditor.textContent = "Hold modifiers…";
    shortcutEditor.focus();
  });
  shortcutEditor.addEventListener("blur", () => { captureShortcut = false; shortcutEditor.classList.remove("capturing"); renderShortcut(); });
  document.addEventListener("keydown", async (event) => {
    if (!captureShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const next = shortcutFromEvent(event);
      if (!next) {
        const held = [event.metaKey && "⌘", event.ctrlKey && "⌃", event.altKey && "⌥", event.shiftKey && "⇧"].filter(Boolean).join(" ");
        shortcutEditor.textContent = held || "Hold modifiers…";
        return;
      }
      const previous = shortcut;
      await bindShortcut(next, previous);
      shortcut = next;
      localStorage.setItem("dictationShortcut", shortcut);
      captureShortcut = false; shortcutEditor.classList.remove("capturing"); shortcutEditor.blur(); renderShortcut();
      setStatus("ready", `Shortcut changed to ${shortcutLabel(shortcut)}`);
    } catch (error) { setStatus("error", String(error)); renderShortcut(); }
  }, true);

  recordButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    manualButtonHeld = true;
    void startRecording(false);
  });
  window.addEventListener("pointerup", () => {
    manualButtonHeld = false;
    void stopRecording();
  });
  copyButton.addEventListener("click", async () => {
    if (!transcript.classList.contains("placeholder")) await navigator.clipboard.writeText(transcript.textContent || "");
  });

  function updatePermissionSetup() {
    micCheck.textContent = microphoneReady ? "✓ Ready" : "Enable";
    accessCheck.textContent = accessibilityReady ? "✓ Ready" : "Enable";
    micCheck.classList.toggle("granted", microphoneReady);
    accessCheck.classList.toggle("granted", accessibilityReady);
    finishSetup.disabled = !(microphoneReady && accessibilityReady);
    finishSetup.textContent = accessibilityReady ? "Finish setup" : "Enable Accessibility to continue";
  }

  enableMic.addEventListener("click", async () => {
    try {
      enableMic.disabled = true;
      micCheck.textContent = "Waiting…";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints });
      stream.getTracks().forEach((track) => { track.enabled = false; });
      preparedStream = stream;
      scheduleMicrophoneRelease("permission setup");
      microphoneReady = true;
      localStorage.setItem("microphoneReady", "true");
      logEvent("permission.microphone.granted", stream.getAudioTracks()[0]?.label || "audio track");
    } catch (error) {
      microphoneReady = false;
      localStorage.removeItem("microphoneReady");
      logEvent("permission.microphone.failed", errorDetails(error));
      micCheck.textContent = "Try again";
    } finally {
      enableMic.disabled = false;
      updatePermissionSetup();
    }
  });

  enableAccess.addEventListener("click", async () => {
    accessCheck.textContent = "Open Settings…";
    await invoke("request_accessibility_permission");
  });

  finishSetup.addEventListener("click", () => {
    localStorage.setItem("permissionSetupComplete", "true");
    permissionSetup.classList.add("hidden");
  });

  void listen<number>("model-download-progress", (event) => {
    const percent = Math.max(0, Math.min(100, event.payload));
    downloadProgress.style.width = `${percent}%`;
    downloadLabel.textContent = `Downloading… ${Math.round(percent)}%`;
  });

  downloadModelButton.addEventListener("click", async () => {
    downloadModelButton.disabled = true;
    downloadModelButton.textContent = "Downloading…";
    downloadLabel.textContent = "Starting download…";
    modelState.textContent = "Downloading Whisper small.en…";
    try {
      await invoke("download_model");
      modelIsReady = true;
      downloadProgress.style.width = "100%";
      downloadLabel.textContent = "Preparing speech model…";
      modelState.textContent = "Preparing Whisper small.en…";
      await invoke("prepare_model");
      downloadLabel.textContent = "Download complete";
      modelState.textContent = "Whisper small.en ready";
      if (!shortcutRegistered) {
        await bindShortcut(shortcut);
        shortcutRegistered = true;
      }
      window.setTimeout(() => modelSetup.classList.add("hidden"), 450);
    } catch (error) {
      downloadLabel.textContent = `Download failed: ${String(error)}`;
      downloadModelButton.disabled = false;
      downloadModelButton.textContent = "Try download again";
      modelState.textContent = "Speech model required";
    }
  });

  async function refreshAccessibility() {
    accessibilityReady = await invoke<boolean>("accessibility_ready").catch(() => false);
    updatePermissionSetup();
  }

  async function runDiagnostics() {
    runDiagnosticsButton.disabled = true;
    diagnosticOutput.classList.remove("hidden");
    diagnosticOutput.textContent = "Testing microphone input…";
    logEvent("diagnostics.started");
    let micResult = "FAILED";
    let micPeak = 0;
    let micLabel = "unknown";
    try {
      preparedStream = await acquirePreparedStream();
      preparedStream.getTracks().forEach((track) => { track.enabled = true; });
      micLabel = preparedStream.getAudioTracks()[0]?.label || "audio track";
      const testContext = new AudioContext();
      const analyser = testContext.createAnalyser();
      analyser.fftSize = 1024;
      const testSource = testContext.createMediaStreamSource(preparedStream);
      testSource.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      for (let pass = 0; pass < 8; pass++) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        analyser.getFloatTimeDomainData(buffer);
        let power = 0;
        for (const sample of buffer) power += sample * sample;
        micPeak = Math.max(micPeak, Math.sqrt(power / buffer.length));
      }
      testSource.disconnect();
      await testContext.close();
      preparedStream.getTracks().forEach((track) => { track.enabled = false; });
      scheduleMicrophoneRelease("diagnostics complete");
      micResult = micPeak > 0.0001
        ? "PASS — audio signal detected"
        : "WARNING — microphone is available, but the room was quiet during this test";
      logEvent("diagnostics.microphone", `${micResult} peak=${micPeak.toFixed(5)} label=${micLabel}`);
    } catch (error) {
      micResult = `FAILED — ${errorDetails(error)}`;
      logEvent("diagnostics.microphone.failed", errorDetails(error));
    }
    const report = await invoke<DiagnosticReport>("diagnostics");
    diagnosticOutput.textContent = [
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
    runDiagnosticsButton.disabled = false;
  }

  runDiagnosticsButton.addEventListener("click", () => void runDiagnostics());
  copyDiagnosticsButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(diagnosticOutput.textContent || "Run the system check first.");
    copyDiagnosticsButton.textContent = "Copied";
    window.setTimeout(() => { copyDiagnosticsButton.textContent = "Copy"; }, 1200);
  });

  async function initialize() {
    logEvent("app.initialize", `userAgent=${navigator.userAgent}`);
    renderShortcut();
    updatePermissionSetup();
    await refreshAccessibility();
    if (!accessibilityReady) void invoke("request_accessibility_permission");
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints });
      permissionStream.getTracks().forEach((track) => { track.enabled = false; });
      preparedStream = permissionStream;
      scheduleMicrophoneRelease("startup permission check");
      microphoneReady = true;
      localStorage.setItem("microphoneReady", "true");
      logEvent("permission.microphone.startup.granted", permissionStream.getAudioTracks()[0]?.label || "audio track");
      updatePermissionSetup();
    } catch (error) {
      microphoneReady = false;
      localStorage.removeItem("microphoneReady");
      logEvent("permission.microphone.startup.failed", errorDetails(error));
      updatePermissionSetup();
    }
    const location = await invoke<string>("app_install_location").catch(() => "unknown");
    if (location === "disk-image") {
      installWarning.textContent = "You are running SpeakIt from the installer. Drag SpeakIt into Applications, quit this copy, and open the Applications copy so macOS grants permission to the correct app.";
      installWarning.classList.remove("hidden");
    }
    window.setInterval(() => void refreshAccessibility(), 1200);
    if (localStorage.getItem("permissionSetupComplete") === "true" && microphoneReady && accessibilityReady) {
      permissionSetup.classList.add("hidden");
    }
    try {
      modelState.textContent = "Checking speech model…";
      const ready = await invoke<boolean>("model_ready");
      modelIsReady = ready;
      if (ready) {
        modelSetup.classList.add("hidden");
        modelState.textContent = "Preparing Whisper small.en…";
        await invoke("prepare_model");
        modelState.textContent = "Whisper small.en ready";
        await bindShortcut(shortcut);
        shortcutRegistered = true;
      } else {
        modelSetup.classList.remove("hidden");
        modelState.textContent = "Speech model required";
      }
    } catch (error) { modelState.textContent = `Setup needed: ${String(error)}`; }
  }
  window.addEventListener("beforeunload", () => {
    cancelMicrophoneRelease();
    preparedStream?.getTracks().forEach((track) => track.stop());
  });
  void initialize();
}

function mergeSamples(chunks: Float32Array[]) {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
  }
  return output;
}
