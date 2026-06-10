import "../style.css";
import { QUOTES } from "./constants.js";
import { store } from "./store.js";
import { sync, formatStaleBannerText } from "./sync.js";
import { checkAuth } from "./auth.js";
import { initTimer, startTimerLoop, stopTimerLoop } from "./timer.js";
import { showDialog } from "./dialogs.js";
import {
  initHistory,
  setAuthState,
  openHistory,
  closeHistory,
  handlePeriodChange,
  renderReport,
  renderHistoryList,
  incrementBadge,
  copyReport,
  exportData,
  triggerRestore,
  importData,
  refreshDrafts,
} from "./history.js";
import {
  formatTime,
  formatDate,
  copyToClipboard,
  shareText,
  showToast,
  minsToHm,
} from "./utils.js";
import {
  requireGpsConsent,
  showContractorDisclaimer,
  initComplianceUI,
} from "./compliance.js";
import {
  syncShiftStateFromServer,
  installVisibilityListener,
  markClockActionStart,
  markClockActionEnd,
} from "./syncShiftState.js";
import {
  validateBackdate,
  findLastClosedShiftOutToday,
  toDatetimeLocalValue,
  parseDatetimeLocalValue,
  MAX_BACKDATE_HOURS,
} from "./backdateValidation.js";

// --- DOM Elements ---
const els = {
  mainBtn: document.getElementById("main-action-btn"),
  timer: document.getElementById("main-timer"),
  status: document.getElementById("status-label"),
  ringBlue: document.querySelector(".ring-progress-blue"),
  ringPink: document.querySelector(".ring-progress-pink"),
  quoteBox: document.getElementById("quote-box"),
  quoteText: document.getElementById("quote-text"),
  username: document.getElementById("username"),
  historyView: document.getElementById("history-view"),
  periodSelect: document.getElementById("period-select"),
  previewText: document.getElementById("msg-text"),
  badge: document.getElementById("history-badge"),
  customRangeBox: document.getElementById("custom-range-box"),
  dateStart: document.getElementById("date-start"),
  dateEnd: document.getElementById("date-end"),
  autoShareToggle: document.getElementById("auto-share-toggle"),
  geoToggle: document.getElementById("geo-toggle"),
  sheetOverlay: document.getElementById("sheet-overlay"),
  sheet: document.getElementById("action-sheet"),
  sheetTitle: document.getElementById("sheet-title"),
  sheetDesc: document.getElementById("sheet-desc"),
  sheetConfirm: document.getElementById("sheet-confirm"),
  sheetCancel: document.getElementById("sheet-cancel"),
  // Backdate-at-tap picker
  sheetBackdateLabel: document.getElementById("sheet-backdate-label"),
  sheetBackdateTime: document.getElementById("sheet-backdate-time"),
  sheetBackdateToggle: document.getElementById("sheet-backdate-toggle"),
  sheetBackdateEditor: document.getElementById("sheet-backdate-editor"),
  sheetBackdateInput: document.getElementById("sheet-backdate-input"),
  sheetBackdateError: document.getElementById("sheet-backdate-error"),
  restoreInput: document.getElementById("restore-file"),
  // Stale-queue banner — visible when queue items are >1h old or auth is broken
  staleBanner: document.getElementById("stale-queue-banner"),
  staleBannerTitle: document.getElementById("stale-queue-banner-title"),
  staleBannerDetail: document.getElementById("stale-queue-banner-detail"),
};

// --- Init modules ---
initTimer(els);
initHistory(els);

// --- Debounce ---
let lastClickTime = 0;

// --- Validation ---
function validateUser() {
  if (!store.userName.trim()) {
    els.username.classList.add("input-error");
    showToast("Please enter your name first");
    setTimeout(() => els.username.classList.remove("input-error"), 400);
    return false;
  }
  return true;
}

function checkInputState() {
  if (store.userName.trim().length > 0) {
    els.username.classList.add("filled");
  } else {
    els.username.classList.remove("filled");
  }
}

