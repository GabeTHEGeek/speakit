export type HistoryEntry = { id: string; text: string; createdAt: string };
const STORAGE_KEY = "dictationHistory";
const LIMIT = 5;

export function createHistoryStore(storage: Pick<Storage, "getItem" | "setItem">) {
  function read() {
    try {
      const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved.filter((entry): entry is HistoryEntry =>
        entry !== null && typeof entry === "object" &&
        typeof entry.id === "string" && typeof entry.text === "string" &&
        entry.text.trim().length > 0 && typeof entry.createdAt === "string" &&
        Number.isFinite(Date.parse(entry.createdAt)),
      ).slice(0, LIMIT);
    } catch { return null; }
  }

  let entries: HistoryEntry[] = read() || [];

  function save(next: HistoryEntry[]) {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    entries = next;
  }

  return {
    list: () => {
      // Re-read when the History page opens so a fresh dictation is never hidden
      // behind an older in-memory copy of the list.
      const persisted = read();
      if (persisted) entries = persisted;
      return entries.map((entry) => ({ ...entry }));
    },
    add(text: string) {
      if (!text.trim()) return;
      const persisted = read();
      const current = persisted || entries;
      save([{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }, ...current].slice(0, LIMIT));
    },
    remove(id: string) {
      const persisted = read();
      save((persisted || entries).filter((entry) => entry.id !== id));
    },
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
