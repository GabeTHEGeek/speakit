import type { HistoryStore } from "../features/history/historyStore";

export function renderHistory(container: HTMLElement, store: HistoryStore, onError: (message: string) => void) {
  container.replaceChildren();
  const entries = store.list();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "Your last five transcriptions will appear here. Audio is not saved.";
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-entry";
    const heading = document.createElement("div");
    heading.className = "history-heading";
    const time = document.createElement("time");
    time.dateTime = entry.createdAt;
    time.textContent = new Date(entry.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    const actions = document.createElement("div");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.text);
        copy.textContent = "Copied";
        window.setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      } catch { onError("Could not copy this entry. Please try again."); }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete transcription from ${time.textContent}`);
    remove.addEventListener("click", () => {
      try {
        store.remove(entry.id);
        renderHistory(container, store, onError);
      } catch { onError("Could not delete this entry from local storage. Please try again."); }
    });
    const text = document.createElement("p");
    text.textContent = entry.text;
    actions.append(copy, remove);
    heading.append(time, actions);
    item.append(heading, text);
    container.append(item);
  }
}
