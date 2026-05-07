import { describe, it, expect } from "vitest";
import { forecastEmployeeHours } from "../admin/forecast.js";

const periodStart = new Date(2026, 4, 1); // Fri May 1
const periodEnd = new Date(2026, 4, 14, 23, 59, 59, 999); // Thu May 14

function buildSchedule(entries) {
  const map = new Map();
  for (const [iso, perEmp] of Object.entries(entries)) {
    const dayMap = new Map();
    for (const [name, plan] of Object.entries(perEmp)) {
      dayMap.set(name, { inTime: "", outTime: "", planMinutes: plan });
    }
    map.set(iso, dayMap);
  }
  return map;
}

describe("forecastEmployeeHours — schedule-driven", () => {
  it("uses schedule when every remaining day has an entry", () => {
    // Now: May 5 noon. Tomorrow = 5/6, period ends 5/14 → 9 remaining days. Schedule covers all 9.
    const now = new Date(2026, 4, 5, 12, 0);
    const schedule = buildSchedule({
      "2026-05-06": { Alex: 480 },
      "2026-05-07": { Alex: 480 },
      "2026-05-08": { Alex: 480 },
      "2026-05-09": { Alex: 480 },
      "2026-05-10": { Alex: 480 },
      "2026-05-11": { Alex: 480 },
      "2026-05-12": { Alex: 480 },
      "2026-05-13": { Alex: 480 },
      "2026-05-14": { Alex: 480 },
    });
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 40 * 60,
      periodStart,
      periodEnd,
      scheduleMap: schedule,
      now,
    });
    expect(r.basis).toBe("schedule");
    expect(r.scheduledRemainingMin).toBe(9 * 480);
    expect(r.predictedMin).toBe(40 * 60 + 9 * 480);
  });

  it("explicit day off (planMinutes=0) contributes 0, not heuristic fallback", () => {
    const now = new Date(2026, 4, 5, 12, 0);
    const schedule = buildSchedule({
      "2026-05-06": { Alex: 480 },
      "2026-05-07": { Alex: 0 }, // explicit OFF — must be honored, not replaced with default 7.2h
      "2026-05-08": { Alex: 480 },
      "2026-05-09": { Alex: 480 },
      "2026-05-10": { Alex: 480 },
      "2026-05-11": { Alex: 480 },
      "2026-05-12": { Alex: 480 },
      "2026-05-13": { Alex: 480 },
      "2026-05-14": { Alex: 480 },
    });
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 40 * 60,
      periodStart,
      periodEnd,
      scheduleMap: schedule,
      now,
    });
    expect(r.basis).toBe("schedule");
    expect(r.scheduledRemainingMin).toBe(8 * 480); // 8 working days, not 9
  });
});

describe("forecastEmployeeHours — heuristic fallback (no schedule)", () => {
  it("regular days use 8.4h × 6/7 ≈ 7.2h per calendar day", () => {
    // Now: May 7 evening. Remaining 5/8 - 5/14 = 7 days. None are heat days (8-14 of month).
    // Heuristic: 7 × (504 × 6/7) = 7 × 432 = 3024 min = 50.4h.
    const now = new Date(2026, 4, 7, 23, 0);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 56 * 60,
      periodStart,
      periodEnd,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("heuristic");
    expect(r.scheduledRemainingMin).toBe(7 * Math.round(504 * 6 / 7)); // ≈ 3024
  });

  it("heat days (25-EOM, 1-2) use 10h flat — no day-off discount", () => {
    // Period 4/25 - 5/8 spans heat days 25, 26, 27, 28, 29, 30 (6 heat days) + 5/1, 5/2 (2 more)
    // Now: 4/24 just before. Remaining 4/25 - 5/8 = 14 days.
    // Heat days: 4/25, 4/26, 4/27, 4/28, 4/29, 4/30, 5/1, 5/2 = 8 heat days
    // Regular days: 5/3 - 5/8 = 6 days
    const altStart = new Date(2026, 3, 25); // Sat Apr 25
    const altEnd = new Date(2026, 4, 8, 23, 59, 59, 999); // Fri May 8
    const now = new Date(2026, 3, 24, 23, 0);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 0,
      periodStart: altStart,
      periodEnd: altEnd,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("heuristic");
    const expected = 8 * 600 + 6 * Math.round(504 * 6 / 7);
    expect(r.scheduledRemainingMin).toBe(expected);
  });
});

describe("forecastEmployeeHours — mixed strategy", () => {
  it("schedule for some days + heuristic for others = basis 'mixed'", () => {
    const now = new Date(2026, 4, 5, 12, 0);
    // Schedule has data for 5/6 only. Other 8 remaining days fall back to heuristic.
    const schedule = buildSchedule({
      "2026-05-06": { Alex: 480 },
    });
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 40 * 60,
      periodStart,
      periodEnd,
      scheduleMap: schedule,
      now,
    });
    expect(r.basis).toBe("mixed");
    // 1 day schedule (480) + 8 days heuristic — 5/7 - 5/14 are all regular (no heat days)
    const expected = 480 + 8 * Math.round(504 * 6 / 7);
    expect(r.scheduledRemainingMin).toBe(expected);
  });
});

describe("forecastEmployeeHours — edge cases", () => {
  it("returns actual_only when period is over", () => {
    const now = new Date(2026, 4, 20);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 90 * 60,
      periodStart,
      periodEnd,
      scheduleMap: null,
      now,
    });
    expect(r.basis).toBe("actual_only");
    expect(r.predictedMin).toBe(90 * 60);
  });

  it("returns actual_only on the last day (no future remaining)", () => {
    const now = new Date(2026, 4, 14, 18, 0);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 80 * 60,
      periodStart,
      periodEnd,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("actual_only");
    expect(r.predictedMin).toBe(80 * 60);
  });

  it("works without scheduleMap (heuristic only)", () => {
    const now = new Date(2026, 4, 7, 23, 0);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 56 * 60,
      periodStart,
      periodEnd,
      scheduleMap: null,
      now,
    });
    expect(r.basis).toBe("heuristic");
    expect(r.predictedMin).toBeGreaterThan(56 * 60); // adds something
  });

  it("Bulat scenario — currently 30h on 5/6, period ends 5/13", () => {
    // Real-world example from this conversation. Bulat has no schedule entries.
    // Expected: 8 regular days remaining × 7.2h ≈ 57.6h forecast remaining → predict ~88h.
    const now = new Date(2026, 4, 6, 12, 0);
    const start = new Date(2026, 3, 30);
    const end = new Date(2026, 4, 13, 23, 59, 59, 999);
    const r = forecastEmployeeHours({
      userName: "Bulat",
      actualMinutes: 30 * 60,
      periodStart: start,
      periodEnd: end,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("heuristic");
    // 8 days remaining (5/7 - 5/14? no, period ends 5/13. so 5/7-5/13 = 7 days).
    // Wait — let me recalc: now=5/6 noon, tomorrow=5/7. period end = 5/13 23:59. So 5/7-5/13 = 7 days.
    // None are heat days. 7 × 432 = 3024 min = 50.4h. Predicted = 30 + 50.4 = 80.4h.
    expect(r.scheduledRemainingMin).toBe(7 * Math.round(504 * 6 / 7));
    expect(r.predictedMin).toBeCloseTo(30 * 60 + 7 * Math.round(504 * 6 / 7), 0);
  });
});
