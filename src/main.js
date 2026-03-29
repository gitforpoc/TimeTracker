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
  if (!store.geoEnabled || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    },
    () => { lastCoords = null; },
    { timeout: 5000, maximumAge: 60000 }
  );
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
function performClockAction(action) {
  closeActionSheet();
  const now = new Date();
  const timeStr = formatTime(now);
  let msg = "";

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
  } else {
    const shift = store.findShift(store.currentShiftId);
    if (shift) {
      shift.out = now.getTime();
      shift.duration = Math.floor((shift.out - shift.in) / 60000);

      sync.schedule(shift.id + "_out", {
        name: store.userName,
        action: "Clock Out",
        id: shift.id,
        timestamp: now.toISOString(),
        localTime: timeStr,
        ...getMetaFields(),
      });
    }

    store.status = "out";
    store.currentShiftId = null;
    store.save();
    stopTimerLoop();
    hideQuote();

    msg = `${timeStr} ${store.userName} - clock out`;
  }

  renderUI();
  copyToClipboard(msg);
  els.previewText.innerText = msg;
  incrementBadge();

  if (store.autoShare) shareText(msg);
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

  if (store.autoShare) shareText(msg);

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

async function initAuth() {
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
        setAuthState(true, session.access_token);

        // Enable sync for authenticated users — fresh token on each call
        sync.setTokenGetter(async () => {
          const { data: { session: s } } = await client.auth.getSession();
          return s?.access_token || null;
        });
        sync.processQueue();
      }
    }
  }
  checkInputState();
}

// --- Event Listeners ---
els.username.value = store.userName;
checkInputState();

// Start SSO check (non-blocking)
initAuth();

// Sync resumes after auth (see initAuth). On reconnect — retry queue.
window.addEventListener("online", () => sync.processQueue());

els.autoShareToggle.checked = store.autoShare;
els.autoShareToggle.addEventListener("change", (e) => {
  store.saveAutoShare(e.target.checked);
});

els.geoToggle.checked = store.geoEnabled;
els.geoToggle.addEventListener("change", (e) => {
  store.saveGeoEnabled(e.target.checked);
  if (e.target.checked) requestLocation();
  else lastCoords = null;
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
