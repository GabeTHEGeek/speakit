export type HistoryEntry = { id: string; text: string; createdAt: string };
const STORAGE_KEY = "dictationHistory";
const LIMIT = 5;

export function createHistoryStore(storage: Pick<Storage, "getItem" | "setItem">) {
  let entries: HistoryEntry[] = [];
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) {
      entries = saved.filter((entry): entry is HistoryEntry =>
        entry !== null && typeof entry === "object" &&
        typeof entry.id === "string" && typeof entry.text === "string" &&
        entry.text.trim().length > 0 && typeof entry.createdAt === "string" &&
        Number.isFinite(Date.parse(entry.createdAt)),
      ).slice(0, LIMIT);
    }
  } catch { /* Invalid saved data should not prevent dictation. */ }

  function save(next: HistoryEntry[]) {
    // Only update the visible list after persistence succeeds.
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    entries = next;
  }

  return {
    list: () => entries.map((entry) => ({ ...entry })),
    add(text: string) {
      if (!text.trim()) return;
      save([{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }, ...entries].slice(0, LIMIT));
    },
    remove(id: string) { save(entries.filter((entry) => entry.id !== id)); },
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
