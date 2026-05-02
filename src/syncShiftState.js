/**
 * Sync local shift state with the server's open-shift status.
 *
 * Fixes the cross-browser stale-state problem: a user who clocks in on browser A,
 * then opens browser B, sees no active shift (different localStorage). And vice versa
 * — a user who clocks out on browser B leaves browser A's localStorage thinking it's
 * still on shift, with a phantom timer.
 *
 * On every app load (for SSO users) and on visibility change, this module:
 *   1. Queries tt_shifts for any open work shift owned by the current user
 *   2. Compares with localStorage state
 *   3. Reconciles: 4 cases
 *      - server-OPEN, local-IN: nothing (already synced) or remap currentShiftId
 *      - server-OPEN, local-OUT: restore IN with server's shift data
 *      - server-NONE, local-IN: clear local IN state (phantom timer fix)
 *      - server-NONE, local-OUT: nothing (already synced)
 *
 * Skips sync if:
 *   - User is in guest mode (no SSO)
 *   - There are pending items in the sync queue (let them flush first; their server
 *     responses will inform state)
 *   - A clock action is in flight (user just tapped a button — server hasn't seen it yet)
 *
 * Guest mode users are unaffected: their localStorage IS the source of truth.
 */

import { store } from "./store.js";
import { sync } from "./sync.js";
import { getSupabaseClient } from "./auth.js";
import { startTimerLoop, stopTimerLoop } from "./timer.js";

const TOLERANCE_MS = 60_000; // 60s — clock_in match tolerance for picking up existing local entry

let syncing = false;
let pendingClockAction = false;

/**
 * Mark that a user-initiated clock action is in progress. Skip auto-sync until cleared.
 * Should be called from main.js around performClockAction.
 */
export function markClockActionStart() {
  pendingClockAction = true;
}

export function markClockActionEnd() {
  pendingClockAction = false;
}

/**
 * Reconcile local shift state with the server. Idempotent — safe to call on
 * every load and visibility change.
 *
 * @param {function} onStateChange - called after a sync that mutated state, with { from, to }
 *                                   so callers can refresh the UI
 */
export async function syncShiftStateFromServer(onStateChange) {
  // Guard: don't run concurrently
  if (syncing) return;

  // Guard: guest mode — server has nothing to say
  if (!store.userName) return;

  // Guard: pending sync queue items — they're racing to the same data
  if (sync.pendingCount > 0) return;

  // Guard: user is mid-action
  if (pendingClockAction) return;

  // Guard: offline — nothing to query
  if (!navigator.onLine) return;

  const supabase = getSupabaseClient();
  if (!supabase) return;

  syncing = true;
  try {
    // Re-confirm session — guest could be in store.userName from a previous SSO session
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data, error } = await supabase
      .from("tt_shifts")
      .select("id, user_name, clock_in, clock_out, type")
      .eq("user_name", store.userName)
      .eq("type", "work")
      .is("clock_out", null)
      .order("clock_in", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[syncShiftState] query failed:", error);
      return;
    }

    const serverOpen = data || null;
    const wasIn = store.status === "in";

    // Case D: server says no open shift, local also OUT → already synced
    if (!serverOpen && !wasIn) return;

    // Case C: server says no open shift, local says IN → close local
    if (!serverOpen && wasIn) {
      const phantom = store.findShift(store.currentShiftId);
      if (phantom && !phantom.out) {
        // Mark the local entry as closed so reports reflect reality.
        // We don't know exact clock_out from the server (no row left to read since shift was already closed).
        // The history fetch will eventually overwrite/merge with the actual server record.
        phantom.out = Date.now();
        phantom.duration = Math.max(
          0,
          Math.floor((phantom.out - phantom.in) / 60000),
        );
      }
      stopTimerLoop();
      store.status = "out";
      store.currentShiftId = null;
      store.save();
      onStateChange?.({ from: "in", to: "out", reason: "server-closed-elsewhere" });
      return;
    }

    // Case B: server has open shift, local says OUT → restore IN locally
    if (serverOpen && !wasIn) {
      const inMs = new Date(serverOpen.clock_in).getTime();
      let entry = store.data.find(
        (e) =>
          e.type === "work" &&
          !e.out &&
          Math.abs(e.in - inMs) < TOLERANCE_MS,
      );
      if (!entry) {
        entry = {
          id: serverOpen.id,
          dateObj: serverOpen.clock_in,
          type: "work",
          in: inMs,
          out: null,
          duration: 0,
        };
        store.addEntry(entry);
      }
      store.status = "in";
      store.currentShiftId = entry.id;
      store.save();
      startTimerLoop(() => store.findShift(store.currentShiftId));
      onStateChange?.({ from: "out", to: "in", reason: "server-open-elsewhere" });
      return;
    }

    // Case A: server has open shift AND local says IN
    // Verify they're the same shift (within 60s); if not, trust server
    const inMs = new Date(serverOpen.clock_in).getTime();
    const localShift = store.findShift(store.currentShiftId);
    const sameShift =
      localShift && Math.abs(localShift.in - inMs) < TOLERANCE_MS;
    if (!sameShift) {
      // Local thinks it's on a DIFFERENT shift than server. Trust server.
      let entry = store.data.find(
        (e) =>
          e.type === "work" &&
          !e.out &&
          Math.abs(e.in - inMs) < TOLERANCE_MS,
      );
      if (!entry) {
        entry = {
          id: serverOpen.id,
          dateObj: serverOpen.clock_in,
          type: "work",
          in: inMs,
          out: null,
          duration: 0,
        };
        store.addEntry(entry);
      }
      store.currentShiftId = entry.id;
      store.save();
      // Already showing IN — no UI change needed beyond shift remap
      onStateChange?.({ from: "in", to: "in", reason: "shift-remap" });
    }
    // else: already perfectly synced
  } finally {
    syncing = false;
  }
}

/**
 * Wire a debounced visibilitychange listener. Re-syncs state whenever the tab
 * comes back to foreground. Debounce prevents duplicate syncs from rapid focus events.
 */
export function installVisibilityListener(onStateChange) {
  let timer = null;
  const trigger = () => {
    if (document.visibilityState !== "visible") return;
    clearTimeout(timer);
    timer = setTimeout(() => syncShiftStateFromServer(onStateChange), 200);
  };
  document.addEventListener("visibilitychange", trigger);
  window.addEventListener("focus", trigger);
}
