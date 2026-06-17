// --- DOM ---
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

// --- Helpers ---
export function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatDateISO(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// --- NY-local pay-period boundaries (UTC instants) ---
// IDENTICAL copy of api/tzBounds.js (the api/ and src/ trees can't share a module
// across the Vercel build boundary). Keep in sync — src/__tests__/tzBounds.test.js
// asserts the two copies agree. See api/tzBounds.js for the full rationale: shifts
// must be bucketed by NY-local clock_in date, not the UTC date Postgres infers from
// a bare timestamp string, or evening shifts land in the wrong pay period.
export function nyOffsetMinutes(instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(instant).map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - instant.getTime()) / 60000;
}

export function nyDayStartUtc(dateStr, addDays = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d + addDays, 0, 0, 0));
  const offsetMin = nyOffsetMinutes(guess);
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

export function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
}

export function formatTimeShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

export function calcDuration(fromISO, to) {
  const diff = Math.floor((to - new Date(fromISO)) / 60000);
  if (diff < 0) return "—";
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

// Navigate to Shift Log tab with the employee filter pre-set.
// Used from anywhere a row click should "drill into this employee's shifts" — replaces the
// older detail-panel approach. Caller doesn't need a Back button: Shift Log is a normal tab.
export function goToShiftLogForEmployee(name) {
  const empSelect = $("#filter-employee");
  if (empSelect) empSelect.value = name;
  const tabBtn = document.querySelector('.tab[data-tab="shifts"]');
  if (tabBtn) tabBtn.click();
}

// --- Session state persistence ---
const SESSION_KEY = "tt_admin_state";

export function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

export function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null;
  } catch { return null; }
}