// --- UI Rendering ---
function renderUI() {
  if (store.status === "in") {
    els.mainBtn.innerText = "CLOCK OUT";
    els.mainBtn.classList.add("clock-out");
    els.mainBtn.classList.remove("pending");
    els.status.innerText = "ON SHIFT";
    els.status.style.color = "var(--pink)";
  } else {
    els.mainBtn.innerText = "CLOCK IN";
    els.mainBtn.classList.remove("clock-out");
    els.mainBtn.classList.remove("pending");
    els.status.innerText = "OFF DUTY";
    els.status.style.color = "var(--gray)";
  }
}

function showQuote() {
  els.quoteText.innerText = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  els.quoteBox.classList.remove("hidden");
}

function hideQuote() {
  els.quoteBox.classList.add("hidden");
}

// --- Action Sheet ---
// Backdate state — per open of the action sheet.
let sheetAction = null;            // "in" | "out"
let sheetOpenedAtMs = 0;            // for `min` bound on input
let sheetUserPickedMs = null;       // null until user actively edits
let sheetOpenShiftInMs = null;      // for Clock Out validation
let sheetLastClosedOutMs = null;    // for Clock In validation

function setupBackdatePicker(action, now) {
  sheetAction = action;
  sheetOpenedAtMs = now.getTime();
  sheetUserPickedMs = null;

  // Reset UI to collapsed state — the picker is hidden by default; 90%+ of
  // users tap CLOCK IN without ever interacting with it.
  els.sheetBackdateEditor.classList.add("hidden");
  els.sheetBackdateError.textContent = "";
  els.sheetBackdateInput.classList.remove("invalid");
  els.sheetBackdateToggle.textContent = "◂ edit";
  els.sheetBackdateLabel.textContent = action === "in" ? "Started at" : "Ended at";
  els.sheetBackdateTime.textContent = formatTime(now);

  // datetime-local bounds: min = now-12h, max = now (anti-future)
  const minMs = sheetOpenedAtMs - MAX_BACKDATE_HOURS * 3600000;
  els.sheetBackdateInput.min = toDatetimeLocalValue(minMs);
  els.sheetBackdateInput.max = toDatetimeLocalValue(sheetOpenedAtMs);
  els.sheetBackdateInput.value = toDatetimeLocalValue(sheetOpenedAtMs);

  // Cache validation context for the input handler.
  if (action === "out") {
    const shift = store.findShift(store.currentShiftId);
    sheetOpenShiftInMs = shift ? shift.in : null;
    sheetLastClosedOutMs = null;
  } else {
    sheetOpenShiftInMs = null;
    sheetLastClosedOutMs = findLastClosedShiftOutToday(store.data, sheetOpenedAtMs);
  }
}

function onBackdateInput() {
  const value = els.sheetBackdateInput.value;
  const chosenMs = parseDatetimeLocalValue(value);
  const verdict = validateBackdate(
    chosenMs,
    Date.now(),
    sheetAction,
    sheetOpenShiftInMs,
    sheetLastClosedOutMs
  );
  if (verdict.ok) {
    sheetUserPickedMs = chosenMs;
    els.sheetBackdateError.textContent = "";
    els.sheetBackdateInput.classList.remove("invalid");
    els.sheetConfirm.disabled = false;
    els.sheetBackdateTime.textContent = formatTime(new Date(chosenMs));
  } else {
    sheetUserPickedMs = null;
    els.sheetBackdateError.textContent = verdict.message;
    els.sheetBackdateInput.classList.add("invalid");
    els.sheetConfirm.disabled = true;
  }
}

function onBackdateToggle() {
  const hidden = els.sheetBackdateEditor.classList.toggle("hidden");
  if (!hidden) {
    // Just expanded — focus the input for immediate keyboard use.
    els.sheetBackdateInput.focus();
  } else {
    // Collapsed — revert any pending pick and re-enable confirm.
    sheetUserPickedMs = null;
    els.sheetBackdateError.textContent = "";
    els.sheetBackdateInput.classList.remove("invalid");
    els.sheetConfirm.disabled = false;
    els.sheetBackdateTime.textContent = formatTime(new Date(sheetOpenedAtMs));
  }
}

// Bind once at module load.
els.sheetBackdateInput.addEventListener("input", onBackdateInput);
els.sheetBackdateInput.addEventListener("change", onBackdateInput);
els.sheetBackdateToggle.addEventListener("click", onBackdateToggle);

