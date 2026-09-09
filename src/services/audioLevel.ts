export class AdaptiveAudioLevel {
  private noiseFloor = 0.003;
  private smoothed = 0;

  reset() {
    this.noiseFloor = 0.003;
    this.smoothed = 0;
  }

  update(rms: number) {
    if (rms < this.noiseFloor * 1.35) this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
    const gated = Math.max(0, rms - Math.max(0.003, this.noiseFloor * 1.3));
    const target = Math.min(1, gated * 100);
    const response = target > this.smoothed ? 0.78 : 0.2;
    this.smoothed += (target - this.smoothed) * response;
    if (this.smoothed < 0.018) this.smoothed = 0;
    return this.smoothed;
  }
}
