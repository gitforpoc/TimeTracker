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

describe("workweek helpers (Thu-Wed, aligned with bi-weekly pay period)", () => {
  it("Thursday returns itself as week start", () => {
    const thu = new Date(2026, 3, 30); // Thu Apr 30 2026
    const start = getWorkWeekStart(thu);
    expect(start.getDay()).toBe(4);
    expect(start.toDateString()).toBe(thu.toDateString());
  });

  it("Wednesday returns same-week Thursday (6 days back)", () => {
    const wed = new Date(2026, 4, 6); // Wed May 6 2026
    const start = getWorkWeekStart(wed);
    expect(start.getDay()).toBe(4);
    expect(start.getDate()).toBe(30);
    expect(start.getMonth()).toBe(3); // April — Thu Apr 30
  });

  it("Friday returns same-week Thursday", () => {
    const fri = new Date(2026, 4, 1); // Fri May 1 2026
    const start = getWorkWeekStart(fri);
    expect(start.getDay()).toBe(4);
    expect(start.getDate()).toBe(30);
    expect(start.getMonth()).toBe(3); // April
  });

  it("Sunday returns previous Thursday as week start", () => {
    const sun = new Date(2026, 4, 3); // Sun May 3 2026
    const start = getWorkWeekStart(sun);
    expect(start.getDay()).toBe(4);
    expect(start.getDate()).toBe(30); // Apr 30
  });

  it("week end is Wednesday 23:59:59", () => {
    const fri = new Date(2026, 4, 1);
    const end = getWorkWeekEnd(fri);
    expect(end.getDay()).toBe(3); // Wednesday
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
  });

  it("week key is YYYY-MM-DD of Thursday (start of week)", () => {
    expect(getWeekKey(new Date(2026, 4, 1))).toBe("2026-04-30"); // Fri → Thu Apr 30
    expect(getWeekKey(new Date(2026, 4, 3))).toBe("2026-04-30"); // Sun belongs to prev Thu
    expect(getWeekKey(new Date(2026, 4, 6))).toBe("2026-04-30"); // Wed = last day of week
    expect(getWeekKey(new Date(2026, 4, 7))).toBe("2026-05-07"); // Thu = next week starts
  });
});

describe("overtime calculation (Thu-Wed workweek)", () => {
  it("zero hours = zero OT", () => {
    expect(totalOvertimeMinutes([])).toBe(0);
  });

  it("under threshold = no OT", () => {
    // Workweek Apr 30 (Thu) → May 6 (Wed). Five 8h shifts = 40h exactly.
    const shifts = [
      { clock_in: new Date(2026, 3, 30), duration_minutes: 8 * 60, type: "work" }, // Thu
      { clock_in: new Date(2026, 4, 1), duration_minutes: 8 * 60, type: "work" },  // Fri
      { clock_in: new Date(2026, 4, 4), duration_minutes: 8 * 60, type: "work" },  // Mon
      { clock_in: new Date(2026, 4, 5), duration_minutes: 8 * 60, type: "work" },  // Tue
      { clock_in: new Date(2026, 4, 6), duration_minutes: 8 * 60, type: "work" },  // Wed
    ];
    expect(totalOvertimeMinutes(shifts)).toBe(0);
  });

  it("hours over threshold counted as OT", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 30), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 4), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 5), duration_minutes: 9 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 6), duration_minutes: 9 * 60, type: "work" },
    ];
    // 45h - 40h = 5h OT = 300 min
    expect(totalOvertimeMinutes(shifts)).toBe(300);
  });

  it("paid_off and day_off shifts do NOT count toward OT", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 30), duration_minutes: 480, type: "paid_off" }, // Thu Paid Off
      { clock_in: new Date(2026, 4, 1), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 4), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 5), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 6), duration_minutes: 10 * 60, type: "work" },
    ];
    // 40h work + 8h paid_off — no OT (work alone = 40h)
    expect(totalOvertimeMinutes(shifts)).toBe(0);
  });

  it("OT calculated separately per workweek", () => {
    const shifts = [
      // Week 1: Thu Apr 30 - Wed May 6 — 50h work
      { clock_in: new Date(2026, 3, 30), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 1), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 4), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 5), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 6), duration_minutes: 10 * 60, type: "work" },
      // Week 2: Thu May 7 - Wed May 13 — 30h, no OT
      { clock_in: new Date(2026, 4, 7), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 8), duration_minutes: 10 * 60, type: "work" },
      { clock_in: new Date(2026, 4, 11), duration_minutes: 10 * 60, type: "work" },
    ];
    const buckets = calculateWeeklyOvertime(shifts);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].otMin).toBe(10 * 60); // 50 - 40 = 10h
    expect(buckets[1].otMin).toBe(0);
  });

  it("custom threshold respected", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 30), duration_minutes: 36 * 60, type: "work" },
    ];
    expect(totalOvertimeMinutes(shifts, 35)).toBe(60); // 36 - 35 = 1h OT
    expect(totalOvertimeMinutes(shifts, 40)).toBe(0);
  });

  it("groupShiftsByWeek uses Thursday as the bucket key", () => {
    const shifts = [
      { clock_in: new Date(2026, 3, 30), duration_minutes: 60, type: "work" }, // Thu
      { clock_in: new Date(2026, 4, 6), duration_minutes: 60, type: "work" },  // Wed (same week)
      { clock_in: new Date(2026, 4, 7), duration_minutes: 60, type: "work" },  // Thu (next week)
    ];
    const groups = groupShiftsByWeek(shifts);
    expect(groups.size).toBe(2);
    expect(groups.get("2026-04-30")).toHaveLength(2);
    expect(groups.get("2026-05-07")).toHaveLength(1);
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
  it("Friday returns Thu-Wed of that week", () => {
    const p = getWeeklyPeriod(new Date(2026, 4, 1)); // Fri May 1
    expect(p.start.getDay()).toBe(4); // Thursday
    expect(p.end.getDay()).toBe(3); // Wednesday
    expect(p.start.getDate()).toBe(30); // Thu Apr 30
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
