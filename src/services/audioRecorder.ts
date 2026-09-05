import { emitTo } from "@tauri-apps/api/event";
import { logEvent } from "../platform/native";
import { AdaptiveAudioLevel } from "./audioLevel";

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

  async prepare() {
    if (!this.preparedStream || !this.preparedStream.active) {
      this.preparedStream = await requestMicrophoneStream();
      logEvent("microphone.acquired", "raw mono; voice processing disabled");
    }
    return this.preparedStream;
  }

  setPreparedStream(stream: MediaStream) {
    this.preparedStream = stream;
  }

  async start() {
    const stream = await this.prepare();
    stream.getTracks().forEach((track) => { track.enabled = true; });
    this.mediaStream = stream;
    this.audioContext = new AudioContext();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
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
    this.preparedStream?.getTracks().forEach((track) => track.stop());
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