function openActionSheet() {
  const now = new Date();
  const timeStr = formatTime(now);
  els.sheetConfirm.disabled = false;

  if (store.status === "out") {
    els.sheetTitle.innerText = "Start Shift?";
    els.sheetDesc.innerText = `Time: ${timeStr}`;
    els.sheetConfirm.innerText = "CLOCK IN";
    els.sheetConfirm.className = "btn-main";
    els.sheetConfirm.onclick = () => performClockAction("in");
    setupBackdatePicker("in", now);
  } else {
    const shift = store.findShift(store.currentShiftId);
    let durationStr = "0h 0m";
    if (shift) {
      const diff = Math.floor((now.getTime() - shift.in) / 60000);
      durationStr = minsToHm(diff);
    }
    els.sheetTitle.innerText = "End Shift?";
    els.sheetDesc.innerText = `Duration: ${durationStr}`;
    els.sheetConfirm.innerText = "CLOCK OUT";
    els.sheetConfirm.className = "btn-main clock-out";
    els.sheetConfirm.onclick = () => performClockAction("out");
    setupBackdatePicker("out", now);
  }

  els.sheetCancel.onclick = closeActionSheet;
  els.sheetOverlay.classList.remove("hidden");
  els.sheet.classList.remove("hidden");
  requestLocation(); // refresh GPS before confirm
}

function closeActionSheet() {
  els.sheetOverlay.classList.add("hidden");
  els.sheet.classList.add("hidden");
}

// --- Location & Timezone ---
const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let lastCoords = null;

function requestLocation() {
  if (!store.geoEnabled || !navigator.geolocation) return Promise.resolve();
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        resolve();
      },
      () => { lastCoords = null; resolve(); },
      { timeout: 5000, maximumAge: 60000 }
    );
  });
}

// Pre-fetch location if enabled
if (store.geoEnabled) requestLocation();

function getMetaFields() {
  return {
    timezone: userTimezone,
    lat: lastCoords?.lat ?? null,
    lng: lastCoords?.lng ?? null,
  };
}

