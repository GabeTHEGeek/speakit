import type { MainView } from "../../ui/mainView";
import type { ActiveTarget, AppStatus, FocusTarget } from "../../types";
import { AudioRecorder } from "../../services/audioRecorder";
import { settings } from "../../services/settings";
import type { SpeechEngine } from "../../services/settings";
import { errorDetails, logEvent, native } from "../../platform/native";

type CompletedRecording = NonNullable<Awaited<ReturnType<AudioRecorder["stop"]>>>;

export class DictationFlow {
  private status: AppStatus = "ready";
  private focusTarget: FocusTarget | null = null;
  private targetPid = 0;
  private modelReady = false;
  private manualButtonHeld = false;
  private startCanceled = false;
  private lastOverlayAnchor = settings.overlayAnchor;
  private processingQueue: Promise<void> = Promise.resolve();
  private pendingProcessing = 0;
  private lastProcessingMessage = "Focus a text box, then hold the shortcut";

  constructor(
    private view: MainView,
    private recorder: AudioRecorder,
    private shortcutValue: () => string,
    private shortcutHeld: () => boolean,
    private speechEngine: () => SpeechEngine,
    private onTranscript: (text: string) => void,
    private commands: typeof native = native,
  ) {}

  get isReady() { return this.status === "ready"; }
  setModelReady(value: boolean) { this.modelReady = value; }

