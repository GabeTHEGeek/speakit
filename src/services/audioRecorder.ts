import { emitTo } from "@tauri-apps/api/event";
import { logEvent } from "../platform/native";
import { AdaptiveAudioLevel } from "./audioLevel";
import { withTimeout } from "./promiseTimeout";

export const microphoneConstraints: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export function requestMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints });
}

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private preparedStream: MediaStream | null = null;
  private samples: Float32Array[] = [];
  private lastLevelUpdate = 0;
  private levelMeter = new AdaptiveAudioLevel();
  private startAttempt = 0;
  private recoveryTimer: number | null = null;
  private disposed = false;

  async prepare() {
    this.disposed = false;
    if (this.recoveryTimer !== null) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const preparedTracks = this.preparedStream?.getAudioTracks() ?? [];
    const hasUsableTrack = preparedTracks.some((track) => track.readyState === "live" && !track.muted);
    if (this.preparedStream && (!this.preparedStream.active || !hasUsableTrack)) {
      logEvent("microphone.warm.stale", preparedTracks
        .map((track) => `state=${track.readyState} muted=${track.muted}`)
        .join(" "));
      this.preparedStream.getTracks().forEach((track) => track.stop());
      this.preparedStream = null;
    }
    if (!this.preparedStream) {
      const started = performance.now();
      logEvent("microphone.acquire.started", "timeout_ms=3000");
      this.preparedStream = await withTimeout(
        requestMicrophoneStream(),
        3_000,
        "The microphone did not respond. Another call or app may be using it.",
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop()),
      );
      logEvent("microphone.acquire.complete", `elapsed_ms=${Math.round(performance.now() - started)}`);
      logEvent("microphone.acquired", "raw mono; voice processing disabled");
      this.watchPreparedStream(this.preparedStream);
    }
    return this.preparedStream;
  }

  setPreparedStream(stream: MediaStream) {
    this.preparedStream = stream;
    this.watchPreparedStream(stream);
  }

  async start() {
    const attempt = ++this.startAttempt;
    const stream = await this.prepare();
    if (attempt !== this.startAttempt) {
      stream.getTracks().forEach((track) => { track.enabled = false; });
      throw new Error("Recording start canceled");
    }
    stream.getTracks().forEach((track) => { track.enabled = true; });
    this.mediaStream = stream;
    this.audioContext = new AudioContext();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    if (attempt !== this.startAttempt) {
      stream.getTracks().forEach((track) => { track.enabled = false; });
      await this.audioContext.close();
      this.audioContext = null;
      this.mediaStream = null;
      throw new Error("Recording start canceled");
    }
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.samples = [];
    this.levelMeter.reset();
    void emitTo("overlay", "waveform-level", 0);
    this.processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      this.samples.push(chunk);
      const now = performance.now();
      if (now - this.lastLevelUpdate > 55) {
        let power = 0;
        for (let i = 0; i < chunk.length; i += 8) power += chunk[i] * chunk[i];
        const rms = Math.sqrt(power / Math.ceil(chunk.length / 8));
        void emitTo("overlay", "waveform-level", this.levelMeter.update(rms));
        this.lastLevelUpdate = now;
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    return this.audioContext.sampleRate;
  }

  cancelPendingStart() {
    this.startAttempt += 1;
  }

  async stop() {
    if (!this.audioContext) return null;
    const activeContext = this.audioContext;
    this.audioContext = null;
    const inputRate = activeContext.sampleRate;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => { track.enabled = false; });
    logEvent("microphone.warm", "raw stream ready; track disabled");
    await activeContext.close();
    const merged = mergeSamples(this.samples);
    const downsampled = downsample(merged, inputRate, 16000);
    this.processor = null;
    this.source = null;
    this.mediaStream = null;
    this.levelMeter.reset();
    void emitTo("overlay", "waveform-level", 0);
    return { downsampled, inputRate, inputSamples: merged.length };
  }

  async testSignal() {
    const stream = await this.prepare();
    stream.getTracks().forEach((track) => { track.enabled = true; });
    const label = stream.getAudioTracks()[0]?.label || "audio track";
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const testSource = context.createMediaStreamSource(stream);
    testSource.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let pass = 0; pass < 8; pass++) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(buffer);
      let power = 0;
      for (const sample of buffer) power += sample * sample;
      peak = Math.max(peak, Math.sqrt(power / buffer.length));
    }
    testSource.disconnect();
    await context.close();
    stream.getTracks().forEach((track) => { track.enabled = false; });
    return { label, peak };
  }

  dispose() {
    this.disposed = true;
    this.startAttempt += 1;
    if (this.recoveryTimer !== null) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.preparedStream?.getTracks().forEach((track) => track.stop());
    this.preparedStream = null;
  }

  private watchPreparedStream(stream: MediaStream) {
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("mute", () => {
        logEvent("microphone.track.muted", `label=${track.label || "audio track"} recording=${Boolean(this.audioContext)}`);
      });
      track.addEventListener("unmute", () => {
        logEvent("microphone.track.unmuted", `label=${track.label || "audio track"}`);
      });
      track.addEventListener("ended", () => {
        logEvent("microphone.track.ended", `label=${track.label || "audio track"}`);
        if (this.preparedStream === stream) {
          this.preparedStream = null;
          this.scheduleWarmRecovery();
        }
      }, { once: true });
    });
  }

  private scheduleWarmRecovery() {
    if (this.disposed || this.recoveryTimer !== null) return;
    this.recoveryTimer = window.setTimeout(async () => {
      this.recoveryTimer = null;
      if (this.disposed || this.preparedStream) return;
      try {
        const stream = await this.prepare();
        if (!this.audioContext) stream.getTracks().forEach((track) => { track.enabled = false; });
        logEvent("microphone.warm.recovered", "ended track replaced before next shortcut");
      } catch (error) {
        logEvent("microphone.warm.recovery.failed", String(error));
      }
    }, 250);
  }
}

function mergeSamples(chunks: Float32Array[]) {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
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
