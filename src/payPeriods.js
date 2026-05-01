// Pay-period and overtime helpers.
// All math runs in local time so DST transitions and day boundaries match the user's experience.
//
// Period types:
//   - semi_monthly: 1-15, 16-end of month
//   - bi_weekly:    14-day windows anchored to BI_WEEKLY_ANCHOR (Thursday) — period runs Thu → Wed
//   - weekly:       Monday → Sunday (FLSA standard workweek)
//
// Overtime: only `work` shifts count toward the weekly threshold (default 40). Paid Off / Day Off do not.

import { BI_WEEKLY_ANCHOR, DEFAULT_OVERTIME_THRESHOLD } from "./constants.js";

const MS_PER_DAY = 86400000;

// --- date helpers ---

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function diffDays(a, b) {
  // Local-day difference: floor((a_midnight - b_midnight) / day) avoids DST half-hours.
  const aMid = startOfDay(a).getTime();
  const bMid = startOfDay(b).getTime();
  return Math.round((aMid - bMid) / MS_PER_DAY);
}

function parseAnchor(iso) {
  // BI_WEEKLY_ANCHOR is a YYYY-MM-DD string interpreted as local midnight.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// --- workweek (Monday → Sunday, FLSA standard) ---

export function getWorkWeekStart(date) {
  const d = startOfDay(date);
  const dow = d.getDay(); // 0 = Sun, 1 = Mon ... 6 = Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addDays(d, -daysBack);
}

export function getWorkWeekEnd(date) {
  return endOfDay(addDays(getWorkWeekStart(date), 6));
}

export function getWeekKey(date) {
  const start = getWorkWeekStart(date);
  const y = start.getFullYear();
  const m = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// --- overtime calculation ---

// Group an array of shift-like objects by workweek key.
// Each shift must have `clock_in` (ISO string or Date) and `duration_minutes` (number).
// Only `type === 'work'` (or no type) is counted; paid_off/day_off shifts are ignored.
export function groupShiftsByWeek(shifts) {
  const map = new Map();
  for (const s of shifts) {
    if (s.type && s.type !== "work") continue;
    const key = getWeekKey(s.clock_in);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

// Returns an array of weekly buckets: [{ weekStart, weekEnd, totalMin, regMin, otMin, shifts }]
// `threshold` is in hours (default 40).
export function calculateWeeklyOvertime(shifts, threshold = DEFAULT_OVERTIME_THRESHOLD) {
  const groups = groupShiftsByWeek(shifts);
  const thresholdMin = threshold * 60;
  const buckets = [];

  for (const [key, weekShifts] of groups) {
    const totalMin = weekShifts.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    const otMin = Math.max(0, totalMin - thresholdMin);
    const regMin = totalMin - otMin;
    const weekStart = parseAnchor(key);
    buckets.push({
      weekKey: key,
      weekStart,
      weekEnd: endOfDay(addDays(weekStart, 6)),
      totalMin,
      regMin,
      otMin,
      shifts: weekShifts,
    });
  }

  buckets.sort((a, b) => a.weekStart - b.weekStart);
  return buckets;
}

// Returns total OT minutes across all weeks in the input.
export function totalOvertimeMinutes(shifts, threshold = DEFAULT_OVERTIME_THRESHOLD) {
  return calculateWeeklyOvertime(shifts, threshold).reduce((sum, w) => sum + w.otMin, 0);
}

// --- period boundaries ---

// Semi-monthly: 1-15 or 16-end of month.
export function getSemiMonthlyPeriod(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const isFirstHalf = day <= 15;
  const start = new Date(y, m, isFirstHalf ? 1 : 16);
  const lastDay = new Date(y, m + 1, 0).getDate();
  const end = endOfDay(new Date(y, m, isFirstHalf ? 15 : lastDay));
  const monthName = start.toLocaleDateString("en-US", { month: "short" });
  const label = `${monthName} ${isFirstHalf ? "1-15" : `16-${lastDay}`}, ${y}`;
  return { start, end, label, value: `sm_${y}_${m}_${isFirstHalf ? "1" : "2"}` };
}

// Bi-weekly: Thu → Wed, anchored to BI_WEEKLY_ANCHOR (2026-04-30).
export function getBiWeeklyPeriod(date, anchorISO = BI_WEEKLY_ANCHOR) {
  const anchor = parseAnchor(anchorISO);
  const days = diffDays(date, anchor);
  // Math.floor handles negative offsets (history before anchor) correctly.
  const periodOffset = Math.floor(days / 14);
  const start = addDays(anchor, periodOffset * 14);
  const end = endOfDay(addDays(start, 13));
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const label = `${startStr} – ${endStr}`;
  return { start, end, label, value: `bw_${getWeekKey(start)}` };
}

// Weekly: Monday → Sunday.
export function getWeeklyPeriod(date) {
  const start = getWorkWeekStart(date);
  const end = getWorkWeekEnd(date);
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const label = `${startStr} – ${endStr}`;
  return { start, end, label, value: `wk_${getWeekKey(start)}` };
}

// Dispatch by pay-period type.
export function getPeriod(date, periodType) {
  if (periodType === "bi_weekly") return getBiWeeklyPeriod(date);
  if (periodType === "weekly") return getWeeklyPeriod(date);
  return getSemiMonthlyPeriod(date);
}

// Returns recent N periods (current first, then back in time) for the given period type.
// Useful for populating period <select> dropdowns.
export function getPeriodList(periodType, count = 4, fromDate = new Date()) {
  const periods = [];
  let cursor = new Date(fromDate);
  for (let i = 0; i < count; i++) {
    const p = getPeriod(cursor, periodType);
    periods.push(p);
    // Step cursor back one period — use start - 1 day so we land in the previous period.
    cursor = addDays(p.start, -1);
  }
  return periods;
}
