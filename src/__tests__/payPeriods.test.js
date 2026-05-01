import { describe, it, expect } from "vitest";
import {
  getWorkWeekStart,
  getWorkWeekEnd,
  getWeekKey,
  groupShiftsByWeek,
  calculateWeeklyOvertime,
  totalOvertimeMinutes,
  getSemiMonthlyPeriod,
  getBiWeeklyPeriod,
  getWeeklyPeriod,
  getPeriod,
  getPeriodList,
} from "../payPeriods.js";

// All assertions use local time. Tests run in UTC (vitest default), but the helpers use
// Date constructors with local components, so the Date objects under test are in the test runner's
// local zone — same as production browser behavior.

describe("workweek helpers", () => {
  it("Monday returns itself as week start", () => {
    const mon = new Date(2026, 3, 27); // Mon Apr 27 2026
    const start = getWorkWeekStart(mon);
    expect(start.getDay()).toBe(1);
    expect(start.toDateString()).toBe(mon.toDateString());
  });

  it("Sunday returns previous Monday as week start", () => {
    const sun = new Date(2026, 4, 3); // Sun May 3 2026
    const start = getWorkWeekStart(sun);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(27);
    expect(start.getMonth()).toBe(3); // April
  });

  it("Wednesday returns same-week Monday", () => {
    const wed = new Date(2026, 3, 29); // Wed Apr 29 2026
    const start = getWorkWeekStart(wed);
    expect(start.getDate()).toBe(27);
  });

  it("week end is Sunday 23:59:59", () => {
    const wed = new Date(2026, 3, 29);
    const end = getWorkWeekEnd(wed);
    expect(end.getDay()).toBe(0); // Sunday
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
  });

  it("week key is YYYY-MM-DD of Monday", () => {
    expect(getWeekKey(new Date(2026, 3, 29))).toBe("2026-04-27");
    expect(getWeekKey(new Date(2026, 4, 3))).toBe("2026-04-27"); // Sun belongs to prev Mon
  });
});

describe("overtime calculation", () => {
  it("zero hours = zero OT", () => {
    expect(totalOvertimeMinutes([])).toBe(0);
  });

  it("under threshold = no OT", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 27), duration_minutes: 8 * 60, type: "work" }, // Mon
      { clock_in: new Date(2026, 3, 28), duration_minutes: 8 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 29), duration_minutes: 8 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 30), duration_minutes: 8 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 8 * 60, type: "work" }, // Fri
    ];
    expect(totalOvertimeMinutes(shifts)).toBe(0); // exactly 40h
  });

  it("hours over threshold counted as OT", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 27), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 28), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 29), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 30), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 9 * 60, type: "work" },
    ];
    // 45h - 40h = 5h OT = 300 min
    expect(totalOvertimeMinutes(shifts)).toBe(300);
  });

  it("paid_off and day_off shifts do NOT count toward OT", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 27), duration_minutes: 480, type: "paid_off" }, // Mon Paid Off
      { clock_in: new Date(2026, 3, 28), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 29), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 30), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 10 * 60, type: "work" },
    ];
    // 40h work + 8h paid_off — no OT (work alone = 40h)
    expect(totalOvertimeMinutes(shifts)).toBe(0);
  });

  it("OT calculated separately per workweek", () => {
    const shifts = [
      // Week 1: Mon Apr 27 - Sun May 3 — 50h work
      { clock_in: new Date(2026, 3, 27), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 28), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 29), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 3, 30), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 10 * 60, type: "work" },
      // Week 2: Mon May 4 - Sun May 10 — 30h, no OT
      { clock_in: new Date(2026, 4, 4), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 5), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 6), duration_minutes: 10 * 60, type: "work" },
    ];
    const buckets = calculateWeeklyOvertime(shifts);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].otMin).toBe(10 * 60); // 50 - 40 = 10h
    expect(buckets[1].otMin).toBe(0);
  });

  it("custom threshold respected", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 27), duration_minutes: 36 * 60, type: "work" },
    ];
    expect(totalOvertimeMinutes(shifts, 35)).toBe(60); // 36 - 35 = 1h OT
    expect(totalOvertimeMinutes(shifts, 40)).toBe(0);
  });

  it("groupShiftsByWeek uses Monday as the bucket key", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 27), duration_minutes: 60, type: "work" }, // Mon
      { clock_in: new Date(2026, 4, 3), duration_minutes: 60, type: "work" }, // Sun (same week)
      { clock_in: new Date(2026, 4, 4), duration_minutes: 60, type: "work" }, // Mon (next week)
    ];
    const groups = groupShiftsByWeek(shifts);
    expect(groups.size).toBe(2);
    expect(groups.get("2026-04-27")).toHaveLength(2);
    expect(groups.get("2026-05-04")).toHaveLength(1);
  });
});

