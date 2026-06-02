// Pure validation helpers for the "backdate at tap" feature (action sheet picker).
//
// All inputs are millisecond timestamps so the functions are easy to test without
// touching <input type="datetime-local"> format quirks. The caller (main.js) is
// responsible for parsing the input value into a Date / ms first.
//
// Returned shape: { ok: true } | { ok: false, message: string }
//
// Bounds:
//   - Cannot be in the future.
//   - Cannot be more than 12 hours in the past (anti-abuse; also matches the
//     server-side hygiene guard in api/submit.js and the STALE_OPEN_SHIFT_HOURS
//     concept in src/payPeriods.js — we deliberately pick 12h over 16h to keep
//     the picker tight; legitimate "I forgot for 14h" cases still have History).
//   - Clock In: not before the most recent prior CLOSED shift today.
//   - Clock Out: strictly after this open shift's clock_in.

export const MAX_BACKDATE_HOURS = 12;
const MS_PER_HOUR = 3600000;

function fmtHM(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Validate a backdated clock-in/clock-out timestamp.
 *
 * @param {number} chosenMs            Timestamp the user picked (ms).
 * @param {number} nowMs               Current time (ms).
 * @param {"in"|"out"} action          Which clock action.
 * @param {number|null} openShiftInMs  For Clock Out: clock_in of the open shift.
 * @param {number|null} lastClosedOutMs For Clock In: clock_out of the most recent closed shift today (or null).
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function validateBackdate(
  chosenMs,
  nowMs,
  action,
  openShiftInMs = null,
  lastClosedOutMs = null
) {
  if (!Number.isFinite(chosenMs)) {
    return { ok: false, message: "Invalid time" };
  }
  // Allow a small skew (5s) for "user picked exactly now"
  if (chosenMs - nowMs > 5000) {
    return { ok: false, message: "Cannot be in the future" };
  }
  if (nowMs - chosenMs > MAX_BACKDATE_HOURS * MS_PER_HOUR) {
    return { ok: false, message: `Cannot be more than ${MAX_BACKDATE_HOURS}h ago` };
  }

  if (action === "in" && lastClosedOutMs != null && chosenMs < lastClosedOutMs) {
    return {
      ok: false,
      message: `Cannot be before your previous shift ended at ${fmtHM(lastClosedOutMs)}`,
    };
  }

  if (action === "out") {
    if (openShiftInMs == null) {
      return { ok: false, message: "No open shift to close" };
    }
    if (chosenMs <= openShiftInMs) {
      return {
        ok: false,
        message: `Must be after Clock In at ${fmtHM(openShiftInMs)}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Find the most recent closed shift's clock_out today (local time).
 * Used as the lower bound for Clock In backdating.
 *
 * @param {Array} entries  store.data
 * @param {number} nowMs   Current time (ms).
 * @returns {number|null}  ms of last clock_out today, or null.
 */
export function findLastClosedShiftOutToday(entries, nowMs) {
  if (!Array.isArray(entries)) return null;
  const now = new Date(nowMs);
  const todayStr = now.toDateString();
  let best = null;
  for (const e of entries) {
    if (!e || e.out == null) continue;
    if (e.comment && typeof e.comment === "string" && e.comment.startsWith("[DELETED]")) continue;
    const outDate = new Date(e.out);
    if (outDate.toDateString() !== todayStr) continue;
    if (best == null || e.out > best) best = e.out;
  }
  return best;
}

/**
 * Format a Date (or ms) as a "YYYY-MM-DDTHH:MM" string in LOCAL time, suitable
 * for <input type="datetime-local"> .value. Avoids the UTC slice trap.
 *
 * @param {Date|number} d
 * @returns {string}
 */
export function toDatetimeLocalValue(d) {
  const date = typeof d === "number" ? new Date(d) : d;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/**
 * Parse a "YYYY-MM-DDTHH:MM" datetime-local value into ms (local time).
 * Returns NaN if input is empty or malformed.
 *
 * @param {string} value
 * @returns {number}
 */
export function parseDatetimeLocalValue(value) {
  if (!value || typeof value !== "string") return NaN;
  // Native Date parsing handles "YYYY-MM-DDTHH:MM" as local time per spec.
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}
