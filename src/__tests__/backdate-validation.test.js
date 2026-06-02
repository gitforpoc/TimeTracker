import { describe, it, expect } from "vitest";
import {
  validateBackdate,
  findLastClosedShiftOutToday,
  toDatetimeLocalValue,
  parseDatetimeLocalValue,
  MAX_BACKDATE_HOURS,
} from "../backdateValidation.js";

const HOUR = 3600000;

describe("validateBackdate", () => {
  const now = new Date("2026-06-02T15:00:00.000").getTime();

  it("accepts current time exactly", () => {
    const res = validateBackdate(now, now, "in");
    expect(res.ok).toBe(true);
  });

  it("accepts a small backdate (1 minute ago)", () => {
    const res = validateBackdate(now - 60000, now, "in");
    expect(res.ok).toBe(true);
  });

  it("rejects a future time", () => {
    const res = validateBackdate(now + 10 * 60000, now, "in");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/future/i);
  });

  it("rejects more than 12h ago", () => {
    const res = validateBackdate(now - (MAX_BACKDATE_HOURS + 1) * HOUR, now, "in");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/12h/);
  });

  it("accepts exactly at the 12h boundary", () => {
    const res = validateBackdate(now - MAX_BACKDATE_HOURS * HOUR, now, "in");
    expect(res.ok).toBe(true);
  });

  it("rejects Clock In before previous shift's clock_out today", () => {
    const lastOut = now - 2 * HOUR; // closed shift ended 2h ago
    const chosen = now - 3 * HOUR; // user picks before that
    const res = validateBackdate(chosen, now, "in", null, lastOut);
    expect(res.ok).toBe(false);
    // Embedded HH:MM of lastOut should be in the message
    expect(res.message).toMatch(/Cannot be before your previous shift ended at \d{2}:\d{2}/);
  });

  it("accepts Clock In after previous shift's clock_out today", () => {
    const lastOut = now - 3 * HOUR;
    const chosen = now - 1 * HOUR;
    const res = validateBackdate(chosen, now, "in", null, lastOut);
    expect(res.ok).toBe(true);
  });

  it("rejects Clock Out before its own clock_in (negative duration)", () => {
    const openIn = now - 1 * HOUR;
    const chosen = now - 2 * HOUR; // before clock_in
    const res = validateBackdate(chosen, now, "out", openIn);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Must be after Clock In at \d{2}:\d{2}/);
  });

  it("rejects Clock Out equal to its own clock_in (zero duration)", () => {
    const openIn = now - 1 * HOUR;
    const res = validateBackdate(openIn, now, "out", openIn);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Must be after Clock In/);
  });

  it("accepts Clock Out strictly after clock_in", () => {
    const openIn = now - 2 * HOUR;
    const chosen = now - 30 * 60 * 1000;
    const res = validateBackdate(chosen, now, "out", openIn);
    expect(res.ok).toBe(true);
  });

  it("rejects Clock Out when no open shift exists", () => {
    const res = validateBackdate(now, now, "out", null);
    expect(res.ok).toBe(false);
  });

  it("rejects NaN / invalid timestamp", () => {
    const res = validateBackdate(NaN, now, "in");
    expect(res.ok).toBe(false);
  });
});

describe("findLastClosedShiftOutToday", () => {
  const todayMs = new Date("2026-06-02T15:00:00.000").getTime();
  const todayMidnight = new Date("2026-06-02T00:00:00.000").getTime();
  const yesterday = new Date("2026-06-01T22:00:00.000").getTime();

  it("returns null for empty entries", () => {
    expect(findLastClosedShiftOutToday([], todayMs)).toBeNull();
  });

  it("returns null when only open shifts exist", () => {
    const entries = [{ in: todayMidnight + HOUR, out: null }];
    expect(findLastClosedShiftOutToday(entries, todayMs)).toBeNull();
  });

  it("ignores shifts closed on previous days", () => {
    const entries = [{ in: yesterday - HOUR, out: yesterday }];
    expect(findLastClosedShiftOutToday(entries, todayMs)).toBeNull();
  });

  it("returns the latest clock_out from today's closed shifts", () => {
    const earlyOut = todayMidnight + 3 * HOUR; // 03:00
    const lateOut = todayMidnight + 10 * HOUR; // 10:00
    const entries = [
      { in: todayMidnight, out: earlyOut },
      { in: todayMidnight + 8 * HOUR, out: lateOut },
    ];
    expect(findLastClosedShiftOutToday(entries, todayMs)).toBe(lateOut);
  });

  it("ignores [DELETED] entries", () => {
    const out = todayMidnight + 5 * HOUR;
    const entries = [{ in: todayMidnight, out, comment: "[DELETED] foo" }];
    expect(findLastClosedShiftOutToday(entries, todayMs)).toBeNull();
  });
});

describe("toDatetimeLocalValue / parseDatetimeLocalValue", () => {
  it("formats a Date as YYYY-MM-DDTHH:MM in local time", () => {
    const d = new Date(2026, 5, 2, 14, 5); // June 2, 14:05 local
    expect(toDatetimeLocalValue(d)).toBe("2026-06-02T14:05");
  });

  it("formats a numeric ms timestamp the same way", () => {
    const d = new Date(2026, 0, 3, 8, 30);
    expect(toDatetimeLocalValue(d.getTime())).toBe("2026-01-03T08:30");
  });

  it("round-trips through parseDatetimeLocalValue (local time)", () => {
    const d = new Date(2026, 5, 2, 14, 5);
    const s = toDatetimeLocalValue(d);
    const ms = parseDatetimeLocalValue(s);
    // minute precision — drop seconds
    expect(Math.floor(ms / 60000)).toBe(Math.floor(d.getTime() / 60000));
  });

  it("returns NaN for empty / invalid input", () => {
    expect(parseDatetimeLocalValue("")).toBeNaN();
    expect(parseDatetimeLocalValue(null)).toBeNaN();
    expect(parseDatetimeLocalValue("not-a-date")).toBeNaN();
  });
});
