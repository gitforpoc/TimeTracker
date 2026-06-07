import { STORAGE_KEYS } from "./constants.js";

// Items older than this in the queue indicate something is broken (auth expired,
// permanent server error, etc). Banner UI surfaces this since the small "N pending"
// chip is too easy to miss.
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

class SyncManager {
  constructor() {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.SYNC_QUEUE) || "[]"
    );
    // Backward-compat: legacy items predate `enqueued_at`. Treat as freshly enqueued
    // so they don't immediately trip the stale-queue alarm on first upgrade.
    const now = Date.now();
    this.queue = raw.map((item) =>
      item && item.enqueued_at == null ? { ...item, enqueued_at: now } : item
    );
    this.isSyncing = false;
    this._getToken = null;
    // Provided by main.js after auth completes. Used to recover from 401.
    this._refreshSession = null;
    // Sticky flag: refresh failed (no session). Cleared by next setTokenGetter call.
    this._authBroken = false;
    // Per-item resolvers for awaitItem(). Keyed by item id, value is the resolve fn.
    this._waiters = new Map();
  }

  setTokenGetter(fn) {
    this._getToken = fn;
    // New token getter wired up → previous auth-broken state is stale.
    this._authBroken = false;
  }

  /**
   * Provide a way to refresh the supabase session when the queue hits a 401.
   * Should return a Promise resolving to `{ session, error }`-shaped object, same
   * as `supabase.auth.refreshSession()`. Optional — if not set, a 401 simply halts
   * the queue without attempting recovery.
   */
  setSessionRefresher(fn) {
    this._refreshSession = fn;
  }

  isAuthBroken() {
    return this._authBroken;
  }

  schedule(id, payload) {
    this.queue.push({ id, payload, enqueued_at: Date.now() });
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
    if (this._authBroken) return; // halted until next setTokenGetter / explicit reset

    this.isSyncing = true;
    // Per-invocation guard: never call refreshSession more than once per processQueue run.
    let refreshAttempted = false;
    const queueCopy = [...this.queue];

    for (const item of queueCopy) {
      try {
        // Fresh token for each item — prevents expiry mid-queue
        const token = await this._getToken();
        if (!token) break;
        let response = await this._send(item.payload, token);

        if (response.status === 401) {
          // Session likely expired mid-queue. Try ONE refresh per invocation; if
          // it succeeds, retry this item with the new token. If refresh fails
          // or the retry still gets 401, halt the queue cleanly so we don't
          // burn through every item with a dead token.
          if (refreshAttempted) {
            // Already tried refresh this invocation → second 401 means the
            // refreshed session is also dead (or refresh succeeded but server
            // still rejects). Halt and mark auth-broken.
            this._handleAuthBroken("401 after refresh");
            break;
          }
          refreshAttempted = true;
          const refreshed = await this._tryRefreshSession();
          if (!refreshed) {
            // Refresh failed or no refresher wired up. Mark auth-broken,
            // optionally redirect on production.
            this._handleAuthBroken("refresh failed");
            break;
          }
          // Refresh succeeded — fetch new token and retry this item ONCE.
          const newToken = await this._getToken();
          if (!newToken) {
            this._handleAuthBroken("no token after refresh");
            break;
          }
          response = await this._send(item.payload, newToken);
          if (response.status === 401) {
            // Refresh produced a session but server still rejects → halt.
            this._handleAuthBroken("401 after refresh retry");
            break;
          }
          if (!response.ok) {
            // Some other error after refresh — bail to preserve order, will
            // retry on next visibility/online event.
            break;
          }
        } else if (!response.ok) {
          // Non-401 failure (5xx, network blip rendered as fetch reject, etc).
          // Bail to preserve order — next visibility/online tick will retry.
          break;
        }

        this.queue = this.queue.filter((i) => i.id !== item.id);
        this._saveQueue();
        // Notify any awaitItem() callers that this item has shipped
        const waiter = this._waiters.get(item.id);
        if (waiter) {
          waiter(true); // true = success
          this._waiters.delete(item.id);
        }
      } catch (e) {
        // Network error (fetch rejects). Stop on first failure (preserve order).
        console.warn("[sync] item failed, will retry:", e?.message || e);
        break;
      }
    }
    this.isSyncing = false;
  }

  async _tryRefreshSession() {
    if (typeof this._refreshSession !== "function") return false;
    try {
      const result = await this._refreshSession();
      // supabase returns { data: { session }, error }
      const session = result?.data?.session;
      if (result?.error || !session) return false;
      return true;
    } catch (e) {
      console.error("[sync] refreshSession threw:", e?.message || e);
      return false;
    }
  }

  _handleAuthBroken(reason) {
    this._authBroken = true;
    console.error(`[sync] auth broken: ${reason} — halting queue`);
    // On production, redirect to centralized Hub login (same pattern as initAuth).
    // On localhost/preview, leave the flag set so the banner can surface it without
    // kicking devs out of their session mid-test.
    if (
      typeof window !== "undefined" &&
      window.location &&
      typeof window.location.hostname === "string" &&
      window.location.hostname.endsWith(".mpoctools.com")
    ) {
      try {
        const returnTo = encodeURIComponent(window.location.href);
        window.location.replace(`https://mpoctools.com/login?return_to=${returnTo}`);
      } catch (e) {
        console.error("[sync] redirect to login failed:", e?.message || e);
      }
    }
    this._notifyUI();
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
    return fetch("/api/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      keepalive: true,
      body: JSON.stringify(payload),
    });
  }

  get pendingCount() {
    return this.queue.length;
  }

  /** Returns Set of client IDs that haven't synced yet */
  get pendingIds() {
    return new Set(this.queue.map((item) => item.id));
  }

  /**
   * Summary for the stale-queue banner UI. Returns { stale, oldestMs, count }
   * where `stale` is true iff at least one queued item is older than 1 hour,
   * `oldestMs` is the age of the oldest item (0 for empty queue), and `count`
   * is total queue length.
   */
  getStaleQueueSummary() {
    const count = this.queue.length;
    if (count === 0) return { stale: false, oldestMs: 0, count: 0 };
    const now = Date.now();
    let oldestMs = 0;
    for (const item of this.queue) {
      // Defensive: items without enqueued_at (legacy or corrupted) are treated as fresh.
      if (typeof item.enqueued_at !== "number") continue;
      const age = now - item.enqueued_at;
      if (age > oldestMs) oldestMs = age;
    }
    return { stale: oldestMs > STALE_THRESHOLD_MS, oldestMs, count };
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

/**
 * Pure helper for banner copy. Pulled out for unit testability — DOM wiring is
 * too brittle to test reliably in this setup.
 */
export function formatStaleBannerText(summary, authBroken) {
  if (authBroken) {
    return {
      title: "Sign-in expired",
      detail: "Tap to refresh.",
    };
  }
  if (!summary || !summary.stale) {
    return null;
  }
  const hours = Math.max(1, Math.floor(summary.oldestMs / (60 * 60 * 1000)));
  const noun = summary.count === 1 ? "item" : "items";
  const ageStr = hours === 1 ? "1h ago" : `${hours}h ago`;
  return {
    title: `Some events haven't synced (${summary.count} ${noun}, oldest ${ageStr})`,
    detail: 'Tap to retry • or History → Update for full refresh',
  };
}

export const sync = new SyncManager();

// Retry sync when app returns to foreground
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync.processQueue();
  });
}
