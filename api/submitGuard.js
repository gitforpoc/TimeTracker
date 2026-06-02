// Pure helpers for /api/submit hygiene checks. Extracted so we can unit-test
// the rules without spinning up the full handler (which depends on Supabase
// + Google Sheets I/O).
//
// Rules (matches client-side 1a validation in src/backdateValidation.js):
//   - client_time must parse as a valid date.
//   - Must not be more than 5 minutes in the future (allow small clock skew).
//   - Must not be more than 12 hours in the past (anti-abuse + matches the
//     STALE_OPEN_SHIFT_HOURS concept; legitimate offline sync within 12h is OK).
//   - Only enforced for Clock In / Clock Out actions; Day Off / Paid Off can
//     legitimately be a future or past date (user picks the calendar day).

export const FUTURE_SKEW_MS = 5 * 60 * 1000;             // 5 min
export const MAX_PAST_MS = 12 * 60 * 60 * 1000;          // 12 hours

/**
 * Validate the client_time field of an /api/submit payload.
 *
 * @param {object} body         req.body
 * @param {number} nowMs        Server's idea of "now" (Date.now()).
 * @returns {{ok: true} | {ok: false, error: string, status: number}}
 */
export function checkClientTime(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") return { ok: true }; // let normal flow 400 it
  const { action, client_time, timestamp } = body;

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

  const skewMs = nowMs - parsed;
  if (skewMs < -FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: "client_time is in the future" };
  }
  if (skewMs > MAX_PAST_MS) {
    return { ok: false, status: 400, error: "client_time too far in the past" };
  }

  return { ok: true };
}