// --- Core Actions ---
async function performClockAction(action) {
  // Capture user-picked backdate (if any) BEFORE closing the sheet — closing
  // tears down the picker state.
  const pickedAtConfirm = sheetUserPickedMs;
  closeActionSheet();
  // Block background state-sync while we're mid-action (avoid race with cross-browser reconcile)
  markClockActionStart();
  // Show immediate feedback while GPS resolves
  els.mainBtn.classList.add("pending");
  els.mainBtn.innerText = action === "in" ? "STARTING..." : "ENDING...";
  els.mainBtn.disabled = true;
  // GPS does NOT block submit: it's pre-fetched on app load + on openActionSheet,
  // so lastCoords is usually fresh by the time the user confirms. If still null
  // (denied / first-acquire too slow / sub-second confirm), submit goes through
  // with lat=lng=null — payroll doesn't depend on GPS, zone matching is best-effort.
  // This shrinks the click→fetch window from up to 5s to <100ms, which is critical
  // for devices with aggressive battery optimization that kill the WebView the
  // moment the share sheet steals focus (Samsung in particular).
  const realNow = new Date();
  // If the user backdated, startedAt reflects that; otherwise it's realNow.
  // Treat picks within 1s of realNow as "no edit" — avoids spurious tt_edits
  // rows from sub-second formatting roundtrips.
  const startedAt =
    pickedAtConfirm != null && Math.abs(pickedAtConfirm - realNow.getTime()) > 1000
      ? new Date(pickedAtConfirm)
      : realNow;
  const wasBackdated = startedAt !== realNow;
  const timeStr = formatTime(startedAt);
  let msg = "";
  let syncItemId = null;

  if (action === "in") {
    const newShift = {
      // id stays realNow — keeps client_id-based dedup intact even when backdated.
      id: realNow.getTime(),
      dateObj: startedAt.toISOString(),
      type: "work",
      in: startedAt.getTime(),
      out: null,
      duration: 0,
    };
    store.addEntry(newShift);
    store.currentShiftId = newShift.id;
    store.status = "in";
    store.save();

    showQuote();
    startTimerLoop(() => store.findShift(store.currentShiftId));

    msg = `${timeStr} ${store.userName} - clock in`;

    sync.schedule(newShift.id, {
      name: store.userName,
      action: "Clock In",
      id: newShift.id,
      timestamp: startedAt.toISOString(),
      localTime: timeStr,
      // Only included when user actually backdated — server uses presence
      // (and difference from client_time) to decide whether to write a
      // tt_edits "Backdated at clock-in" audit row.
      ...(wasBackdated ? { actual_tap_time: realNow.toISOString() } : {}),
      ...getMetaFields(),
    });
    syncItemId = newShift.id;
  } else {
    const shift = store.findShift(store.currentShiftId);
    if (shift) {
      shift.out = startedAt.getTime();
      shift.duration = Math.floor((shift.out - shift.in) / 60000);

      const outId = `${shift.id}_out`;
      sync.schedule(outId, {
        name: store.userName,
        action: "Clock Out",
        id: shift.id,
        timestamp: startedAt.toISOString(),
        localTime: timeStr,
        ...(wasBackdated ? { actual_tap_time: realNow.toISOString() } : {}),
        ...getMetaFields(),
      });
      syncItemId = outId;
    }

    store.status = "out";
    store.currentShiftId = null;
    store.save();
    stopTimerLoop();
    hideQuote();

    msg = `${timeStr} ${store.userName} - clock out`;
  }

  // Note: previously awaited sync.awaitItem(2s) here so server-ack came before share.
  // Removed because the setTimeout-based await consumed user-activation, breaking
  // navigator.share() and navigator.clipboard.writeText() on Android Chrome
  // (system promp "wants to see text and images copied to the clipboard",
  // empty share sheet). Sync queue persists in localStorage and retries on
  // visibilitychange / online — data still reaches the server reliably.
  els.mainBtn.disabled = false;
  renderUI();
  copyToClipboard(msg);
  els.previewText.innerText = msg;
  incrementBadge();

  if (store.autoShare) shareText(msg);

  // Action complete — background sync may resume.
  setTimeout(() => markClockActionEnd(), 2000);
}

async function addSpecialDay(type) {
  if (!validateUser()) return;

  const dateInput = await showDialog(`Select date for ${type}`, "date");
  if (!dateInput) return;

  const [y, m, d] = dateInput.split("-").map(Number);
  const selectedDate = new Date(y, m - 1, d);

  if (isNaN(selectedDate.getTime())) {
    showToast("Invalid date format");
    return;
  }

  const isToday = selectedDate.toDateString() === new Date().toDateString();
  if (store.status === "in" && isToday) {
    const confirm = await showDialog(
      "You are currently ON SHIFT. Add a day off for today anyway?",
      false
    );
    if (!confirm) return;
  }

  const hasConflict = store.data.some(
    (i) => new Date(i.dateObj).toDateString() === selectedDate.toDateString()
  );
  if (hasConflict) {
    const confirm = await showDialog(
      "You already have an entry for this date. Add another one?",
      false
    );
    if (!confirm) return;
  }

  const dur = type === "Paid Off" ? 480 : 0;
  const entryId = Date.now();
  store.addEntry({
    id: entryId,
    dateObj: selectedDate.toISOString(),
    type: type,
    in: null,
    out: null,
    duration: dur,
  });

  const msg = `${formatDate(selectedDate)} ${store.userName} - ${type}`;
  copyToClipboard(msg);
  els.previewText.innerText = msg;
  showToast(`${type} added`);
  incrementBadge();

  sync.schedule(entryId, {
    name: store.userName,
    action: type,
    id: entryId,
    timestamp: selectedDate.toISOString(),
    localTime: "N/A",
    timezone: userTimezone,
  });
}

// --- SSO Auth ---
let isAuthenticated = false;

