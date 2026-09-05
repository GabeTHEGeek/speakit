import { listen } from "@tauri-apps/api/event";
import type { Window } from "@tauri-apps/api/window";

export function renderOverlay(currentWindow: Window) {
  document.documentElement.className = "overlay-html";
  document.body.className = "overlay-body";
  document.body.dataset.visible = "false";
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div class="voice-cube">
      <div class="waveform" aria-label="Live microphone level">
        ${Array.from({ length: 33 }, (_, index) => `<i style="--i:${index}"></i>`).join("")}
      </div>
      <strong>Listening</strong>
    </div>`;

  const bars = [...document.querySelectorAll<HTMLElement>(".waveform i")];
  let level = 0;
  let overlayVisible = false;
  let animationFrame: number | null = null;

  void listen<number>("waveform-level", (event) => {
    level = Math.max(0, Math.min(1, event.payload));
  });
  void listen<boolean>("overlay-visibility", (event) => {
    overlayVisible = event.payload;
    document.body.dataset.visible = String(overlayVisible);
    if (overlayVisible && animationFrame === null) animationFrame = requestAnimationFrame(animate);
    if (!overlayVisible && animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      bars.forEach((bar) => { bar.style.transform = "scaleY(.16)"; });
    }
  });
  void currentWindow.setIgnoreCursorEvents(true).catch(() => undefined);

  function animate() {
    if (!overlayVisible) {
      animationFrame = null;
      return;
    }
    const now = performance.now() / 92;
    bars.forEach((bar, index) => {
      if (level < 0.025) {
        bar.style.transform = "scaleY(.16)";
        return;
      }
      const slow = Math.abs(Math.sin(now * 0.68 + index * 1.37));
      const quick = Math.abs(Math.sin(now * 1.43 - index * 0.83));
      const shape = 0.18 + slow * 0.5 + quick * 0.32;
      bar.style.transform = `scaleY(${Math.min(1, 0.16 + level * shape * 1.3)})`;
    });
    animationFrame = requestAnimationFrame(animate);
  }
}
