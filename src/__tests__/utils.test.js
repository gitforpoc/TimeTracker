import { describe, it, expect } from "vitest";
import { formatTime, formatDate, minsToHm, escapeHtml } from "../utils.js";

describe("formatTime", () => {
  it("formats morning time", () => {
    const d = new Date(2026, 2, 14, 8, 30, 0);
    expect(formatTime(d)).toBe("8:30am");
  });

  it("formats afternoon time", () => {
    const d = new Date(2026, 2, 14, 14, 5, 0);
    expect(formatTime(d)).toBe("2:05pm");
  });

  it("formats midnight", () => {
    const d = new Date(2026, 2, 14, 0, 0, 0);
    expect(formatTime(d)).toBe("12:00am");
  });

  it("formats noon", () => {
    const d = new Date(2026, 2, 14, 12, 0, 0);
    expect(formatTime(d)).toBe("12:00pm");
  });
});

describe("formatDate", () => {
  it("formats date with short month", () => {
    const d = new Date(2026, 2, 14);
    expect(formatDate(d)).toBe("Mar 14");
  });

  it("formats single digit day", () => {
    const d = new Date(2026, 0, 5);
    expect(formatDate(d)).toBe("Jan 5");
  });
});

describe("minsToHm", () => {
  it("converts 0 minutes", () => {
    expect(minsToHm(0)).toBe("0h 0m");
  });

  it("converts 480 minutes (8 hours)", () => {
    expect(minsToHm(480)).toBe("8h 0m");
  });

  it("converts 757 minutes (12h 37m)", () => {
    expect(minsToHm(757)).toBe("12h 37m");
  });

  it("converts 45 minutes", () => {
    expect(minsToHm(45)).toBe("0h 45m");
  });

  it("converts 60 minutes", () => {
    expect(minsToHm(60)).toBe("1h 0m");
  });
});

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('value="test"')).toBe("value=&quot;test&quot;");
  });

  it("escapes all special chars together", () => {
    expect(escapeHtml('<a href="x&y">')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;"
    );
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