// Reveal the app and dismiss the splash screen. Called once auth has resolved
// (either successfully → app shown; or guest mode on localhost → app shown).
// On production redirect-to-login, we deliberately DO NOT call this — the
// splash stays visible while the browser navigates away, preventing a flash
// of the underlying app UI.
function revealApp() {
  const splash = document.getElementById("splash-screen");
  if (splash) {
    splash.classList.add("fade-out");
    splash.addEventListener("animationend", () => splash.remove(), { once: true });
  }
  const appEl = document.querySelector(".app");
  if (appEl) appEl.classList.add("ready");
}

async function initAuth(retryCount = 0) {
  const auth = await checkAuth();
  if (auth) {
    isAuthenticated = true;
    store.saveUser(auth.name);
    els.username.value = auth.name;
    els.username.readOnly = true;
    els.username.classList.add("locked");
    revealApp(); // session valid — show the app immediately

    // Get token for APIs and set up sync
    const { getSupabaseClient } = await import("./auth.js");
    const client = getSupabaseClient();
    if (client) {
      const { data: { session } } = await client.auth.getSession();
      if (session) {
        setAuthState(true, session.access_token, session.user.id);

        // Enable sync for authenticated users — fresh token on each call
        sync.setTokenGetter(async () => {
          const { data: { session: s } } = await client.auth.getSession();
          return s?.access_token || null;
        });
        // Wire session refresh so the queue can recover from 401 mid-stream
        // (auth expired between two POSTs). Without this, every queued event
        // would 401 forever and stay in localStorage until manual reload.
        sync.setSessionRefresher(async () => client.auth.refreshSession());
        sync.processQueue();

        // Reconcile shift state with server — fixes stale localStorage when user
        // hops between browsers/devices. Re-syncs on visibilitychange + focus.
        const onSyncedStateChange = ({ reason }) => {
          renderUI();
          if (reason === "server-closed-elsewhere") {
            showToast("Shift was ended on another device");
          } else if (reason === "server-open-elsewhere") {
            showToast("Resumed shift from another device");
          }
        };
        // Initial reconciliation, after token is set so RLS reads work
        syncShiftStateFromServer(onSyncedStateChange);
        installVisibilityListener(onSyncedStateChange);

        // Show admin link for supervisors/admins (non-blocking)
        client.from("user_access")
          .select("role")
          .eq("user_id", session.user.id)
          .eq("app_id", "timetracker")
          .single()
          .then(({ data }) => {
            if (data && ["admin", "supervisor"].includes(data.role)) {
              const link = document.getElementById("admin-link");
              if (link) link.classList.remove("hidden");
            }
          });

        // 1099 disclaimer (compliance mode only, non-blocking)
        client.from("tt_employee_settings")
          .select("employment_type")
          .eq("user_name", auth.name)
          .maybeSingle()
          .then(({ data }) => {
            if (data?.employment_type) showContractorDisclaimer(data.employment_type);
          });
      } else if (retryCount < 2) {
        // Session refresh may fail on cold start — retry after delay
        console.warn(`Auth session null, retrying (${retryCount + 1}/2)...`);
        setTimeout(() => initAuth(retryCount + 1), 3000);
      }
    }
  } else if (store.userName && retryCount < 2) {
    // Had a saved user but auth failed — likely session refresh issue, retry
    console.warn(`Auth check failed for ${store.userName}, retrying (${retryCount + 1}/2)...`);
    setTimeout(() => initAuth(retryCount + 1), 3000);
    return;
  } else if (!isAuthenticated && location.hostname.endsWith("mpoctools.com")) {
    // No session AND retries exhausted (or no saved user) AND on production —
    // redirect to centralized Hub login. Splash screen stays visible during
    // the navigation (we deliberately don't call revealApp) to prevent a
    // flash of the underlying TT UI before the redirect completes.
    const returnTo = encodeURIComponent(location.href);
    location.replace(`https://mpoctools.com/login?return_to=${returnTo}`);
    return;
  }
  // Localhost / preview guest mode — reveal the app so dev can interact
  revealApp();
  checkInputState();
}

// --- Event Listeners ---
els.username.value = store.userName;
checkInputState();

// Ask the browser to make our storage persistent (exempt from eviction under
// storage pressure / Safari ITP). Best-effort and fire-and-forget — not every
// browser grants it, but where it does this directly prevents the silent
// clock-data loss that storage eviction would otherwise cause. Never blocks boot.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage
    .persist()
    .then((granted) =>
      console.info(`[storage] persistent storage ${granted ? "granted" : "denied"}`)
    )
    .catch(() => {});
}

