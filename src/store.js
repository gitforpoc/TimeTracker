import { STORAGE_KEYS } from "./constants.js";
import { safeSetItem } from "./utils.js";

class Store {
  constructor() {
    this.data = [];
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.DATA);
      if (saved) this.data = JSON.parse(saved);
    } catch (e) {
      console.error("Failed to parse local data:", e);
    }

    this.status = localStorage.getItem(STORAGE_KEYS.STATUS) || "out";
    this.currentShiftId = localStorage.getItem(STORAGE_KEYS.SHIFT_ID) || null;
    this.userName = localStorage.getItem(STORAGE_KEYS.USER) || "";
    this.autoShare = localStorage.getItem(STORAGE_KEYS.AUTO_SHARE) === "true";
    this.geoEnabled = localStorage.getItem(STORAGE_KEYS.GEO_ENABLED) === "true";
    this.unreadLogs = 0;
  }

  save() {
    safeSetItem(STORAGE_KEYS.DATA, JSON.stringify(this.data));
    safeSetItem(STORAGE_KEYS.STATUS, this.status);
    if (this.currentShiftId) {
      safeSetItem(STORAGE_KEYS.SHIFT_ID, this.currentShiftId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.SHIFT_ID);
    }
  }

  saveUser(name) {
    this.userName = name;
    safeSetItem(STORAGE_KEYS.USER, name);
  }

  saveAutoShare(val) {
    this.autoShare = val;
    safeSetItem(STORAGE_KEYS.AUTO_SHARE, val);
  }

  saveGeoEnabled(val) {
    this.geoEnabled = val;
    safeSetItem(STORAGE_KEYS.GEO_ENABLED, val);
  }

  findShift(id) {
    return this.data.find((s) => s.id == id);
  }

  addEntry(entry) {
    this.data.unshift(entry);
    this.save();
  }

  deleteEntry(id) {
    const item = this.data.find((i) => i.id === id);
    this.data = this.data.filter((i) => i.id !== id);
    this.save();
    return item;
  }

  clearAll() {
    localStorage.clear();
    location.reload();
  }
}

export const store = new Store();
