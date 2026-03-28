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

const { sync } = await import("../sync.js");

describe("SyncManager", () => {
  beforeEach(() => {
    localStorage.clear();
    sync.queue = [];
    sync.isSyncing = false;
    fetchMock.mockReset();
    isOnline = true;
  });

  describe("schedule", () => {
    it("adds item to queue and saves to localStorage", () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.schedule("test-1", { name: "Yuri", action: "Clock In" });
      const saved = JSON.parse(localStorage.getItem("tt_syncQueue"));
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe("test-1");
      expect(saved[0].payload.name).toBe("Yuri");
    });
  });

  describe("processQueue", () => {
    it("does nothing when offline", async () => {
      isOnline = false;
      sync.queue = [{ id: "1", payload: {} }];
      await sync.processQueue();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing when queue is empty", async () => {
      await sync.processQueue();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends items and removes from queue on success", async () => {
      fetchMock.mockResolvedValue({ ok: true });
      sync.queue = [{ id: "1", payload: { action: "Clock In" } }];

      await sync.processQueue();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sync.queue).toHaveLength(0);
    });

    it("stops processing on failure (preserves order)", async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error("Network error"));

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

    it("sends correct payload to /api/submit", async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const payload = { name: "Yuri", action: "Clock In", id: 123 };
      sync.queue = [{ id: "1", payload }];

      await sync.processQueue();

      expect(fetchMock).toHaveBeenCalledWith("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(payload),
      });
    });
  });
});
