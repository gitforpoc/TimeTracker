import { describe, it, expect } from "vitest";
import { forecastEmployeeHours } from "../admin/forecast.js";

const periodStart = new Date(2026, 4, 1); // Fri May 1
const periodEnd = new Date(2026, 4, 14, 23, 59, 59, 999); // Thu May 14 (14-day window)

function buildSchedule(entries) {
  // entries: { "2026-05-05": { Alex: 480, Bulat: 600 }, ... }
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

describe("forecastEmployeeHours", () => {
  it("uses schedule when remaining days have planned hours", () => {
    // Now: May 5 noon — period 5/1-5/14. Days 1-5 done, days 6-14 remaining.
    // Actual: 40h so far. Schedule: 8h × 9 remaining days = 72h.
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
    expect(r.scheduledRemainingMin).toBe(9 * 8 * 60);
    expect(r.predictedMin).toBe((40 + 72) * 60);
  });

  it("falls back to linear extrapolation when schedule is empty for remaining days", () => {
    // Now: May 7 — day 7 of 14. Actual: 56h (i.e. 8h/day × 7 days). No schedule data.
    // Linear: 56h / 7 days × 7 remaining = 56h → predicted 112h.
    const now = new Date(2026, 4, 7, 23, 0);
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 56 * 60,
      periodStart,
      periodEnd,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("linear");
    expect(r.predictedMin).toBe(112 * 60);
  });

  it("returns actual only when period is over", () => {
    const now = new Date(2026, 4, 20); // after periodEnd
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

  it("returns actual only when no remaining days (last day of period)", () => {
    const now = new Date(2026, 4, 14, 18, 0); // Thu May 14 evening
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

  it("returns actual only when no hours yet (zero division guard)", () => {
    const now = new Date(2026, 4, 1, 9, 0); // Day 1, 9 AM, no shifts yet
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 0,
      periodStart,
      periodEnd,
      scheduleMap: new Map(),
      now,
    });
    expect(r.basis).toBe("actual_only");
    expect(r.predictedMin).toBe(0);
  });

  it("schedule beats linear when both are available", () => {
    // Worker has overworked early (linear would say 200h+) but schedule shows lighter remaining.
    const now = new Date(2026, 4, 3, 23, 0); // End of day 3
    const schedule = buildSchedule({
      "2026-05-04": { Alex: 480 },
      "2026-05-05": { Alex: 480 },
      // ... only 2 days planned — total schedule remaining = 16h
    });
    const r = forecastEmployeeHours({
      userName: "Alex",
      actualMinutes: 60 * 60, // 60h in 3 days
      periodStart,
      periodEnd,
      scheduleMap: schedule,
      now,
    });
    expect(r.basis).toBe("schedule");
    expect(r.predictedMin).toBe((60 + 16) * 60);
  });
});