  setStatus(next: AppStatus, message: string) {
    this.status = next;
    document.body.dataset.status = next;
    this.view.statusLabel.textContent = message;
    this.view.recordButton.classList.toggle("active", next === "recording");
    this.view.runDiagnosticsButton.disabled = next !== "ready";
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

  async start(requireTextField = true, microphoneRetry = 0): Promise<void> {
    if (this.status !== "ready") return;
    if (!this.modelReady) {
      this.view.modelSetup.classList.remove("hidden");
      this.setStatus("error", "Download the speech model before dictating");
      return;
    }
    this.startCanceled = false;
    this.setStatus("starting", "Starting microphone…");
    try {
      if (microphoneRetry === 0) {
        void this.commands.playActivationSound().catch((error) => logEvent("sound.start.failed", errorDetails(error)));
      }
      const shortcut = this.shortcutValue();
      logEvent("recording.start.requested", `shortcut=${shortcut} modelReady=${this.modelReady}`);
      const targetPromise = (requireTextField ? this.commands.frontmostTarget() : this.commands.mainWindowTarget())
        .catch(() => ({ appName: "", pid: 0, anchorX: 0, anchorY: 0 } as ActiveTarget));
      const earlyOverlayPromise = requireTextField
        ? this.commands.showOverlay(this.lastOverlayAnchor.x, this.lastOverlayAnchor.y)
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)))
        : targetPromise
          .then((target) => this.commands.showOverlay(target.anchorX, target.anchorY))
          .catch((error) => logEvent("overlay.early.failed", errorDetails(error)));
      const sampleRate = await this.recorder.start();
      if (this.startCanceled || (requireTextField && !this.shortcutHeld()) || (!requireTextField && !this.manualButtonHeld)) {
        await this.recorder.stop();
        await this.commands.hideOverlay().catch(() => undefined);
        this.setStatus("ready", "Focus a text box, then hold the shortcut");
        return;
      }
      const target = await targetPromise;
      await earlyOverlayPromise;
      await this.commands.showOverlay(target.anchorX, target.anchorY);
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
      if (this.startCanceled || String(error).includes("Recording start canceled")) {
        logEvent("recording.start.canceled");
        await this.commands.hideOverlay().catch(() => undefined);
        this.setStatus("ready", "Focus a text box, then hold the shortcut");
        return;
      }
      logEvent("recording.start.failed", errorDetails(error));
      await this.commands.hideOverlay().catch(() => undefined);
      const microphoneStalled = String(error).includes("did not respond");
      const activationHeld = requireTextField ? this.shortcutHeld() : this.manualButtonHeld;
      if (microphoneStalled && microphoneRetry === 0 && activationHeld) {
        logEvent("recording.start.retry", "microphone stalled; retrying once while shortcut remains held");
        this.setStatus("starting", "Retrying microphone…");
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        const stillHeld = requireTextField ? this.shortcutHeld() : this.manualButtonHeld;
        if (this.startCanceled || !stillHeld) {
          this.setStatus("ready", "Focus a text box, then hold the shortcut");
          return;
        }
        this.setStatus("ready", "Retrying microphone…");
        return this.start(requireTextField, 1);
      }
      const message = microphoneStalled
        ? "Microphone is busy — try again after the call app releases it"
        : String(error).includes("Accessibility") ? "Enable Accessibility access for SpeakIt" : "Microphone access is needed";
      this.setStatus("error", message);
      setTimeout(() => this.setStatus("ready", "Focus a text box, then hold the shortcut"), 1200);
    }
  }

  async stop() {
    if (this.status === "starting") {
      this.startCanceled = true;
      this.recorder.cancelPendingStart();
      this.setStatus("starting", "Canceling microphone start…");
      await this.commands.hideOverlay().catch(() => undefined);
      return;
    }
    if (this.status !== "recording") return;
    this.setStatus("transcribing", "Turning speech into text…");
    void this.commands.playStopSound().catch((error) => logEvent("sound.stop.failed", errorDetails(error)));
    await this.commands.hideOverlay();
    const recording = await this.recorder.stop();
    if (!recording) return;
    logEvent("recording.stopped", `inputSamples=${recording.inputSamples} outputSamples=${recording.downsampled.length} inputRate=${recording.inputRate}`);
    if (recording.downsampled.length < 4000) {
      this.setStatus("ready", "Too short — try again");
      return;
    }
    const focusTarget = this.focusTarget;
    const targetPid = this.targetPid;
    const engine = this.speechEngine();
    this.focusTarget = null;
    this.targetPid = 0;
    this.enqueueProcessing(recording, focusTarget, targetPid, engine);
    this.setStatus("ready", this.pendingProcessing === 1 ? "Processing previous dictation…" : `${this.pendingProcessing} dictations processing…`);
  }

  private enqueueProcessing(
    recording: CompletedRecording,
    focusTarget: FocusTarget | null,
    targetPid: number,
    engine: SpeechEngine,
  ) {
    this.pendingProcessing += 1;
    logEvent("transcription.queued", `pending=${this.pendingProcessing} samples=${recording.downsampled.length}`);
    const process = async () => {
      try {
        this.lastProcessingMessage = await this.processRecording(recording, focusTarget, targetPid, engine);
      } catch (error) {
        logEvent("transcription.pipeline.failed", errorDetails(error));
        this.lastProcessingMessage = `Dictation failed: ${String(error)}`;
      } finally {
        this.pendingProcessing -= 1;
        if (this.status === "ready") {
          const message = this.pendingProcessing > 0
            ? `${this.pendingProcessing} dictation${this.pendingProcessing === 1 ? "" : "s"} processing…`
            : this.lastProcessingMessage;
          this.setStatus("ready", message);
        }
      }
    };
    this.processingQueue = this.processingQueue.then(process, process);
  }

  private async processRecording(
    recording: CompletedRecording,
    focusTarget: FocusTarget | null,
    targetPid: number,
    engine: SpeechEngine,
  ) {
    let text: string;
    try {
      logEvent("transcription.requested", `engine=${engine} samples=${recording.downsampled.length}`);
      text = await this.commands.transcribe(recording.downsampled, engine);
      logEvent("transcription.succeeded", `chars=${text.length}`);
    } catch (error) {
      logEvent("transcription.failed", errorDetails(error));
      return `Transcription failed: ${String(error)}`;
    }
    if (!text) {
      return "No speech detected";
    }
    let historySaved = true;
    try { this.onTranscript(text); }
    catch (error) {
      historySaved = false;
      logEvent("history.save.failed", errorDetails(error));
    }
    if (!focusTarget?.canPaste) {
      return historySaved ? "Test dictation saved — use Copy to copy it" : "Dictation complete, but local history could not be saved";
    }
    try {
      logEvent("paste.requested", `target=${focusTarget.appName} pid=${targetPid}`);
      const result = await this.commands.pasteText(text, focusTarget.appName, targetPid);
      logEvent("paste.succeeded", `target=${focusTarget.appName} role=${result.focusedRole} subrole=${result.focusedSubrole}`);
      return historySaved ? "Pasted into your focused text field" : "Pasted, but local history could not be saved";
    } catch (error) {
      logEvent("paste.failed", errorDetails(error));
      return `Copied, but automatic paste failed: ${String(error)} — press ⌘ V`;
    }
  }
}
