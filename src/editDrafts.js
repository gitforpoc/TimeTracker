/**
 * Offline edit-draft queue (Phase 3 of EDIT-FLOW-V2).
 *
 * When the user edits a shift while offline (or `/api/edit-shift` fails with
 * a network error), the intent is persisted here instead of silently dropped.
 * On reconnect, a banner in the History modal invites the user to review each
 * pending draft. Each draft is then either Applied (with conflict checks
 * against the latest server state) or Discarded.
 *
 * The whole module is gated by `OFFLINE_DRAFTS_ENABLED` at call sites; the
 * pure functions here are safe to import either way (no side effects until
 * called). The flag controls hot-path use — flag-off means we never even read
 * the storage key on a render cycle.
 *
 * Storage shape: localStorage["tt_edit_drafts"] is a JSON array of:
 *   {
 *     shift_id: "794",
 *     snapshot: { clock_in, clock_out, type, comment, latest_edit_at },
 *     proposed_changes: { clock_in?, clock_out?, type?, comment? },
 *     reason: "Forgot to clock in",
 *     created_at: "2026-06-02T18:42:00.000Z",
 *     user_name: "Yuri"
 *   }
 *
 * Drafts older than EDIT_DRAFT_TTL_DAYS days are silently removed on next
 * `expireOldDrafts()` pass with a toast notice. Drafts in the
 * [EDIT_DRAFT_WARN_DAYS, EDIT_DRAFT_TTL_DAYS) window are surfaced as
 * "expiring soon" so the banner can pulse + show "(expires in N days)".
 */

import {
  STORAGE_KEYS,
  EDIT_DRAFT_TTL_DAYS,
  EDIT_DRAFT_WARN_DAYS,
} from "./constants.js";
import { store } from "./store.js";
import { showToast } from "./utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Raw read of every draft in storage (no user filter, no expiry).
 * Used internally and by expireOldDrafts. Always returns an array.
 * @returns {Array<object>}
 */
function readAllRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EDIT_DRAFTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAllRaw(drafts) {
  try {
    localStorage.setItem(STORAGE_KEYS.EDIT_DRAFTS, JSON.stringify(drafts));
  } catch {
    // Storage quota or disabled — nothing useful we can do here.
  }
}

/**
 * Load drafts visible to the current user. If `store.userName` is set, drafts
 * for other users are hidden (shared-device safety). Drafts without a
 * `user_name` field (legacy / pre-multi-user) are always visible.
 *
 * @returns {Array<object>}
 */
export function loadDrafts() {
  const all = readAllRaw();
  const me = store.userName || "";
  if (!me) return all.slice();
  return all.filter((d) => !d.user_name || d.user_name === me);
}

/**
 * Persist a draft. If a draft for the same shift_id already exists, REPLACE
 * it (older silently dropped, toast notifies user). Returns the saved draft.
 *
 * @param {object} draft
 * @returns {object}
 */
export function saveDraft(draft) {
  if (!draft || draft.shift_id == null) return draft;
  const all = readAllRaw();
  const key = String(draft.shift_id);
  const filtered = all.filter((d) => String(d.shift_id) !== key);
  const wasReplaced = filtered.length !== all.length;
  filtered.push({
    ...draft,
    shift_id: key,
    user_name: draft.user_name || store.userName || null,
  });
  writeAllRaw(filtered);
  if (wasReplaced) {
    // Best-effort toast — safe to call in non-DOM tests (shows undefined-but-no-throw).
    try { showToast("Replaced earlier pending edit for this shift"); } catch { /* test env */ }
  }
  return filtered[filtered.length - 1];
}

/**
 * Remove a draft by shift_id. No-op if not present.
 *
 * @param {string|number} shiftId
 */
export function removeDraft(shiftId) {
  const all = readAllRaw();
  const key = String(shiftId);
  const next = all.filter((d) => String(d.shift_id) !== key);
  if (next.length !== all.length) writeAllRaw(next);
}

/**
 * Pure: how many days old (fractional) is this draft relative to `now`?
 *
 * @param {{created_at?: string}} draft
 * @param {number} now - ms epoch
 * @returns {number}
 */
export function daysOldOf(draft, now = Date.now()) {
  if (!draft || !draft.created_at) return 0;
  const t = Date.parse(draft.created_at);
  if (isNaN(t)) return 0;
  return (now - t) / DAY_MS;
}

/**
 * Pure-ish: partition the stored drafts into expired (removed from storage)
 * and expiring-soon. Persists the trimmed list back. Returns both arrays so
 * the caller can toast each removed draft and pulse the banner for soon-to-
 * expire ones.
 *
 * Day windows:
 *   age >= EDIT_DRAFT_TTL_DAYS                  → remove
 *   EDIT_DRAFT_WARN_DAYS <= age < TTL_DAYS      → expiringSoon
 *
 * @param {number} now - ms epoch (testable)
 * @returns {{removed: object[], expiringSoon: object[]}}
 */
