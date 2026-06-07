import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const storage = {};
vi.stubGlobal("localStorage", {
  getItem: (key) => storage[key] ?? null,
  setItem: (key, val) => { storage[key] = String(val); },
  removeItem: (key) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
});

// Mock navigator.onLine
let isOnline = true;
vi.stubGlobal("navigator", { onLine: true });
Object.defineProperty(navigator, "onLine", { get: () => isOnline });

// Mock fetch
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { sync, formatStaleBannerText } = await import("../sync.js");

const TEST_TOKEN = "test-token-123";
const tokenGetter = async () => TEST_TOKEN;

describe("SyncManager", () => {
  beforeEach(() => {
    localStorage.clear();
    sync.queue = [];
    sync.isSyncing = false;
    sync._getToken = null;
    sync._refreshSession = null;
    sync._authBroken = false;
    fetchMock.mockReset();
    isOnline = true;
  });

  describe("schedule", () => {
    it("adds item to queue and saves to localStorage when authenticated", () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.setTokenGetter(tokenGetter);
      sync.schedule("test-1", { name: "Yuri", action: "Clock In" });
      const saved = JSON.parse(localStorage.getItem("tt_syncQueue"));
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe("test-1");
      expect(saved[0].payload.name).toBe("Yuri");
    });

    it("queues item even without tokenGetter (pre-auth or guest)", () => {
      sync.schedule("test-1", { name: "Guest", action: "Clock In" });
      const saved = JSON.parse(localStorage.getItem("tt_syncQueue"));
      expect(saved).toHaveLength(1);
      expect(sync.queue).toHaveLength(1);
      // But does NOT attempt to send
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("processQueue", () => {
    it("does nothing when offline", async () => {
      isOnline = false;
      sync.setTokenGetter(tokenGetter);
      sync.queue = [{ id: "1", payload: {} }];
      await sync.processQueue();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing when queue is empty", async () => {
      sync.setTokenGetter(tokenGetter);
      await sync.processQueue();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing without tokenGetter (guest mode)", async () => {
      sync.queue = [{ id: "1", payload: {} }];
      await sync.processQueue();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends items and removes from queue on success", async () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.setTokenGetter(tokenGetter);
      sync.queue = [{ id: "1", payload: { action: "Clock In" } }];

      await sync.processQueue();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sync.queue).toHaveLength(0);
    });

    it("stops processing on failure (preserves order)", async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error("Network error"));

      sync.setTokenGetter(tokenGetter);
      sync.queue = [
        { id: "1", payload: { action: "Clock In" } },
        { id: "2", payload: { action: "Clock Out" } },
        { id: "3", payload: { action: "Clock In" } },
      ];

      await sync.processQueue();

      // First succeeded, second failed, third not attempted
      expect(sync.queue).toHaveLength(2);
      expect(sync.queue[0].id).toBe("2");
      expect(sync.queue[1].id).toBe("3");
    });

    it("sends correct payload with auth header", async () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.setTokenGetter(tokenGetter);
      const payload = { name: "Yuri", action: "Clock In", id: 123 };
      sync.queue = [{ id: "1", payload }];

      await sync.processQueue();

      expect(fetchMock).toHaveBeenCalledWith("/api/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${TEST_TOKEN}`,
        },
        keepalive: true,
        body: JSON.stringify(payload),
      });
    });
  });

  describe("401 re-auth", () => {
    it("calls refreshSession exactly once when first POST returns 401", async () => {
      // 1st item: 401, refresh succeeds, retry succeeds
      // 2nd item: succeeds normally
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401 })   // item 1 first try
        .mockResolvedValueOnce({ ok: true, status: 200 })    // item 1 retry
        .mockResolvedValueOnce({ ok: true, status: 200 });   // item 2

      const refreshMock = vi.fn().mockResolvedValue({
        data: { session: { access_token: "new" } },
        error: null,
      });
      sync.setTokenGetter(tokenGetter);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [
        { id: "1", payload: { a: 1 } },
        { id: "2", payload: { a: 2 } },
      ];

      await sync.processQueue();

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sync.queue).toHaveLength(0);
      expect(sync.isAuthBroken()).toBe(false);
    });

    it("retries failed item with fresh token after successful refresh", async () => {
      // Switch token after refresh — verify the second send uses it.
      let currentToken = "old-token";
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const refreshMock = vi.fn().mockImplementation(async () => {
        currentToken = "new-token";
        return { data: { session: { access_token: "new-token" } }, error: null };
      });
      sync.setTokenGetter(async () => currentToken);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [{ id: "1", payload: { x: 1 } }];

      await sync.processQueue();

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer old-token");
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new-token");
      expect(sync.queue).toHaveLength(0);
    });

    it("halts queue and sets isAuthBroken when refresh fails (returns error)", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      const refreshMock = vi.fn().mockResolvedValue({
        data: { session: null },
        error: { message: "refresh_token_expired" },
      });
      sync.setTokenGetter(tokenGetter);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [
        { id: "1", payload: { a: 1 } },
        { id: "2", payload: { a: 2 } },
      ];

      await sync.processQueue();

      expect(refreshMock).toHaveBeenCalledTimes(1);
      // Only the first item triggered fetch — second never attempted
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sync.queue).toHaveLength(2);
      expect(sync.isAuthBroken()).toBe(true);
    });

    it("halts queue when refresh returns no session", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      const refreshMock = vi.fn().mockResolvedValue({
        data: { session: null },
        error: null,
      });
      sync.setTokenGetter(tokenGetter);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [{ id: "1", payload: {} }];

      await sync.processQueue();

      expect(sync.isAuthBroken()).toBe(true);
      expect(sync.queue).toHaveLength(1);
    });

    it("halts when 401 persists even after successful refresh", async () => {
      // refresh succeeds, but the server still 401s the retry → permanent rejection
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401 })  // first try
        .mockResolvedValueOnce({ ok: false, status: 401 }); // retry after refresh

      const refreshMock = vi.fn().mockResolvedValue({
        data: { session: { access_token: "new" } },
        error: null,
      });
      sync.setTokenGetter(tokenGetter);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [
        { id: "1", payload: {} },
        { id: "2", payload: {} },
      ];

      await sync.processQueue();

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sync.isAuthBroken()).toBe(true);
      expect(sync.queue).toHaveLength(2);
    });

    it("does not call refreshSession more than once per processQueue invocation", async () => {
      // Three items, all 401 in turn; refresh succeeds; retry of item 1 also 401.
      // This must trip the "refreshAttempted" guard and halt — NOT call refresh again.
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401 })  // item 1
        .mockResolvedValueOnce({ ok: false, status: 401 }); // item 1 retry

      const refreshMock = vi.fn().mockResolvedValue({
        data: { session: { access_token: "new" } },
        error: null,
      });
      sync.setTokenGetter(tokenGetter);
      sync.setSessionRefresher(refreshMock);
      sync.queue = [
        { id: "1", payload: {} },
        { id: "2", payload: {} },
        { id: "3", payload: {} },
      ];

      await sync.processQueue();

      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing when isAuthBroken flag is set", async () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.setTokenGetter(tokenGetter);
      sync._authBroken = true;
      sync.queue = [{ id: "1", payload: {} }];

      await sync.processQueue();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("setTokenGetter clears the isAuthBroken flag", () => {
      sync._authBroken = true;
      sync.setTokenGetter(tokenGetter);
      expect(sync.isAuthBroken()).toBe(false);
    });

    it("halts (no infinite retry) when refresher is not wired up", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      sync.setTokenGetter(tokenGetter);
      // intentionally no setSessionRefresher
      sync.queue = [
        { id: "1", payload: {} },
        { id: "2", payload: {} },
      ];

      await sync.processQueue();

      // Should only attempt once (first item), then halt
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sync.isAuthBroken()).toBe(true);
    });
  });

  describe("enqueued_at + getStaleQueueSummary", () => {
    it("schedule sets enqueued_at on new items", () => {
      const before = Date.now();
      sync.schedule("test-1", { foo: 1 });
      const after = Date.now();
      expect(sync.queue[0].enqueued_at).toBeGreaterThanOrEqual(before);
      expect(sync.queue[0].enqueued_at).toBeLessThanOrEqual(after);
    });

    it("returns empty/zero shape for empty queue", () => {
      const s = sync.getStaleQueueSummary();
      expect(s).toEqual({ stale: false, oldestMs: 0, count: 0 });
    });

    it("returns stale=false for one fresh item", () => {
      sync.queue = [{ id: "1", payload: {}, enqueued_at: Date.now() - 1000 }];
      const s = sync.getStaleQueueSummary();
      expect(s.stale).toBe(false);
      expect(s.count).toBe(1);
      expect(s.oldestMs).toBeGreaterThanOrEqual(1000);
    });

    it("returns stale=true for an item older than 1h", () => {
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      sync.queue = [{ id: "1", payload: {}, enqueued_at: Date.now() - TWO_HOURS }];
      const s = sync.getStaleQueueSummary();
      expect(s.stale).toBe(true);
      expect(s.count).toBe(1);
      expect(s.oldestMs).toBeGreaterThanOrEqual(TWO_HOURS);
    });

    it("uses oldest item for oldestMs when mixed ages", () => {
      const OLD = 3 * 60 * 60 * 1000;
      sync.queue = [
        { id: "1", payload: {}, enqueued_at: Date.now() - 1000 },     // fresh
        { id: "2", payload: {}, enqueued_at: Date.now() - OLD },      // 3h
        { id: "3", payload: {}, enqueued_at: Date.now() - 500 },      // fresh
      ];
      const s = sync.getStaleQueueSummary();
      expect(s.stale).toBe(true);
      expect(s.count).toBe(3);
      expect(s.oldestMs).toBeGreaterThanOrEqual(OLD);
    });

    it("treats legacy items without enqueued_at as fresh (no false alarm)", () => {
      // Simulate items loaded from localStorage before the migration field existed
      sync.queue = [
        { id: "1", payload: {} },
        { id: "2", payload: {} },
      ];
      const s = sync.getStaleQueueSummary();
      expect(s.stale).toBe(false);
      expect(s.count).toBe(2);
    });
  });

  describe("formatStaleBannerText", () => {
    it("returns null when nothing is wrong", () => {
      expect(formatStaleBannerText({ stale: false, oldestMs: 0, count: 0 }, false)).toBeNull();
    });

    it("returns auth-broken text when authBroken=true regardless of summary", () => {
      const text = formatStaleBannerText({ stale: false, count: 0, oldestMs: 0 }, true);
      expect(text.title.toLowerCase()).toContain("sign-in expired");
      expect(text.detail.toLowerCase()).toContain("tap");
    });

    it("returns stale-queue text when summary is stale", () => {
      const text = formatStaleBannerText(
        { stale: true, oldestMs: 2 * 60 * 60 * 1000, count: 3 },
        false
      );
      expect(text.title).toContain("3");
      expect(text.title).toContain("2h");
      expect(text.title.toLowerCase()).toContain("haven't synced");
    });

    it("singular vs plural copy", () => {
      const one = formatStaleBannerText({ stale: true, oldestMs: 90 * 60 * 1000, count: 1 }, false);
      const many = formatStaleBannerText({ stale: true, oldestMs: 90 * 60 * 1000, count: 5 }, false);
      expect(one.title).toContain("1 item");
      expect(one.title).not.toContain("items");
      expect(many.title).toContain("5 items");
    });
  });
});
