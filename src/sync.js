import { STORAGE_KEYS } from "./constants.js";

class SyncManager {
  constructor() {
    this.queue = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.SYNC_QUEUE) || "[]"
    );
    this.isSyncing = false;
  }

  schedule(id, payload) {
    this.queue.push({ id, payload });
    this._saveQueue();
    this.processQueue();
  }

  async processQueue() {
    if (!navigator.onLine || this.isSyncing || this.queue.length === 0) return;

    this.isSyncing = true;
    const queueCopy = [...this.queue];

    for (const item of queueCopy) {
      try {
        await this._send(item.payload);
        this.queue = this.queue.filter((i) => i.id !== item.id);
        this._saveQueue();
      } catch {
        break; // Stop on first failure (preserve order)
      }
    }
    this.isSyncing = false;
  }

  async _send(payload) {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(response.statusText);
  }

  _saveQueue() {
    localStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(this.queue));
  }
}

export const sync = new SyncManager();
