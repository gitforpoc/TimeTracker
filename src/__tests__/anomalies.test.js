import { describe, it, expect } from "vitest";
import { findOverlappingShifts, findMicroShifts } from "../admin/anomalies.js";

const shift = (user, inISO, outISO, type = "work", dur) => ({
  user_name: user,
  clock_in: inISO,
  clock_out: outISO,
  type,
  duration_minutes: dur != null ? dur : (inISO && outISO ? (new Date(outISO) - new Date(inISO)) / 60000 : 0),
});

describe("findOverlappingShifts", () => {
  it("returns nothing for non-overlapping shifts", () => {
    const r = findOverlappingShifts([
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T16:00:00Z"),
      shift("Ann", "2026-06-02T08:00:00Z", "2026-06-02T16:00:00Z"),
    ]);
    expect(r).toEqual({ count: 0, names: [] });
  });

  it("flags a duplicate pair (same employee, overlapping ranges)", () => {
    // Jairo-style: a real late-synced tap and a manual backfill covering the same hours.
    const r = findOverlappingShifts([
      shift("Jairo", "2026-05-30T08:00:00Z", "2026-05-30T18:00:00Z"),
      shift("Jairo", "2026-05-30T08:00:01Z", "2026-05-30T18:00:00Z"),
    ]);
    expect(r.count).toBe(1);
    expect(r.names).toEqual(["Jairo"]);
  });

  it("does NOT flag back-to-back shifts that only touch (half-open intervals)", () => {
    const r = findOverlappingShifts([
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T12:00:00Z"),
      shift("Ann", "2026-06-01T12:00:00Z", "2026-06-01T16:00:00Z"),
    ]);
    expect(r.count).toBe(0);
  });

  it("keeps each employee's overlaps separate (no cross-employee false positive)", () => {
    const r = findOverlappingShifts([
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T16:00:00Z"),
      shift("Bob", "2026-06-01T08:00:00Z", "2026-06-01T16:00:00Z"),
    ]);
    expect(r.count).toBe(0);
  });

  it("counts each overlapping pair and dedupes employee names", () => {
    // Three mutually overlapping shifts for one employee → 3 pairs, 1 name.
    const r = findOverlappingShifts([
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T18:00:00Z"),
      shift("Ann", "2026-06-01T09:00:00Z", "2026-06-01T17:00:00Z"),
      shift("Ann", "2026-06-01T10:00:00Z", "2026-06-01T16:00:00Z"),
    ]);
    expect(r.count).toBe(3);
    expect(r.names).toEqual(["Ann"]);
  });

  it("ignores open shifts (no clock_out) and non-work types", () => {
    const r = findOverlappingShifts([
      shift("Ann", "2026-06-01T08:00:00Z", null),
      shift("Ann", "2026-06-01T09:00:00Z", "2026-06-01T17:00:00Z"),
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T16:00:00Z", "day_off"),
    ]);
    expect(r.count).toBe(0);
  });
});

describe("findMicroShifts", () => {
  it("flags closed work shifts with 0 duration", () => {
    const r = findMicroShifts([
      shift("Ann", "2026-06-01T08:00:00Z", "2026-06-01T08:00:00Z", "work", 0),
      shift("Bob", "2026-06-01T08:00:00Z", "2026-06-01T16:00:00Z", "work", 480),
    ]);
    expect(r.count).toBe(1);
    expect(r.names).toEqual(["Ann"]);
  });

  it("does not flag open shifts (0 min but ongoing) or day_off rows", () => {
    const r = findMicroShifts([
      shift("Ann", "2026-06-01T08:00:00Z", null, "work", 0),
      shift("Bob", "2026-06-01T08:00:00Z", "2026-06-01T08:00:00Z", "day_off", 0),
    ]);
    expect(r.count).toBe(0);
  });
});
