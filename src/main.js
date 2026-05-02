import "../style.css";
import { QUOTES } from "./constants.js";
import { store } from "./store.js";
import { sync } from "./sync.js";
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
  restoreInput: document.getElementById("restore-file"),
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
function openActionSheet() {
  const now = new Date();
  const timeStr = formatTime(now);

  if (store.status === "out") {
    els.sheetTitle.innerText = "Start Shift?";
    els.sheetDesc.innerText = `Time: ${timeStr}`;
    els.sheetConfirm.innerText = "CLOCK IN";
    els.sheetConfirm.className = "btn-main";
    els.sheetConfirm.onclick = () => performClockAction("in");
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
  closeActionSheet();
  // Block background state-sync while we're mid-action (avoid race with cross-browser reconcile)
  markClockActionStart();
  // Show immediate feedback while GPS resolves
  els.mainBtn.classList.add("pending");
  els.mainBtn.innerText = action === "in" ? "STARTING..." : "ENDING...";
  els.mainBtn.disabled = true;
  // Wait for GPS if enabled (max 5s timeout built into requestLocation)
  if (store.geoEnabled) await requestLocation();
  const now = new Date();
  const timeStr = formatTime(now);
  let msg = "";
  let syncItemId = null;

  if (action === "in") {
    const newShift = {
      id: Date.now(),
      dateObj: now.toISOString(),
      type: "work",
      in: now.getTime(),
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
      timestamp: now.toISOString(),
      localTime: timeStr,
      ...getMetaFields(),
    });
    syncItemId = newShift.id;
  } else {
    const shift = store.findShift(store.currentShiftId);
    if (shift) {
      shift.out = now.getTime();
      shift.duration = Math.floor((shift.out - shift.in) / 60000);

      const outId = `${shift.id}_out`;
      sync.schedule(outId, {
        name: store.userName,
        action: "Clock Out",
        id: shift.id,
        timestamp: now.toISOString(),
        localTime: timeStr,
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

  // Wait briefly for the first POST attempt to hit the server before opening
  // the share dialog. This gives the user visible certainty: by the time
  // WhatsApp opens, the data is on the server (or at least we tried with full
  // foreground attention). Up to 3 seconds — typically completes in <500ms.
  // If it times out, queue continues to retry in background; we proceed anyway
  // so the user isn't stuck.
  if (syncItemId !== null) {
    els.mainBtn.innerText = "SAVING...";
    await sync.awaitItem(syncItemId, 3000);
  }

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

async function initAuth(retryCount = 0) {
  const auth = await checkAuth();
  if (auth) {
    isAuthenticated = true;
    store.saveUser(auth.name);
    els.username.value = auth.name;
    els.username.readOnly = true;
    els.username.classList.add("locked");

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
  }
  checkInputState();
}

// --- Event Listeners ---
els.username.value = store.userName;
checkInputState();

// Start SSO check (non-blocking)
initAuth();
initComplianceUI();

// Sync resumes after auth (see initAuth). On reconnect — retry queue.
window.addEventListener("online", () => sync.processQueue());

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