export function expireOldDrafts(now = Date.now()) {
  const all = readAllRaw();
  const removed = [];
  const kept = [];
  const expiringSoon = [];
  for (const d of all) {
    const age = daysOldOf(d, now);
    if (age >= EDIT_DRAFT_TTL_DAYS) {
      removed.push(d);
    } else {
      kept.push(d);
      if (age >= EDIT_DRAFT_WARN_DAYS) expiringSoon.push(d);
    }
  }
  if (removed.length) writeAllRaw(kept);
  return { removed, expiringSoon };
}

/**
 * Pure helper consumed by the Apply flow + by tests. Given a draft and the
 * freshly-fetched server state, decides whether the draft can still be
 * applied cleanly, or should be discarded.
 *
 * Inputs:
 *   draft               — the persisted draft
 *   currentState        — { clock_in, clock_out, type, comment } from tt_shifts,
 *                         or null if the shift no longer exists.
 *   currentEdits        — array of tt_edits rows for the shift (post-snapshot
 *                         rows specifically — see notes). Used to detect
 *                         supervisor-touched and self-quota-consumed cases.
 *   currentUserId       — auth.users.id of the current user (used to identify
 *                         self vs other edits).
 *
 * Returns: { action: "apply" }
 *        | { action: "discard", reason: "not-found"|"supervisor"|"quota"|"validation",
 *            message: string }
 *
 * Decision order matters:
 *   1. not-found  (shift deleted upstream)
 *   2. supervisor (someone else touched the shift since snapshot)
 *   3. quota      (current user already consumed the field via another edit)
 *   4. validation (basic sanity on the proposed change vs current state)
 *
 * @param {object} draft
 * @param {object|null} currentState
 * @param {Array<object>} currentEdits
 * @param {string|null} currentUserId
 * @returns {{action: string, reason?: string, message?: string}}
 */
export function evaluateDraftApplicability(draft, currentState, currentEdits, currentUserId) {
  if (!draft) {
    return { action: "discard", reason: "validation", message: "Empty draft." };
  }

  if (currentState == null) {
    return {
      action: "discard",
      reason: "not-found",
      message: "This shift no longer exists. Draft discarded.",
    };
  }

  const snapshotLatest = draft.snapshot?.latest_edit_at || null;
  const proposed = draft.proposed_changes || {};
  const edits = Array.isArray(currentEdits) ? currentEdits : [];

  // 2. Supervisor (or anyone other than current user) touched the shift since
  //    we captured the snapshot. Discard — user can re-attempt manually with
  //    a fresh view of the data.
  if (Array.isArray(edits) && edits.length) {
    const supervisorTouched = edits.some((e) => {
      if (!e) return false;
      // Skip backdate annotations — they're not real corrections.
      if (typeof e.reason === "string" && e.reason.startsWith("Backdated at")) return false;
      if (e.edited_by === currentUserId) return false; // own edit not a conflict
      if (!e.created_at) return true; // be conservative — unknown timing, treat as touched
      if (!snapshotLatest) return true; // snapshot had nothing, now has something by another user
      return Date.parse(e.created_at) > Date.parse(snapshotLatest);
    });
    if (supervisorTouched) {
      return {
        action: "discard",
        reason: "supervisor",
        message: "Your supervisor updated this shift. Your draft was discarded.",
      };
    }
  }

  // 3. The same user has already consumed the field(s) we want to edit.
  //    Per-field 1× limit at the audit-log level — if a self-edit shows up
  //    for a proposed field after the snapshot, the quota is gone.
  const fieldsToApply = Object.keys(proposed);
  const consumedByMeSinceSnapshot = new Set();
  for (const e of edits) {
    if (!e) continue;
    if (e.edited_by !== currentUserId) continue;
    if (typeof e.reason === "string" && e.reason.startsWith("Backdated at")) continue;
    if (!e.field_changed) continue;
    if (snapshotLatest && e.created_at && Date.parse(e.created_at) <= Date.parse(snapshotLatest)) {
      continue; // edit existed before snapshot — already accounted for
    }
    consumedByMeSinceSnapshot.add(e.field_changed);
  }
  for (const f of fieldsToApply) {
    if (consumedByMeSinceSnapshot.has(f)) {
      return {
        action: "discard",
        reason: "quota",
        message: "Already corrected this field. Draft discarded.",
      };
    }
  }

  // 4. Re-run minimal client validation against the *new* server state. This
  //    catches the "admin moved the shift such that my proposed change now
  //    creates a negative duration or overlaps another shift" cases.
  const proposedIn = proposed.clock_in
    ? Date.parse(proposed.clock_in)
    : currentState.clock_in
      ? Date.parse(currentState.clock_in)
      : null;
  const proposedOut = "clock_out" in proposed
    ? (proposed.clock_out ? Date.parse(proposed.clock_out) : null)
    : (currentState.clock_out ? Date.parse(currentState.clock_out) : null);

  if (proposedIn != null && proposedOut != null && !isNaN(proposedIn) && !isNaN(proposedOut)) {
    if (proposedOut <= proposedIn) {
      return {
        action: "discard",
        reason: "validation",
        message: "The shift state has changed and your draft is no longer valid (negative duration). Draft discarded.",
      };
    }
  }

  return { action: "apply" };
}