// Start SSO check (non-blocking)
initAuth();
initComplianceUI();

// Sync resumes after auth (see initAuth). On reconnect — retry queue.
window.addEventListener("online", () => sync.processQueue());

// Offline-drafts (Phase 3 of EDIT-FLOW-V2) — feature-flagged. On every app
// load, expire 7+ day-old drafts (one toast per removed). Re-check on
// visibility/online so the banner stays current after the tab is foregrounded
// or the network returns. No-op when the flag is off.
refreshDrafts();
window.addEventListener("online", refreshDrafts);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshDrafts();
});

// If the queue has items but auth never completed (token getter still null),
// re-run initAuth on visibility/online. This rescues the case where user
// tapped Clock In before initAuth finished, then immediately backgrounded the
// app — without this, queue would be stuck until manual reload.
async function recoverStuckQueue() {
  if (sync.pendingCount > 0 && !sync._getToken && store.userName) {
    console.warn("[recovery] queue has items but no auth — retrying auth");
    await initAuth();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recoverStuckQueue();
});
window.addEventListener("online", recoverStuckQueue);

// --- Stale-queue banner ---
// Surfaces a visible amber banner when (a) auth is broken (refresh failed) or
// (b) queued items have been stuck for >1h. The small "N pending" chip inside
// History is too easy to miss; this banner guarantees the user sees something
// is wrong and can tap to retry.
function refreshStaleBanner() {
  if (!els.staleBanner) return;
  const authBroken = sync.isAuthBroken();
  const summary = sync.getStaleQueueSummary();
  const text = formatStaleBannerText(summary, authBroken, sync.failedCount);
  if (!text) {
    els.staleBanner.classList.add("hidden");
    return;
  }
  els.staleBannerTitle.textContent = text.title;
  els.staleBannerDetail.textContent = text.detail;
  els.staleBanner.classList.remove("hidden");
}

if (els.staleBanner) {
  els.staleBanner.addEventListener("click", async () => {
    if (sync.isAuthBroken()) {
      // Auth-broken path: try a refresh; on success reload to re-init everything,
      // on failure on production sync will redirect, on localhost just toast.
      try {
        const { getSupabaseClient } = await import("./auth.js");
        const client = getSupabaseClient();
        if (client) {
          const { data, error } = await client.auth.refreshSession();
          if (!error && data?.session) {
            showToast("Sign-in restored — reloading...");
            setTimeout(() => location.reload(), 600);
            return;
          }
        }
        if (location.hostname.endsWith("mpoctools.com")) {
          const returnTo = encodeURIComponent(location.href);
          location.replace(`https://mpoctools.com/login?return_to=${returnTo}`);
        } else {
          showToast("Sign-in expired — please reload");
        }
      } catch (e) {
        console.error("[stale-banner] refresh failed:", e);
        showToast("Sign-in expired — please reload");
      }
      return;
    }
    // Stale-queue path: trigger a retry and let refreshStaleBanner re-evaluate.
    showToast("Retrying sync...");
    await sync.processQueue();
    refreshStaleBanner();
  });
}

// Poll periodically so the banner appears even without user interaction
// (e.g. PWA left open overnight).
setInterval(refreshStaleBanner, 60_000);
// And re-evaluate on the same lifecycle events that drive the queue itself.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStaleBanner();
});
window.addEventListener("online", refreshStaleBanner);
// Initial paint
refreshStaleBanner();

els.autoShareToggle.checked = store.autoShare;
els.autoShareToggle.addEventListener("change", (e) => {
  store.saveAutoShare(e.target.checked);
});

els.geoToggle.checked = store.geoEnabled;
els.geoToggle.addEventListener("change", async (e) => {
  if (e.target.checked) {
    const consented = await requireGpsConsent();
    if (!consented) {
      e.target.checked = false;
      return;
    }
    store.saveGeoEnabled(true);
    requestLocation();
  } else {
    store.saveGeoEnabled(false);
    lastCoords = null;
  }
});

