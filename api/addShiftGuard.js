// Pure helpers for /api/add-shift validation. Extracted so we can unit-test
// the rules without spinning up the full handler (which depends on Supabase
// network I/O).
//
// Add Shift is the supervisor-initiated path for creating a fully-formed shift
// when an employee forgot BOTH clock in and clock out for a past day. Unlike
// /api/edit-shift (which mutates an existing shift), /api/add-shift writes
// directly to tt_shifts, bypassing the tt_process_log_entry trigger.

export const ADD_SHIFT_ALLOWED_TYPES = ["work", "paid_off"];
export const ADD_SHIFT_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 min tolerance for client clock skew

/**
 * Validate the body of an /api/add-shift POST payload.
 *
 * @param {object} body         req.body
 * @param {number} nowMs        Server's idea of "now" (Date.now()).
 * @returns {{ok: true, clockInMs: number, clockOutMs: number, durationMin: number}
 *         | {ok: false, error: string, status: number}}
 */
export function validateAddShiftBody(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Request body required" };
  }

  const { user_name, clock_in, clock_out, type, reason } = body;

  if (!user_name || typeof user_name !== "string" || !user_name.trim()) {
    return { ok: false, status: 400, error: "user_name required" };
  }

  if (!ADD_SHIFT_ALLOWED_TYPES.includes(type)) {
    return {
      ok: false,
      status: 400,
      error: `type must be one of: ${ADD_SHIFT_ALLOWED_TYPES.join(", ")}`,
    };
  }

  if (!reason || typeof reason !== "string" || !reason.trim()) {
    return { ok: false, status: 400, error: "reason required" };
  }

  if (!clock_in) {
    return { ok: false, status: 400, error: "clock_in required" };
  }
  if (!clock_out) {
    return { ok: false, status: 400, error: "clock_out required (open shifts not allowed here)" };
  }

  const clockInMs = new Date(clock_in).getTime();
  const clockOutMs = new Date(clock_out).getTime();

  if (!Number.isFinite(clockInMs)) {
    return { ok: false, status: 400, error: "Invalid clock_in" };
  }
  if (!Number.isFinite(clockOutMs)) {
    return { ok: false, status: 400, error: "Invalid clock_out" };
  }

  if (clockOutMs <= clockInMs) {
    return { ok: false, status: 400, error: "clock_out must be after clock_in" };
  }

  // clock_in must not be in the future (5-min tolerance for client clock skew).
  if (clockInMs > nowMs + ADD_SHIFT_FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: "clock_in cannot be in the future" };
  }

  const durationMin = Math.round((clockOutMs - clockInMs) / 60000);

  return { ok: true, clockInMs, clockOutMs, durationMin };
}

/**
 * Pure overlap detector. Two shifts overlap when
 *   existing.clock_in <= new.clock_out AND existing.clock_out >= new.clock_in
 * Open shifts (existing.clock_out null) are treated as overlapping any new shift
 * that starts at or after their clock_in — defensive choice for the admin path
 * (we don't want to silently create a past shift behind a currently-open one).
 *
 * @param {Array<{clock_in: string|null, clock_out: string|null}>} existingShifts
 *        Rows already in tt_shifts for the same user_name.
 * @param {number} newInMs    proposed clock_in, epoch ms
 * @param {number} newOutMs   proposed clock_out, epoch ms
 * @returns {{overlaps: boolean, conflict?: {clock_in: string|null, clock_out: string|null}}}
 */
export function findOverlap(existingShifts, newInMs, newOutMs) {
  if (!Array.isArray(existingShifts) || existingShifts.length === 0) {
    return { overlaps: false };
  }
  for (const s of existingShifts) {
    if (!s || !s.clock_in) continue;
    const exInMs = new Date(s.clock_in).getTime();
    if (!Number.isFinite(exInMs)) continue;
    // Open shift: treat as overlapping if proposed range touches anything at or
    // after its start. Admin should close that open shift first.
    if (!s.clock_out) {
      if (newOutMs >= exInMs) {
        return { overlaps: true, conflict: s };
      }
      continue;
    }
    const exOutMs = new Date(s.clock_out).getTime();
    if (!Number.isFinite(exOutMs)) continue;
    // Standard interval-overlap test (half-open at the boundary so back-to-back
    // shifts that share a clock_out=clock_in moment do NOT conflict).
    if (exInMs < newOutMs && exOutMs > newInMs) {
      return { overlaps: true, conflict: s };
    }
  }
  return { overlaps: false };
}
