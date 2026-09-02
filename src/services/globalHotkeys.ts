import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { errorDetails, logEvent } from "../platform/native";

export function shortcutLabel(value: string) {
  return value.split("+").map((part) => ({
    CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Shift: "⇧", Alt: "⌥", Option: "⌥", Space: "Space",
  }[part] || part.replace(/^Key/, ""))).join(" ");
}

export function shortcutFromEvent(event: KeyboardEvent) {
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

export class GlobalHotkeys {
  private registered = false;
  private recoveryInProgress = false;
  private held = false;
  private safetyTimer: number | null = null;

  constructor(
    private shortcut: string,
    private onPressed: () => void,
    private onReleased: () => void,
  ) {}

  get isHeld() { return this.held; }
  get isRegistered() { return this.registered; }
  get value() { return this.shortcut; }

  async bind(value: string, previous?: string) {
    if (previous && await isRegistered(previous).catch(() => false)) await unregister(previous);
    try {
      await register(value, (event) => {
        if (event.state === "Pressed" && !this.held) {
          logEvent("shortcut.pressed", event.shortcut);
          this.held = true;
          if (this.safetyTimer !== null) window.clearTimeout(this.safetyTimer);
          this.safetyTimer = window.setTimeout(() => {
            if (!this.held) return;
            this.held = false;
            logEvent("shortcut.safety_reset", event.shortcut);
            this.onReleased();
          }, 60_000);
          this.onPressed();
        }
        if (event.state === "Released" && this.held) {
          logEvent("shortcut.released", event.shortcut);
          this.held = false;
          if (this.safetyTimer !== null) window.clearTimeout(this.safetyTimer);
          this.safetyTimer = null;
          this.onReleased();
        }
      });
      this.shortcut = value;
      this.registered = true;
      logEvent("shortcut.registered", value);
    } catch (error) {
      this.registered = false;
      logEvent("shortcut.registration_failed", `${value} ${errorDetails(error)}`);
      if (previous) await this.bind(previous);
      throw error;
    }
  }

  async ensure(reason: string, enabled: boolean) {
    if (!enabled || this.recoveryInProgress) return;
    this.recoveryInProgress = true;
    try {
      this.registered = await isRegistered(this.shortcut);
      if (this.registered) return;
      this.held = false;
      await this.bind(this.shortcut);
      logEvent("shortcut.recovered", reason);
    } catch (error) {
      this.registered = false;
      logEvent("shortcut.recovery_failed", `${reason} ${errorDetails(error)}`);
      throw error;
    } finally {
      this.recoveryInProgress = false;
    }
  }
}
