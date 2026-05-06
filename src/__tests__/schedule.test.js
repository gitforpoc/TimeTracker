import { describe, it, expect } from "vitest";
import {
  canonicalizeName,
  parseTimeToMinutes,
  computePlanMinutes,
  parseSchedule,
  sumScheduledMinutes,
} from "../admin/schedule.js";

describe("canonicalizeName", () => {
  it("strips parenthetical warehouse suffix", () => {
    expect(canonicalizeName("Alex       (Traffic)")).toBe("Alex");
    expect(canonicalizeName("Jairo       (Masp)")).toBe("Jairo");
    expect(canonicalizeName("Danila     (Masp4)")).toBe("Danila");
  });

  it("trims plain names without parens", () => {
    expect(canonicalizeName("Pavel ")).toBe("Pavel");
    expect(canonicalizeName("Yuri")).toBe("Yuri");
  });

  it("handles empty / null", () => {
    expect(canonicalizeName("")).toBe("");
    expect(canonicalizeName(null)).toBe("");
    expect(canonicalizeName(undefined)).toBe("");
  });
});

describe("parseTimeToMinutes", () => {
  it("parses AM times", () => {
    expect(parseTimeToMinutes("7:00 AM")).toBe(7 * 60);
    expect(parseTimeToMinutes("12:00 AM")).toBe(0); // midnight
    expect(parseTimeToMinutes("7:30 AM")).toBe(7 * 60 + 30);
  });

  it("parses PM times", () => {
    expect(parseTimeToMinutes("1:00 PM")).toBe(13 * 60);
    expect(parseTimeToMinutes("9:00 PM")).toBe(21 * 60);
    expect(parseTimeToMinutes("12:00 PM")).toBe(12 * 60); // noon
  });

  it("treats off-day markers as null", () => {
    expect(parseTimeToMinutes("0")).toBeNull();
    expect(parseTimeToMinutes("")).toBeNull();
    expect(parseTimeToMinutes(null)).toBeNull();
    expect(parseTimeToMinutes("0:00")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseTimeToMinutes("abc")).toBeNull();
    expect(parseTimeToMinutes("25:00 PM")).toBeNull();
  });
});

describe("computePlanMinutes", () => {
  it("regular 8-hour shift", () => {
    expect(computePlanMinutes("1:00 PM", "9:00 PM")).toBe(8 * 60);
  });

  it("morning to evening", () => {
    expect(computePlanMinutes("7:00 AM", "9:00 PM")).toBe(14 * 60);
  });

  it("off day returns 0", () => {
    expect(computePlanMinutes("0", "0")).toBe(0);
    expect(computePlanMinutes("", "")).toBe(0);
  });

  it("only one side filled returns 0", () => {
    expect(computePlanMinutes("7:00 AM", "0")).toBe(0);
  });

  it("midnight crossing — out earlier than in", () => {
    expect(computePlanMinutes("9:00 PM", "5:00 AM")).toBe(8 * 60); // 21:00 → 05:00 next day
  });

  it("guards against typo like 3pm-12pm yielding implausible 21h (caps to 0)", () => {
    // "3:00 PM" → 12:00 PM with midnight-cross interpretation = 21 hours, which is implausible.
    // Our cap rejects > 18h and returns 0 (treated as data error, not a real shift).
    expect(computePlanMinutes("3:00 PM", "12:00 PM")).toBe(0);
  });
});

const FIXTURE_CSV = `,,,,,,,,,
May 2026,Friday 05/01,,Saturday 05/02,,Sunday 05/03,,Monday 05/04,
,in,out,in,out,in,out,in,out
Alex       (Traffic),1:00 PM,9:00 PM,1:00 PM,9:00 PM,7:00 AM,9:00 PM,7:00 AM,3:00 PM
Jairo       (Masp),1:00 PM,9:00 PM,7:00 AM,3:00 PM,0,0,7:00 AM,3:00 PM
Pavel ,7:00 AM,3:00 PM,0,0,0,0,9:15 AM,6:45 PM
`;

describe("parseSchedule", () => {
  it("parses multi-employee multi-day fixture", () => {
    const map = parseSchedule(FIXTURE_CSV, 2026);
    expect(map.size).toBe(4); // 5/1, 5/2, 5/3, 5/4

    // 5/1 — Alex 8h, Jairo 8h, Pavel 8h
    const may1 = map.get("2026-05-01");
    expect(may1.get("Alex").planMinutes).toBe(8 * 60);
    expect(may1.get("Jairo").planMinutes).toBe(8 * 60);
    expect(may1.get("Pavel").planMinutes).toBe(8 * 60);

    // 5/3 — Alex 14h, Jairo off (no entry), Pavel off (no entry)
    const may3 = map.get("2026-05-03");
    expect(may3.get("Alex").planMinutes).toBe(14 * 60);
    expect(may3.has("Jairo")).toBe(false); // off-day cells skipped
    expect(may3.has("Pavel")).toBe(false);

    // 5/4 — Pavel 9:15 AM → 6:45 PM = 9h 30m
    const may4 = map.get("2026-05-04");
    expect(may4.get("Pavel").planMinutes).toBe(9 * 60 + 30);
  });

  it("returns empty map on garbage input", () => {
    expect(parseSchedule("").size).toBe(0);
    expect(parseSchedule("just one line").size).toBe(0);
  });

  it("ignores rows that look like header continuations (payroll/goal/total)", () => {
    const csv = `${FIXTURE_CSV}
Total GOAL 208h,,,,,,,,
1st payroll,,,,,,,,
`;
    const map = parseSchedule(csv, 2026);
    expect(map.get("2026-05-01").size).toBe(3); // Alex, Jairo, Pavel — no extras
  });
});

describe("sumScheduledMinutes", () => {
  it("sums hours across a date range for one employee", () => {
    const map = parseSchedule(FIXTURE_CSV, 2026);
    const start = new Date(2026, 4, 1);
    const end = new Date(2026, 4, 4);
    // Alex: 8 + 8 + 14 + 8 = 38h
    expect(sumScheduledMinutes(map, "Alex", start, end)).toBe(38 * 60);
    // Jairo: 8 + 8 + 0 + 8 = 24h
    expect(sumScheduledMinutes(map, "Jairo", start, end)).toBe(24 * 60);
  });

  it("returns 0 for unknown employee", () => {
    const map = parseSchedule(FIXTURE_CSV, 2026);
    expect(sumScheduledMinutes(map, "Ghost", new Date(2026, 4, 1), new Date(2026, 4, 4))).toBe(0);
  });

  it("returns 0 for date range outside schedule data", () => {
    const map = parseSchedule(FIXTURE_CSV, 2026);
    expect(sumScheduledMinutes(map, "Alex", new Date(2026, 5, 1), new Date(2026, 5, 30))).toBe(0);
  });
});
