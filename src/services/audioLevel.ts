export class AdaptiveAudioLevel {
  private noiseFloor = 0.006;
  private smoothed = 0;

  reset() {
    this.noiseFloor = 0.006;
    this.smoothed = 0;
  }

  update(rms: number) {
    if (rms < this.noiseFloor * 1.8) this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
    const gated = Math.max(0, rms - Math.max(0.004, this.noiseFloor * 1.7));
    const target = Math.min(1, gated * 24);
    const response = target > this.smoothed ? 0.72 : 0.2;
    this.smoothed += (target - this.smoothed) * response;
    if (this.smoothed < 0.018) this.smoothed = 0;
    return this.smoothed;
  }
}
