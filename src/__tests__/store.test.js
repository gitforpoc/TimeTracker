import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage before importing store
const storage = {};
vi.stubGlobal("localStorage", {
  getItem: (key) => storage[key] ?? null,
  setItem: (key, val) => { storage[key] = String(val); },
  removeItem: (key) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
});

// Dynamic import to pick up mocked localStorage
const { store } = await import("../store.js");

describe("Store", () => {
  beforeEach(() => {
    localStorage.clear();
    store.data = [];
    store.status = "out";
    store.currentShiftId = null;
    store.userName = "";
    store.unreadLogs = 0;
  });

  describe("save/load", () => {
    it("saves status to localStorage", () => {
      store.status = "in";
      store.save();
      expect(localStorage.getItem("tt_status")).toBe("in");
    });

    it("saves data as JSON", () => {
      store.data = [{ id: 1, type: "work" }];
      store.save();
      expect(JSON.parse(localStorage.getItem("tt_data"))).toEqual([{ id: 1, type: "work" }]);
    });

    it("removes shiftId when null", () => {
      localStorage.setItem("tt_shiftId", "123");
      store.currentShiftId = null;
      store.save();
      expect(localStorage.getItem("tt_shiftId")).toBeNull();
    });

    it("saves shiftId when set", () => {
      store.currentShiftId = 12345;
      store.save();
      expect(localStorage.getItem("tt_shiftId")).toBe("12345");
    });
  });

  describe("saveUser", () => {
    it("saves username", () => {
      store.saveUser("Yuri");
      expect(store.userName).toBe("Yuri");
      expect(localStorage.getItem("tt_user")).toBe("Yuri");
    });
  });

  describe("saveAutoShare", () => {
    it("saves autoShare preference", () => {
      store.saveAutoShare(true);
      expect(store.autoShare).toBe(true);
      expect(localStorage.getItem("tt_autoShare")).toBe("true");
    });
  });

  describe("addEntry", () => {
    it("adds entry to beginning of data", () => {
      store.addEntry({ id: 1, type: "work" });
      store.addEntry({ id: 2, type: "work" });
      expect(store.data[0].id).toBe(2);
      expect(store.data[1].id).toBe(1);
    });

    it("persists to localStorage", () => {
      store.addEntry({ id: 1, type: "work" });
      const saved = JSON.parse(localStorage.getItem("tt_data"));
      expect(saved).toHaveLength(1);
    });
  });

  describe("findShift", () => {
    it("finds by id", () => {
      store.data = [
        { id: 100, type: "work" },
        { id: 200, type: "work" },
      ];
      expect(store.findShift(200)).toEqual({ id: 200, type: "work" });
    });

    it("returns undefined for missing id", () => {
      store.data = [{ id: 100 }];
      expect(store.findShift(999)).toBeUndefined();
    });
  });

  describe("deleteEntry", () => {
    it("removes entry and returns it", () => {
      store.data = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const deleted = store.deleteEntry(2);
      expect(deleted).toEqual({ id: 2 });
      expect(store.data).toHaveLength(2);
      expect(store.data.find((i) => i.id === 2)).toBeUndefined();
    });

    it("returns undefined for missing entry", () => {
      store.data = [{ id: 1 }];
      const deleted = store.deleteEntry(999);
      expect(deleted).toBeUndefined();
    });
  });
});
