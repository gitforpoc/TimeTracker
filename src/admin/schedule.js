// Schedule parser — reads the company-maintained "Storage daily" Google Sheets export.
//
// Sheet structure (CSV):
//   Row 1: junk / annotations
//   Row 2: date header — "May 2026" then "Friday 05/01" "" "Saturday 05/02" "" ... with
//          payroll-sum columns ("1st payroll GOAL 104h") interleaved between days.
//   Rows 3-5: continuation of multiline "2nd payroll" / "Total" headers — skipped.
//   Row 6: in/out labels under each date pair.
//   Row 7+: data rows. Col 0 = "Name (Warehouse)". Day cells alternate in/out times.
//
// We parse by anchoring on the row-2 date positions: every column whose header text matches
// a weekday-date pattern is a day "in" col; the very next column is its "out" col. Sum cells
// (whose header is "1st payroll …" or empty/non-date) are skipped automatically.
//
// Output: Map<dateISO, Map<canonicalName, { inTime, outTime, planMinutes }>>
// `planMinutes` is the scheduled shift length in minutes, 0 if marked "0,0" (day off).

const DATE_RE = /(\d{1,2})\/(\d{1,2})/;
// Match Excel/Sheets time strings like "1:00 PM", "07:30 AM" (case-insensitive, trimmed).
const TIME_RE = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i;

// Strip "(Maspeth)", trailing whitespace, etc. to get the canonical user_name that matches tt_employee_settings.
export function canonicalizeName(raw) {
  if (!raw) return "";
  return String(raw).replace(/\(.*?\)/g, "").trim();
}

// Parse "1:00 PM" → minutes since midnight, or null on "0" / "" / parse failure.
export function parseTimeToMinutes(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (trimmed === "" || trimmed === "0" || trimmed === "0:00") return null;
  const m = TIME_RE.exec(trimmed);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min > 59) return null; // 12-hour clock validation
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && h !== 12) h += 12;
  if (meridiem === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

// Convert a header date string like "Friday 05/01" → Date in given year.
function parseHeaderDate(text, year) {
  if (!text) return null;
  const m = DATE_RE.exec(String(text));
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Naive CSV row parser — handles quoted fields with commas/newlines. The Sheets export uses simple
// quoting (no embedded escaped quotes within quoted fields), which keeps this short.
function splitCsvRows(text) {
  const rows = [];
  let cur = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { buf += '"'; i++; }
        else inQuotes = false;
      } else buf += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(buf); buf = ""; }
      else if (c === "\n") { cur.push(buf); rows.push(cur); cur = []; buf = ""; }
      else if (c === "\r") { /* skip */ }
      else buf += c;
    }
  }
  if (buf.length > 0 || cur.length > 0) { cur.push(buf); rows.push(cur); }
  return rows;
}

// Compute scheduled minutes from in/out time strings. If out < in, assume midnight crossing.
// Returns 0 for off-day cells ("0", empty, both null).
export function computePlanMinutes(inStr, outStr) {
  const inMin = parseTimeToMinutes(inStr);
  const outMin = parseTimeToMinutes(outStr);
  if (inMin == null || outMin == null) return 0;
  let diff = outMin - inMin;
  if (diff <= 0) diff += 24 * 60; // crossed midnight
  // Cap at 18h to guard against typos like "3:00 PM, 12:00 PM" yielding 21h
  if (diff > 18 * 60) return 0;
  return diff;
}

// Main entry point. Returns Map<dateISO, Map<canonicalName, {inTime, outTime, planMinutes}>>.
// `defaultYear` is used for date headers that lack a year (the sheet shows MM/DD only).
export function parseSchedule(csvText, defaultYear = new Date().getFullYear()) {
  const rows = splitCsvRows(csvText);
  if (rows.length < 3) return new Map();

  // Locate the date header row — the first row with at least 2 cells matching MM/DD pattern.
  // Looking only at the first 6 rows handles the 4-row multiline header in real exports while
  // still letting test fixtures with a row-2 header parse cleanly.
  let dateRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const matches = rows[i].filter((c) => DATE_RE.test(c)).length;
    if (matches >= 2) { dateRowIdx = i; break; }
  }
  if (dateRowIdx === -1) return new Map();

  const dateRow = rows[dateRowIdx];

  // Year hint: extract year from row[0] of the date row if present, else defaultYear.
  let year = defaultYear;
  const yearMatch = /(\d{4})/.exec(dateRow[0] || "");
  if (yearMatch) year = parseInt(yearMatch[1], 10);

  // Build list of {colIndex, date} for every date cell. The "in" col = colIndex,
  // the "out" col = colIndex + 1. Sum/header columns are skipped because they don't match DATE_RE.
  const dateCols = [];
  for (let c = 0; c < dateRow.length; c++) {
    const date = parseHeaderDate(dateRow[c], year);
    if (date) dateCols.push({ inCol: c, outCol: c + 1, dateISO: toISODate(date) });
  }

  // Data rows: everything after the date row + 4 (date row + 3 continuation lines + in/out label row).
  // We tolerate variable header sizes by starting at dateRowIdx + 1 and skipping rows whose col 0 is empty
  // or matches "in,out" boilerplate.
  const result = new Map();
  for (let r = dateRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = canonicalizeName(row[0]);
    if (!name) continue; // empty / continuation rows
    if (/^in$/i.test(row[1] || "")) continue; // the in/out label row
    if (/payroll|goal|total/i.test(name)) continue; // header continuation rows leak in here

    for (const { inCol, outCol, dateISO } of dateCols) {
      const inStr = (row[inCol] || "").trim();
      const outStr = (row[outCol] || "").trim();

      // Truly empty cell (no data, no day-off marker) — skip
      if (inStr === "" && outStr === "") continue;

      // "0,0" → explicitly entered day off. Distinguished from missing data so forecast can
      // honor it and not assume work on that day.
      const isExplicitOff = (inStr === "0" || inStr === "0:00") && (outStr === "0" || outStr === "0:00");
      const planMinutes = isExplicitOff ? 0 : computePlanMinutes(inStr, outStr);

      // Skip cells we couldn't parse (typos, junk) — they're not useful as either work or off
      if (planMinutes === 0 && !isExplicitOff) continue;

      if (!result.has(dateISO)) result.set(dateISO, new Map());
      result.get(dateISO).set(name, { inTime: inStr, outTime: outStr, planMinutes });
    }
  }

  return result;
}

// Sum scheduled minutes for a single employee over a date range (inclusive).
export function sumScheduledMinutes(scheduleMap, userName, startDate, endDate) {
  let total = 0;
  const cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const iso = toISODate(cur);
    const dayMap = scheduleMap.get(iso);
    if (dayMap) {
      const entry = dayMap.get(userName);
      if (entry) total += entry.planMinutes;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

// Loader for use from admin/main.js. Caches in module scope so we hit the network once per page load.
let _cachedSchedule = null;
export async function loadSchedule(url = "/schedule.csv") {
  if (_cachedSchedule) return _cachedSchedule;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("schedule fetch failed:", res.status);
      _cachedSchedule = new Map();
      return _cachedSchedule;
    }
    const text = await res.text();
    _cachedSchedule = parseSchedule(text);
    return _cachedSchedule;
  } catch (e) {
    console.warn("schedule load error:", e);
    _cachedSchedule = new Map();
    return _cachedSchedule;
  }
}

// Test helper — clears the module-level cache.
export function _resetScheduleCache() {
  _cachedSchedule = null;
}
