import { describe, it, expect } from "vitest";

// These helper functions are copied from src/admin/main.js because that module
// imports CSS and uses DOM APIs (document.querySelector, etc.), making it
// impossible to import in a Node test environment. We test the implementations
// directly to ensure correctness without needing a browser environment.

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDateISO(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
}

function formatTimeShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

function calcDuration(fromISO, to) {
  const diff = Math.floor((to - new Date(fromISO)) / 60000);
  if (diff < 0) return "—";
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function toLocalDatetimeStr(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

// Monday calculation logic from admin/main.js init()
function getMondayForDate(today) {
  const monday = new Date(today);
  const dayOfWeek = today.getDay();
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(today.getDate() - daysBack);
  return monday;
}

// --- Tests ---

describe("esc (HTML escape)", () => {
  it("escapes ampersands", () => {
    expect(esc("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(esc("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes double quotes", () => {
    expect(esc('"hello"')).toBe("&quot;hello&quot;");
  });

  it("returns empty string for falsy values", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(esc("normal text")).toBe("normal text");
  });
});

describe("formatDateISO", () => {
  it("formats date as YYYY-MM-DD using LOCAL date", () => {
    const d = new Date(2026, 2, 14); // Mar 14, 2026 local
    expect(formatDateISO(d)).toBe("2026-03-14");
  });

  it("pads single-digit month and day", () => {
    const d = new Date(2026, 0, 5); // Jan 5
    expect(formatDateISO(d)).toBe("2026-01-05");
  });

  it("uses local date not UTC (month boundary)", () => {
    // Create a date that is March 1 locally — getFullYear/getMonth/getDate
    // should return local values, not UTC
    const d = new Date(2026, 2, 1);
    expect(formatDateISO(d)).toBe("2026-03-01");
    expect(d.getMonth()).toBe(2); // local month is March (index 2)
  });

  it("handles December correctly", () => {
    const d = new Date(2026, 11, 31);
    expect(formatDateISO(d)).toBe("2026-12-31");
  });
});

describe("formatDateShort", () => {
  it("formats as MM/DD", () => {
    expect(formatDateShort("2026-03-14T10:00:00")).toMatch(/^\d{2}\/\d{2}$/);
  });

  it("pads month and day", () => {
    // Create a date string for Jan 5 in local timezone
    const d = new Date(2026, 0, 5, 12, 0, 0);
    expect(formatDateShort(d.toISOString())).toBe("01/05");
  });

  it("returns dash for null/undefined", () => {
    expect(formatDateShort(null)).toBe("—");
    expect(formatDateShort(undefined)).toBe("—");
    expect(formatDateShort("")).toBe("—");
  });
});

describe("formatTimeShort", () => {
  it("formats morning time", () => {
    const d = new Date(2026, 2, 14, 8, 30);
    expect(formatTimeShort(d.toISOString())).toBe("8:30am");
  });

  it("formats afternoon time", () => {
    const d = new Date(2026, 2, 14, 14, 5);
    expect(formatTimeShort(d.toISOString())).toBe("2:05pm");
  });

  it("formats midnight as 12:00am", () => {
    const d = new Date(2026, 2, 14, 0, 0);
    expect(formatTimeShort(d.toISOString())).toBe("12:00am");
  });

  it("formats noon as 12:00pm", () => {
    const d = new Date(2026, 2, 14, 12, 0);
    expect(formatTimeShort(d.toISOString())).toBe("12:00pm");
  });

  it("returns dash for falsy input", () => {
    expect(formatTimeShort(null)).toBe("—");
    expect(formatTimeShort("")).toBe("—");
  });
});

describe("calcDuration", () => {
  it("calculates hours and minutes", () => {
    const from = "2026-03-14T08:00:00Z";
    const to = new Date("2026-03-14T10:30:00Z");
    expect(calcDuration(from, to)).toBe("2h 30m");
  });

  it("returns dash for negative duration", () => {
    const from = "2026-03-14T12:00:00Z";
    const to = new Date("2026-03-14T08:00:00Z");
    expect(calcDuration(from, to)).toBe("—");
  });

  it("returns 0h 00m for zero duration", () => {
    const from = "2026-03-14T10:00:00Z";
    const to = new Date("2026-03-14T10:00:00Z");
    expect(calcDuration(from, to)).toBe("0h 00m");
  });

  it("pads minutes with leading zero", () => {
    const from = "2026-03-14T08:00:00Z";
    const to = new Date("2026-03-14T09:05:00Z");
    expect(calcDuration(from, to)).toBe("1h 05m");
  });

  it("handles large durations", () => {
    const from = "2026-03-14T00:00:00Z";
    const to = new Date("2026-03-14T23:59:00Z");
    expect(calcDuration(from, to)).toBe("23h 59m");
  });
});

describe("toLocalDatetimeStr", () => {
  it("converts ISO to datetime-local format (YYYY-MM-DDThh:mm)", () => {
    const result = toLocalDatetimeStr("2026-03-14T15:30:00Z");
    // Should match datetime-local format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("returns empty string for falsy input", () => {
    expect(toLocalDatetimeStr(null)).toBe("");
    expect(toLocalDatetimeStr("")).toBe("");
    expect(toLocalDatetimeStr(undefined)).toBe("");
  });

  it("preserves local time components", () => {
    // Create a known local time and convert to ISO
    const local = new Date(2026, 2, 14, 15, 30);
    const iso = local.toISOString();
    const result = toLocalDatetimeStr(iso);
    // Should get back local time
    expect(result).toBe("2026-03-14T15:30");
  });
});

describe("Monday calculation", () => {
  it("returns same date when today is Monday", () => {
    // March 16, 2026 is a Monday
    const monday = new Date(2026, 2, 16);
    expect(monday.getDay()).toBe(1); // verify it's Monday
    const result = getMondayForDate(monday);
    expect(result.getDate()).toBe(16);
  });

  it("returns previous Monday for a Wednesday", () => {
    // March 18, 2026 is a Wednesday
    const wed = new Date(2026, 2, 18);
    expect(wed.getDay()).toBe(3);
    const result = getMondayForDate(wed);
    expect(result.getDate()).toBe(16);
  });

  it("returns previous Monday for a Friday", () => {
    // March 20, 2026 is a Friday
    const fri = new Date(2026, 2, 20);
    expect(fri.getDay()).toBe(5);
    const result = getMondayForDate(fri);
    expect(result.getDate()).toBe(16);
  });

  it("returns previous Monday for a Saturday", () => {
    // March 21, 2026 is a Saturday
    const sat = new Date(2026, 2, 21);
    expect(sat.getDay()).toBe(6);
    const result = getMondayForDate(sat);
    expect(result.getDate()).toBe(16);
  });

  it("handles Sunday edge case — goes back 6 days", () => {
    // March 22, 2026 is a Sunday
    const sun = new Date(2026, 2, 22);
    expect(sun.getDay()).toBe(0);
    const result = getMondayForDate(sun);
    expect(result.getDate()).toBe(16);
  });

  it("handles month boundary (Sunday in first week)", () => {
    // March 1, 2026 is a Sunday
    const sun = new Date(2026, 2, 1);
    expect(sun.getDay()).toBe(0);
    const result = getMondayForDate(sun);
    // Should go back to Feb 23
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(23);
  });
});
