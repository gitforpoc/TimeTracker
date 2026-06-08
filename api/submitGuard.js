// Pure helpers for /api/submit hygiene checks. Extracted so we can unit-test
// the rules without spinning up the full handler (which depends on Supabase
// + Google Sheets I/O).
//
// What this guard is (and is NOT) for:
//   - It bounds how far a user may DELIBERATELY backdate a clock event (the
//     action-sheet picker lets them set the time up to 12h in the past). That
//     bound is measured against `actual_tap_time` — the real moment the button
//     was pressed — NOT against the server's "now".
//   - It does NOT police how long an event sat in the offline sync queue before
//     reaching the server. A real-time tap that syncs hours or days late has a
//     client_time far from server-now, and that data is CORRECT. The original
//     guard rejected anything >12h from server-now, which turned every
//     late-synced event into a permanently-rejected 400 — a poison pill that
//     blocked the whole sync queue (see src/sync.js head-of-line handling).
//
// Rules:
//   - client_time must parse as a valid date.
//   - Must not be more than 5 minutes in the future (clock-skew tolerance).
//   - If actual_tap_time is present: the deliberate backdate gap
//     (actual_tap_time − client_time) must be ≤ 12h (matches the picker).
//   - Sanity guard: reject client_time more than 35 days in the past (clearly a
//     broken device clock, would corrupt payroll). Legit late syncs are well
//     within this.
//   - Only enforced for Clock In / Clock Out; Day Off / Paid Off legitimately
//     target arbitrary calendar days.

export const FUTURE_SKEW_MS = 5 * 60 * 1000;             // 5 min
export const MAX_BACKDATE_MS = 12 * 60 * 60 * 1000;      // 12h — deliberate backdate cap
export const MAX_PAST_MS = 35 * 24 * 60 * 60 * 1000;     // 35 days — corrupt-clock sanity cap

/**
 * Validate the client_time field of an /api/submit payload.
 *
 * @param {object} body         req.body
 * @param {number} nowMs        Server's idea of "now" (Date.now()).
 * @returns {{ok: true} | {ok: false, error: string, status: number}}
 */
export function checkClientTime(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return { ok: true }; // let normal flow 400 it
  const { action, client_time, timestamp, actual_tap_time } = body;

  // Only guard the timed clock events.
  if (action !== "Clock In" && action !== "Clock Out") {
    return { ok: true };
  }

  // Payload from the client uses `timestamp` (see src/main.js sync.schedule).
  // Tolerate both names so this stays useful if the field is ever renamed.
  const raw = client_time ?? timestamp;
  if (!raw) {
    return { ok: false, status: 400, error: "Invalid client_time" };
  }
  const parsed = new Date(raw).getTime();
  if (!Number.isFinite(parsed)) {
    return { ok: false, status: 400, error: "Invalid client_time" };
  }

  // Never accept a future time (small clock-skew tolerance). Always enforced.
  if (parsed - nowMs > FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: "client_time is in the future" };
  }

  // Deliberate-backdate bound, measured against the real tap moment when the
  // client provided it. Independent of how long the event then queued offline.
  const tapMs = actual_tap_time ? new Date(actual_tap_time).getTime() : NaN;
  if (Number.isFinite(tapMs) && tapMs - parsed > MAX_BACKDATE_MS) {
    return { ok: false, status: 400, error: "Backdated too far (>12h)" };
  }

  // Corrupt-clock sanity guard. A legit late sync is well inside 35 days; only
  // a clearly broken device clock lands outside it.
  if (nowMs - parsed > MAX_PAST_MS) {
    return { ok: false, status: 400, error: "client_time too far in the past" };
  }

  return { ok: true };
}