describe("semi-monthly period", () => {
  it("April 5 → April 1-15", () => {
    const p = getSemiMonthlyPeriod(new Date(2026, 3, 5));
    expect(p.start.getDate()).toBe(1);
    expect(p.end.getDate()).toBe(15);
    expect(p.label).toContain("Apr 1-15");
  });

  it("April 20 → April 16-30", () => {
    const p = getSemiMonthlyPeriod(new Date(2026, 3, 20));
    expect(p.start.getDate()).toBe(16);
    expect(p.end.getDate()).toBe(30);
    expect(p.label).toContain("Apr 16-30");
  });

  it("February 28 → handles short months (Feb 16-28 in non-leap, 16-29 in leap)", () => {
    const p = getSemiMonthlyPeriod(new Date(2026, 1, 28));
    expect(p.start.getDate()).toBe(16);
    expect(p.end.getDate()).toBe(28); // 2026 is not a leap year
  });
});

describe("bi-weekly period (anchor 2026-04-30 Thu)", () => {
  it("anchor date itself is start of period 1", () => {
    const p = getBiWeeklyPeriod(new Date(2026, 3, 30));
    expect(p.start.toDateString()).toBe(new Date(2026, 3, 30).toDateString());
    expect(p.end.toDateString()).toBe(new Date(2026, 4, 13).toDateString()); // Wed May 13
  });

  it("13 days after anchor still in period 1", () => {
    const p = getBiWeeklyPeriod(new Date(2026, 4, 13)); // Wed May 13
    expect(p.start.getDate()).toBe(30);
    expect(p.start.getMonth()).toBe(3); // April
  });

  it("14 days after anchor starts period 2", () => {
    const p = getBiWeeklyPeriod(new Date(2026, 4, 14)); // Thu May 14
    expect(p.start.toDateString()).toBe(new Date(2026, 4, 14).toDateString());
    expect(p.end.toDateString()).toBe(new Date(2026, 4, 27).toDateString()); // Wed May 27
  });

  it("date before anchor returns previous period", () => {
    const p = getBiWeeklyPeriod(new Date(2026, 3, 25)); // Sat Apr 25 — before anchor
    expect(p.start.toDateString()).toBe(new Date(2026, 3, 16).toDateString()); // Thu Apr 16
    expect(p.end.toDateString()).toBe(new Date(2026, 3, 29).toDateString()); // Wed Apr 29
  });

  it("period is always Thursday → Wednesday across many offsets (incl. DST)", () => {
    for (let offset = -50; offset < 50; offset++) {
      const date = new Date(2026, 3, 30);
      date.setDate(date.getDate() + offset);
      const p = getBiWeeklyPeriod(date);
      expect(p.start.getDay()).toBe(4); // Thursday
      expect(p.end.getDay()).toBe(3); // Wednesday
      // end is 13 days + 23:59:59.999 after start (rounds to 14 days, including DST shifts)
      const days = Math.round((p.end.getTime() - p.start.getTime()) / 86400000);
      expect(days).toBe(14);
    }
  });
});

describe("weekly period", () => {
  it("Wed returns Mon-Sun of that week", () => {
    const p = getWeeklyPeriod(new Date(2026, 3, 29)); // Wed Apr 29
    expect(p.start.getDay()).toBe(1); // Mon
    expect(p.end.getDay()).toBe(0); // Sun
    expect(p.start.getDate()).toBe(27);
  });
});

describe("getPeriod dispatch", () => {
  it("dispatches by type", () => {
    const date = new Date(2026, 3, 30);
    expect(getPeriod(date, "semi_monthly").value).toMatch(/^sm_/);
    expect(getPeriod(date, "bi_weekly").value).toMatch(/^bw_/);
    expect(getPeriod(date, "weekly").value).toMatch(/^wk_/);
  });

  it("falls back to semi_monthly for unknown types", () => {
    expect(getPeriod(new Date(), "garbage").value).toMatch(/^sm_/);
  });
});

describe("getPeriodList", () => {
  it("returns N consecutive periods, current first", () => {
    const list = getPeriodList("bi_weekly", 3, new Date(2026, 4, 14)); // Thu May 14 (start of period 2)
    expect(list).toHaveLength(3);
    expect(list[0].start.toDateString()).toBe(new Date(2026, 4, 14).toDateString());
    expect(list[1].start.toDateString()).toBe(new Date(2026, 3, 30).toDateString());
    expect(list[2].start.toDateString()).toBe(new Date(2026, 3, 16).toDateString());
  });

  it("semi-monthly list walks back through halves", () => {
    const list = getPeriodList("semi_monthly", 4, new Date(2026, 3, 20)); // Apr 20
    expect(list[0].label).toContain("Apr 16-30");
    expect(list[1].label).toContain("Apr 1-15");
    expect(list[2].label).toContain("Mar 16-31");
    expect(list[3].label).toContain("Mar 1-15");
  });
});
