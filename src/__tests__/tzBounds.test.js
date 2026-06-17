import { describe, it, expect } from "vitest";
import { nyDayStartUtc as apiNyDayStartUtc, nyOffsetMinutes as apiNyOffset } from "../../api/tzBounds.js";
import { nyDayStartUtc as helpersNyDayStartUtc, nyOffsetMinutes as helpersNyOffset } from "../admin/helpers.js";

// The two copies (api/tzBounds.js for serverless get-report, src/admin/helpers.js
// for the browser admin bundle) must stay byte-for-byte equivalent in behavior.
describe("api and helpers copies agree", () => {
  const dates = ["2026-01-01", "2026-03-08", "2026-06-15", "2026-11-01", "2026-12-31"];
  for (const d of dates) {
    it(`nyDayStartUtc("${d}") matches across copies`, () => {
      expect(apiNyDayStartUtc(d)).toBe(helpersNyDayStartUtc(d));
      expect(apiNyDayStartUtc(d, 1)).toBe(helpersNyDayStartUtc(d, 1));
    });
  }
});

describe("nyOffsetMinutes (DST aware)", () => {
  it("is -240 (EDT) in summer", () => {
    expect(apiNyOffset(new Date("2026-06-15T12:00:00Z"))).toBe(-240);
  });
  it("is -300 (EST) in winter", () => {
    expect(apiNyOffset(new Date("2026-01-15T12:00:00Z"))).toBe(-300);
  });
});

describe("nyDayStartUtc", () => {
  it("maps NY midnight to 04:00 UTC in summer (EDT)", () => {
    expect(apiNyDayStartUtc("2026-06-01")).toBe("2026-06-01T04:00:00.000Z");
  });
  it("maps NY midnight to 05:00 UTC in winter (EST)", () => {
    expect(apiNyDayStartUtc("2026-01-01")).toBe("2026-01-01T05:00:00.000Z");
  });
  it("addDays gives the exclusive next-day NY midnight", () => {
    // End of the 1st-15th period: upper bound is NY-midnight of the 16th.
    expect(apiNyDayStartUtc("2026-06-15", 1)).toBe("2026-06-16T04:00:00.000Z");
  });
  it("handles month rollover with addDays", () => {
    expect(apiNyDayStartUtc("2026-06-30", 1)).toBe("2026-07-01T04:00:00.000Z");
  });
});

describe("Yuri shift-910 regression: NY-evening shift belongs to its NY date", () => {
  // Shift 910: clocked in 2026-06-15 22:14 NY = 2026-06-16 02:14 UTC.
  // A "June 1-15" payroll query must INCLUDE it (NY date is the 15th) and a
  // "June 16-30" query must EXCLUDE it.
  const shift910clockInUtc = new Date("2026-06-16T02:14:31.122Z").getTime();

  const inPeriod = (clockInMs, startStr, endStr) => {
    const gte = new Date(apiNyDayStartUtc(startStr)).getTime();
    const lt = new Date(apiNyDayStartUtc(endStr, 1)).getTime();
    return clockInMs >= gte && clockInMs < lt;
  };

  it("is included in the 1st-15th period", () => {
    expect(inPeriod(shift910clockInUtc, "2026-06-01", "2026-06-15")).toBe(true);
  });
  it("is excluded from the 16th-30th period", () => {
    expect(inPeriod(shift910clockInUtc, "2026-06-16", "2026-06-30")).toBe(false);
  });

  it("a genuine June-16 shift (NY) lands in 16-30, not 1-15", () => {
    // Shift 916: 2026-06-16 13:05 NY = 2026-06-16 17:05 UTC.
    const shift916 = new Date("2026-06-16T17:05:24.249Z").getTime();
    expect(inPeriod(shift916, "2026-06-01", "2026-06-15")).toBe(false);
    expect(inPeriod(shift916, "2026-06-16", "2026-06-30")).toBe(true);
  });
});
