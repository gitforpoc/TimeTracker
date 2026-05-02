import { STORAGE_KEYS } from "./constants.js";

class SyncManager {
  constructor() {
    this.queue = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.SYNC_QUEUE) || "[]"
    );
    this.isSyncing = false;
    this._getToken = null;
    // Per-item resolvers for awaitItem(). Keyed by item id, value is the resolve fn.
    this._waiters = new Map();
  }

  setTokenGetter(fn) {
    this._getToken = fn;
  }

  schedule(id, payload) {
    this.queue.push({ id, payload });
    // Cap queue size to prevent unbounded growth (e.g. guest mode)
    if (this.queue.length > 200) this.queue.shift();
    this._saveQueue();
    if (this._getToken) {
      this.processQueue();
    }
    // No tokenGetter yet = queue persisted, will process after auth completes
  }

  async processQueue() {
    if (!this._getToken || !navigator.onLine || this.isSyncing || this.queue.length === 0) return;

    this.isSyncing = true;
    const queueCopy = [...this.queue];

    for (const item of queueCopy) {
      try {
        // Fresh token for each item — prevents expiry mid-queue
        const token = await this._getToken();
        if (!token) break;
        await this._send(item.payload, token);
        this.queue = this.queue.filter((i) => i.id !== item.id);
        this._saveQueue();
        // Notify any awaitItem() callers that this item has shipped
        const waiter = this._waiters.get(item.id);
        if (waiter) {
          waiter(true); // true = success
          this._waiters.delete(item.id);
        }
      } catch {
        break; // Stop on first failure (preserve order)
      }
    }
    this.isSyncing = false;
  }

  /**
   * Wait for a specific queued item to be successfully sent. Resolves true on send,
   * false on timeout. Use to delay UI confirmation (e.g. share dialog) until the
   * server actually has the data — gives the user visible certainty.
   *
   * @param {*} id - the item id passed to schedule()
   * @param {number} timeoutMs - max wait before resolving false (default 3000)
   * @returns {Promise<boolean>}
   */
  awaitItem(id, timeoutMs = 3000) {
    // If already shipped (not in queue), resolve immediately
    if (!this.queue.some((i) => i.id === id)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        resolve(false);
      }, timeoutMs);

      this._waiters.set(id, (success) => {
        clearTimeout(timer);
        resolve(success);
      });
    });
  }

  async _send(payload, token) {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      keepalive: true,
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(response.statusText);
  }

  get pendingCount() {
    return this.queue.length;
  }

  /** Returns Set of client IDs that haven't synced yet */
  get pendingIds() {
    return new Set(this.queue.map((item) => item.id));
  }

  _saveQueue() {
    localStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(this.queue));
    this._notifyUI();
  }

  // Notify UI about queue changes (pending indicator)
  _notifyUI() {
    if (typeof document === "undefined") return;
    const el = document.getElementById("sync-pending");
    if (!el) return;
    if (this.queue.length > 0) {
      el.textContent = `${this.queue.length} pending`;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
}

export const sync = new SyncManager();

// Retry sync when app returns to foreground
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync.processQueue();
  });
}
