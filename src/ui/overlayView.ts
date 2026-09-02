import { listen } from "@tauri-apps/api/event";
import type { Window } from "@tauri-apps/api/window";

export function renderOverlay(currentWindow: Window) {
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

  void listen<number>("waveform-level", (event) => {
    level = Math.max(0.06, Math.min(1, event.payload));
  });
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
  void currentWindow.setIgnoreCursorEvents(true).catch(() => undefined);

  function animate() {
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
  }
}
