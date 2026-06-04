import { describe, it, expect } from "vitest";
import {
  validateAddShiftBody,
  findOverlap,
  ADD_SHIFT_ALLOWED_TYPES,
  ADD_SHIFT_FUTURE_SKEW_MS,
} from "../../api/addShiftGuard.js";

// Reference "now" for deterministic time-based assertions
const NOW = new Date("2026-06-04T18:00:00.000Z").getTime();

function baseBody(overrides = {}) {
  return {
    user_name: "Sasha",
    clock_in: "2026-06-03T13:00:00.000Z",
    clock_out: "2026-06-03T22:00:00.000Z",
    type: "work",
    comment: "Late evening run",
    reason: "Employee forgot to clock in/out",
    ...overrides,
  };
}

describe("validateAddShiftBody", () => {
  it("accepts a well-formed past shift", () => {
    const r = validateAddShiftBody(baseBody(), NOW);
    expect(r.ok).toBe(true);
    expect(r.durationMin).toBe(540); // 9h
  });

  it("rejects when body is missing", () => {
    const r = validateAddShiftBody(null, NOW);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("rejects when user_name is missing", () => {
    const r = validateAddShiftBody(baseBody({ user_name: "" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/user_name/);
  });

  it("rejects when user_name is whitespace only", () => {
    const r = validateAddShiftBody(baseBody({ user_name: "   " }), NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects type=day_off (only work/paid_off allowed)", () => {
    const r = validateAddShiftBody(baseBody({ type: "day_off" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/type must be one of/);
  });

  it("accepts type=paid_off", () => {
    const r = validateAddShiftBody(baseBody({ type: "paid_off" }), NOW);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown type", () => {
    const r = validateAddShiftBody(baseBody({ type: "vacation" }), NOW);
    expect(r.ok).toBe(false);
  });

  it("ADD_SHIFT_ALLOWED_TYPES is the locked list", () => {
    expect(ADD_SHIFT_ALLOWED_TYPES).toEqual(["work", "paid_off"]);
  });

  it("rejects when reason is missing", () => {
    const r = validateAddShiftBody(baseBody({ reason: "" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason/);
  });

  it("rejects when reason is whitespace only", () => {
    const r = validateAddShiftBody(baseBody({ reason: "   " }), NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects missing clock_in", () => {
    const r = validateAddShiftBody(baseBody({ clock_in: null }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/clock_in/);
  });

  it("rejects missing clock_out (no open shifts via this endpoint)", () => {
    const r = validateAddShiftBody(baseBody({ clock_out: null }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/clock_out/);
  });

  it("rejects invalid clock_in string", () => {
    const r = validateAddShiftBody(baseBody({ clock_in: "not-a-date" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid clock_in/);
  });

  it("rejects invalid clock_out string", () => {
    const r = validateAddShiftBody(baseBody({ clock_out: "not-a-date" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid clock_out/);
  });

  it("rejects clock_out before clock_in", () => {
    const r = validateAddShiftBody(
      baseBody({
        clock_in: "2026-06-03T22:00:00.000Z",
        clock_out: "2026-06-03T13:00:00.000Z",
      }),
      NOW
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/clock_out must be after clock_in/);
  });

  it("rejects equal clock_in and clock_out (zero-duration)", () => {
    const r = validateAddShiftBody(
      baseBody({
        clock_in: "2026-06-03T13:00:00.000Z",
        clock_out: "2026-06-03T13:00:00.000Z",
      }),
      NOW
    );
    expect(r.ok).toBe(false);
  });

  it("rejects clock_in in the future (beyond skew tolerance)", () => {
    const futureIso = new Date(NOW + 30 * 60 * 1000).toISOString(); // 30 min ahead
    const r = validateAddShiftBody(baseBody({
      clock_in: futureIso,
      clock_out: new Date(NOW + 60 * 60 * 1000).toISOString(),
    }), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/future/);
  });

  it("accepts clock_in within the 5-min future-skew tolerance", () => {
    const slightlyFuture = new Date(NOW + ADD_SHIFT_FUTURE_SKEW_MS - 1000).toISOString();
    const laterFuture = new Date(NOW + ADD_SHIFT_FUTURE_SKEW_MS + 60 * 60 * 1000).toISOString();
    const r = validateAddShiftBody(baseBody({
      clock_in: slightlyFuture,
      clock_out: laterFuture,
    }), NOW);
    expect(r.ok).toBe(true);
  });

  it("computes durationMin correctly", () => {
    const r = validateAddShiftBody(
      baseBody({
        clock_in: "2026-06-03T08:00:00.000Z",
        clock_out: "2026-06-03T16:30:00.000Z",
      }),
      NOW
    );
    expect(r.ok).toBe(true);
    expect(r.durationMin).toBe(510); // 8h30m
  });
});

describe("findOverlap", () => {
  const NEW_IN = new Date("2026-06-03T13:00:00.000Z").getTime();
  const NEW_OUT = new Date("2026-06-03T22:00:00.000Z").getTime();

  it("returns no overlap for empty list", () => {
    expect(findOverlap([], NEW_IN, NEW_OUT).overlaps).toBe(false);
  });

  it("returns no overlap for non-overlapping prior shift", () => {
    const prior = [{ clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z" }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(false);
  });

  it("detects exact-overlap conflict", () => {
    const prior = [{ clock_in: "2026-06-03T13:00:00Z", clock_out: "2026-06-03T22:00:00Z" }];
    const r = findOverlap(prior, NEW_IN, NEW_OUT);
    expect(r.overlaps).toBe(true);
    expect(r.conflict).toBeDefined();
  });

  it("detects partial-overlap on left edge", () => {
    const prior = [{ clock_in: "2026-06-03T10:00:00Z", clock_out: "2026-06-03T14:00:00Z" }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(true);
  });

  it("detects partial-overlap on right edge", () => {
    const prior = [{ clock_in: "2026-06-03T20:00:00Z", clock_out: "2026-06-04T02:00:00Z" }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(true);
  });

  it("detects containment (new shift fully inside existing)", () => {
    const prior = [{ clock_in: "2026-06-03T10:00:00Z", clock_out: "2026-06-04T00:00:00Z" }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(true);
  });

  it("does NOT flag back-to-back shifts that touch at the boundary", () => {
    // prior ends exactly when new begins
    const prior = [{ clock_in: "2026-06-03T08:00:00Z", clock_out: "2026-06-03T13:00:00Z" }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(false);
  });

  it("flags an open shift that started before new shift ends", () => {
    const prior = [{ clock_in: "2026-06-03T12:00:00Z", clock_out: null }];
    const r = findOverlap(prior, NEW_IN, NEW_OUT);
    expect(r.overlaps).toBe(true);
    expect(r.conflict.clock_out).toBeNull();
  });

  it("does NOT flag an open shift that started after new shift ended", () => {
    const prior = [{ clock_in: "2026-06-04T08:00:00Z", clock_out: null }];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(false);
  });

  it("skips malformed rows", () => {
    const prior = [
      { clock_in: null, clock_out: null },
      { clock_in: "bogus", clock_out: "also-bogus" },
    ];
    expect(findOverlap(prior, NEW_IN, NEW_OUT).overlaps).toBe(false);
  });

  it("handles non-array input gracefully", () => {
    expect(findOverlap(null, NEW_IN, NEW_OUT).overlaps).toBe(false);
    expect(findOverlap(undefined, NEW_IN, NEW_OUT).overlaps).toBe(false);
  });
});
