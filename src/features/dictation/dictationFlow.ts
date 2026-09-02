import type { MainView } from "../../ui/mainView";
import type { ActiveTarget, AppStatus, FocusTarget } from "../../types";
import { AudioRecorder } from "../../services/audioRecorder";
import { settings } from "../../services/settings";
import { errorDetails, logEvent, native } from "../../platform/native";

export class DictationFlow {
  private status: AppStatus = "ready";
  private focusTarget: FocusTarget | null = null;
  private targetPid = 0;
  private modelReady = false;
  private manualButtonHeld = false;
  private lastOverlayAnchor = settings.overlayAnchor;

  constructor(
    private view: MainView,
    private recorder: AudioRecorder,
    private shortcutValue: () => string,
    private shortcutHeld: () => boolean,
  ) {}

  get isReady() { return this.status === "ready"; }
  setModelReady(value: boolean) { this.modelReady = value; }

  setStatus(next: AppStatus, message: string) {
    this.status = next;
    document.body.dataset.status = next;
    this.view.statusLabel.textContent = message;
    this.view.recordButton.classList.toggle("active", next === "recording");
  }

  attachManualControls() {
    this.view.recordButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.manualButtonHeld = true;
      void this.start(false);
    });
    window.addEventListener("pointerup", () => {
      this.manualButtonHeld = false;
      void this.stop();
    });
  }

  async start(requireTextField = true) {
    if (this.status !== "ready") return;
    if (!this.modelReady) {
      this.view.modelSetup.classList.remove("hidden");
      this.setStatus("error", "Download the speech model before dictating");
      return;
    }
    this.setStatus("starting", "Starting microphone…");
    try {
      void native.playActivationSound().catch((error) => logEvent("sound.start.failed", errorDetails(error)));
      const shortcut = this.shortcutValue();
      logEvent("recording.start.requested", `shortcut=${shortcut} modelReady=${this.modelReady}`);
      const targetPromise = (requireTextField ? native.frontmostTarget() : native.mainWindowTarget())
        .catch(() => ({ appName: "", pid: 0, anchorX: 0, anchorY: 0 } as ActiveTarget));
      const earlyOverlayPromise = requireTextField
        ? native.showOverlay(this.lastOverlayAnchor.x, this.lastOverlayAnchor.y)
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)))
        : targetPromise
          .then((target) => native.showOverlay(target.anchorX, target.anchorY))
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)));
      if (requireTextField && shortcut.endsWith("+Space") && !/(Command|Control)/.test(shortcut)) {
        await native.eraseTriggerSpace();
      }
      const sampleRate = await this.recorder.start();
      const target = await targetPromise;
      await earlyOverlayPromise;
      await native.showOverlay(target.anchorX, target.anchorY);
      if (requireTextField && (target.anchorX !== 0 || target.anchorY !== 0)) {
        this.lastOverlayAnchor = { x: target.anchorX, y: target.anchorY };
        settings.overlayAnchor = this.lastOverlayAnchor;
      }
      this.targetPid = target.pid;
      this.focusTarget = { appName: target.appName || "your active app", role: "", canPaste: requireTextField };
      logEvent("recording.started", `sampleRate=${sampleRate} target=${this.focusTarget.appName} pid=${this.targetPid} anchorX=${target.anchorX.toFixed(1)} anchorY=${target.anchorY.toFixed(1)}`);
      this.setStatus("recording", this.focusTarget.canPaste ? `Listening for ${this.focusTarget.appName}…` : "Listening…");
      if (requireTextField && !this.shortcutHeld()) await this.stop();
      if (!requireTextField && !this.manualButtonHeld) await this.stop();
    } catch (error) {
      logEvent("recording.start.failed", errorDetails(error));
      await native.hideOverlay().catch(() => undefined);
      this.setStatus("error", String(error).includes("Accessibility") ? "Enable Accessibility access for SpeakIt" : "Microphone access is needed");
      setTimeout(() => this.setStatus("ready", "Focus a text box, then hold the shortcut"), 2800);
    }
  }

  async stop() {
    if (this.status !== "recording") return;
    this.setStatus("transcribing", "Turning speech into text…");
    void native.playStopSound().catch((error) => logEvent("sound.stop.failed", errorDetails(error)));
    await native.hideOverlay();
    const recording = await this.recorder.stop();
    if (!recording) return;
    logEvent("recording.stopped", `inputSamples=${recording.inputSamples} outputSamples=${recording.downsampled.length} inputRate=${recording.inputRate}`);
    if (recording.downsampled.length < 4000) {
      this.setStatus("ready", "Too short — try again");
      return;
    }
    let text: string;
    try {
      logEvent("transcription.requested", `samples=${recording.downsampled.length}`);
      text = await native.transcribe(recording.downsampled);
      logEvent("transcription.succeeded", `chars=${text.length}`);
      this.view.transcript.textContent = text || "No speech detected.";
      this.view.transcript.classList.remove("placeholder");
    } catch (error) {
      logEvent("transcription.failed", errorDetails(error));
      this.view.transcript.textContent = String(error);
      this.view.transcript.classList.remove("placeholder");
      this.setStatus("error", `Transcription failed: ${String(error)}`);
      setTimeout(() => this.setStatus("ready", "Focus a text box, then hold the shortcut"), 2500);
      return;
    }
    if (!text) {
      this.setStatus("ready", "No speech detected");
      return;
    }
    if (!this.focusTarget?.canPaste) {
      this.setStatus("ready", "Copied — test dictation complete");
      return;
    }
    try {
      logEvent("paste.requested", `target=${this.focusTarget.appName} pid=${this.targetPid}`);
      const result = await native.pasteText(text, this.focusTarget.appName, this.targetPid);
      logEvent("paste.succeeded", `target=${this.focusTarget.appName} role=${result.focusedRole} subrole=${result.focusedSubrole}`);
      this.setStatus("ready", "Pasted into your focused text field");
    } catch (error) {
      logEvent("paste.failed", errorDetails(error));
      this.setStatus("error", `Copied, but automatic paste failed: ${String(error)}`);
      setTimeout(() => this.setStatus("ready", "Press ⌘ V to paste the copied text"), 3200);
    }
  }
}
