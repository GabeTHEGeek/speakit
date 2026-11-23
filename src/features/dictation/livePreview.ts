/**
 * Shows a rough transcript while the user is still speaking.
 *
 * The speech engines transcribe a finished clip, so the preview re-transcribes
 * the audio recorded so far on a short loop. Each pass hears more of the
 * sentence, so earlier words correct themselves as the user keeps talking.
 * Only the final pass after the shortcut is released is pasted.
 */
export type LivePreviewDeps = {
  /** 16 kHz audio recorded so far, or null when nothing is recording. */
  snapshot: (maxSamples: number) => Float32Array | null;
  /** Transcribes a partial clip. Resolves null when the engine is busy. */
  transcribe: (samples: Float32Array) => Promise<string | null>;
  show: (text: string) => void;
  log?: (event: string, details: string) => void;
  wait?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Shortest clip worth previewing (16 kHz samples). */
  minSamples?: number;
  /** Longest clip sent per pass, so long dictation stays responsive. */
  maxSamples?: number;
  /** New audio needed before another pass is worth running. */
  minNewSamples?: number;
};

const SAMPLE_RATE = 16_000;

export class LivePreview {
  private generation = 0;
  private running: Promise<void> | null = null;

  private deps: LivePreviewDeps;

  constructor(deps: LivePreviewDeps) {
    this.deps = deps;
  }

  get active() { return this.running !== null; }

  start() {
    const generation = ++this.generation;
    this.deps.show("");
    const loop = this.loop(generation).catch((error) => {
      this.deps.log?.("preview.failed", String(error));
    });
    this.running = loop;
    void loop.finally(() => {
      if (this.running === loop) this.running = null;
    });
  }

  stop() {
    if (!this.running) return;
    this.generation += 1;
    this.running = null;
    this.deps.show("");
  }

  private async loop(generation: number) {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const intervalMs = this.deps.intervalMs ?? 450;
    const minSamples = this.deps.minSamples ?? Math.round(SAMPLE_RATE * 0.6);
    const maxSamples = this.deps.maxSamples ?? SAMPLE_RATE * 20;
    const minNewSamples = this.deps.minNewSamples ?? Math.round(SAMPLE_RATE * 0.25);
    let lastLength = 0;
    let lastShown = "";
    let passes = 0;
    while (generation === this.generation) {
      await wait(intervalMs);
      if (generation !== this.generation) return;
      const samples = this.deps.snapshot(maxSamples);
      if (!samples) return;
      if (samples.length < minSamples) continue;
      if (samples.length < maxSamples && samples.length - lastLength < minNewSamples) continue;
      lastLength = samples.length;
      const started = Date.now();
      const text = await this.deps.transcribe(samples).catch((error) => {
        this.deps.log?.("preview.pass.failed", String(error));
        return null;
      });
      if (generation !== this.generation) return;
      passes += 1;
      if (passes === 1) this.deps.log?.("preview.first", `samples=${samples.length} elapsed_ms=${Date.now() - started}`);
      // An empty pass (a pause, a cut-off word, a filtered sound) would blank
      // the overlay until the next pass, so the last words stay up instead.
      const trimmed = text?.trim() ?? "";
      if (trimmed !== "" && trimmed !== lastShown) {
        lastShown = trimmed;
        this.deps.show(trimmed);
      }
    }
  }
}

/** Keeps the end of a long preview so the newest words stay visible. */
export function previewTail(text: string, maxChars = 120) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const tail = trimmed.slice(-maxChars);
  const wordBreak = tail.indexOf(" ");
  return `… ${wordBreak >= 0 && wordBreak < 20 ? tail.slice(wordBreak + 1) : tail}`;
}