els.username.addEventListener("input", checkInputState);
els.username.addEventListener("change", async (e) => {
  if (isAuthenticated) {
    // Revert — authenticated users can't change name
    els.username.value = store.userName;
    return;
  }
  const newName = e.target.value.trim();
  const oldName = store.userName;

  if (oldName && newName && oldName !== newName) {
    const confirmed = await showDialog(`Change name to "${newName}"?`, false);
    if (confirmed) {
      store.saveUser(newName);
    } else {
      els.username.value = oldName;
    }
  } else {
    store.saveUser(newName);
  }
  checkInputState();
});

els.mainBtn.addEventListener("click", () => {
  if (!validateUser()) return;
  const now = Date.now();
  if (now - lastClickTime < 2000) return;
  lastClickTime = now;
  openActionSheet();
});

document.getElementById("history-btn").addEventListener("click", openHistory);
document.getElementById("close-history").addEventListener("click", closeHistory);

window.addEventListener("popstate", (event) => {
  if (event.state && event.state.modal === "history") {
    els.historyView.classList.remove("hidden");
  } else {
    els.historyView.classList.add("hidden");
  }
});

document.getElementById("msg-preview").addEventListener("click", () => {
  copyToClipboard(els.previewText.innerText);
});

els.quoteBox.addEventListener("click", hideQuote);

els.periodSelect.addEventListener("change", handlePeriodChange);
els.dateStart.addEventListener("change", () => {
  renderReport();
  renderHistoryList();
});
els.dateEnd.addEventListener("change", () => {
  renderReport();
  renderHistoryList();
});

els.restoreInput.addEventListener("change", importData);

// --- Check for Updates ---
document.getElementById("check-update-btn").addEventListener("click", async () => {
  const btn = document.getElementById("check-update-btn");
  btn.textContent = "Checking...";
  btn.disabled = true;
  try {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.unregister();
    }
    showToast("Updating...");
    location.reload();
  } catch (e) {
    // Fallback: just reload
    location.reload();
  }
});

// --- Send Diagnostics ---
// One-tap device/sync report → /api/diag (unauthenticated, so it arrives even
// when the user's session is broken). Falls back to clipboard + share only if
// even that POST can't get out (truly offline).
document.getElementById("diag-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("diag-btn");
  const original = btn.textContent;
  btn.textContent = "Sending…";
  btn.disabled = true;
  try {
    const { runDiagnostics } = await import("./diagnostics.js");
    const { delivered, report, text } = await runDiagnostics();
    if (delivered) {
      const skew = report.connectivity?.clockSkewSec;
      const skewNote =
        typeof skew === "number" && Math.abs(skew) > 120 ? ` (clock off ${skew}s)` : "";
      showToast(`Diagnostics sent ✓${skewNote}`);
    } else {
      // Couldn't reach the server — hand the report to the user to send manually.
      copyToClipboard(text);
      showToast("Couldn't send — report copied, please paste to your supervisor");
      if (navigator.share) shareText(text);
    }
  } catch (e) {
    console.error("[diag] failed:", e);
    showToast("Diagnostics failed — please try again");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

// --- New-version indicator ---
// When a fresh service worker is installed and waiting, surface it on the UI so the
// user (who may keep the PWA open for days) knows to tap the existing Update button.
// Amber dot on the History pill, banner inside the modal, pulse on the Update button.
import("./updateChecker.js").then(({ watchForUpdates }) => {
  watchForUpdates(() => {
    document.getElementById("history-update-dot")?.classList.remove("hidden");
    document.getElementById("update-banner")?.classList.remove("hidden");
    document.getElementById("check-update-btn")?.classList.add("update-available");
  });
});

// Expose for inline onclick handlers in HTML
window.app = { addSpecialDay, copyReport, exportData, triggerRestore };

// --- Resume state ---
if (store.status === "in") {
  startTimerLoop(() => store.findShift(store.currentShiftId));
  showQuote();
} else {
  initTimer(els);
  // Reset ring to 0
  els.ringBlue.style.strokeDashoffset = 691;
  els.ringPink.style.strokeDashoffset = 691;
}
renderUI();
