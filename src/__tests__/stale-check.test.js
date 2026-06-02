import { describe, it, expect, vi } from "vitest";

// Mock browser globals before importing history.js (same pattern as
// history-quota.test.js — history.js touches localStorage / window /
// location at module top).
const storage = {};
vi.stubGlobal("localStorage", {
  getItem: (key) => storage[key] ?? null,
  setItem: (key, val) => { storage[key] = String(val); },
  removeItem: (key) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
});
vi.stubGlobal("location", { hostname: "localhost", href: "http://localhost/" });
vi.stubGlobal("document", { cookie: "", addEventListener: () => {} });
vi.stubGlobal("window", { addEventListener: () => {} });

const { isShiftStale } = await import("../history.js");

describe("isShiftStale (defense-in-depth stale-data check)", () => {
  it("returns false when server has no edits at all (current=null)", () => {
    expect(isShiftStale(null, null)).toBe(false);
    expect(isShiftStale("2026-06-02T13:19:00Z", null)).toBe(false);
  });

  it("returns true when snapshot is empty but current is non-empty", () => {
    // Form opened before any edits existed; an edit landed before save.
    expect(isShiftStale(null, "2026-06-02T13:19:00Z")).toBe(true);
    expect(isShiftStale(undefined, "2026-06-02T13:19:00Z")).toBe(true);
    expect(isShiftStale("", "2026-06-02T13:19:00Z")).toBe(true);
  });

  it("returns false when snapshot and current are identical", () => {
    const t = "2026-06-02T13:19:00Z";
    expect(isShiftStale(t, t)).toBe(false);
  });

  it("returns true when current is newer than snapshot", () => {
    expect(
      isShiftStale("2026-06-02T13:19:00Z", "2026-06-02T13:20:00Z")
    ).toBe(true);
  });

  it("returns false when snapshot is newer than current (defensive)", () => {
    // Should never happen in practice (clock skew or test data), but the
    // helper must not block the save in that case.
    expect(
      isShiftStale("2026-06-02T13:20:00Z", "2026-06-02T13:19:00Z")
    ).toBe(false);
  });

  it("returns false when timestamps are unparseable (defensive)", () => {
    expect(isShiftStale("not-a-date", "also-not-a-date")).toBe(false);
  });
});
