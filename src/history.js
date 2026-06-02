import { store } from "./store.js";
import { sync } from "./sync.js";
import { showDialog } from "./dialogs.js";
import { formatTime, formatDate, minsToHm, copyToClipboard, showToast, escapeHtml } from "./utils.js";
import { getSupabaseClient } from "./auth.js";
import { getPeriodList } from "./payPeriods.js";
import { OFFLINE_DRAFTS_ENABLED, EDIT_DRAFT_TTL_DAYS } from "./constants.js";
import {
  loadDrafts,
  saveDraft,
  removeDraft,
  expireOldDrafts,
  daysOldOf,
  evaluateDraftApplicability,
} from "./editDrafts.js";

let els = null;
let currentReportText = "";
let isUserAuthenticated = false;
let authToken = null;
let authUserId = null;

// Constants must precede `loadEditedFields()` because that function uses
// EDITABLE_FIELDS_CLOSED when migrating from the legacy localStorage key.
const EDITABLE_FIELDS_CLOSED = ["clock_in", "clock_out", "type", "comment"];
const EDITABLE_FIELDS_OPEN = ["clock_in", "type", "comment"]; // open shifts: no clock_out

// Reason prefix used by /api/submit when the user backdated at clock-in/out.
// Those rows are initial-entry annotations, NOT corrections — they must not
// consume the employee's edit quota or surface as "Adjusted" by another party.
// Used by classifyEdits/buildEditedFieldsMap/formatEditHistoryRow.
const BACKDATE_REASON_PREFIX = "Backdated at";

// Per-field 1× edit limit. Outer key = shift ID (as string), inner Set = field
// names ("clock_in", "clock_out", "type", "comment") already consumed by the
// CURRENT user. Persisted to localStorage as { "<shift_id>": [field, ...], ... }.
// Migration from the legacy per-shift `tt_edited_shifts` is handled below.
let editedFieldsByShift = loadEditedFields();

// Server data cache for SSO users
let serverShifts = null; // array of normalized shift objects
let serverEdits = null; // array of raw tt_edits rows for the user's shifts (used by 📝 expander)
let adjustedShiftIds = new Set(); // shifts edited by someone other than current user

/**
 * Load per-field edit limit map from localStorage. Performs a one-time
 * migration from the legacy `tt_edited_shifts` key (per-shift) into the new
 * `tt_edited_fields` (per-field). The migration is conservative: every shift
 * present in the old key has ALL four fields marked consumed, so users do not
 * get surprise extra edits on shifts they already touched.
 *
 * @returns {Map<string, Set<string>>}
 */
function loadEditedFields() {
  const map = new Map();
  const newRaw = localStorage.getItem("tt_edited_fields");
  const oldRaw = localStorage.getItem("tt_edited_shifts");

  if (newRaw) {
    try {
      const obj = JSON.parse(newRaw) || {};
      for (const [shiftId, fields] of Object.entries(obj)) {
        if (Array.isArray(fields)) map.set(String(shiftId), new Set(fields));
      }
    } catch {
      // Malformed key — start fresh, fall through to migration if old key still around.
    }
    // If both keys exist, prefer new and drop old to avoid stale data resurrecting.
    if (oldRaw) localStorage.removeItem("tt_edited_shifts");
    return map;
  }

  if (oldRaw) {
    try {
      const ids = JSON.parse(oldRaw) || [];
      if (Array.isArray(ids)) {
        for (const id of ids) {
          map.set(String(id), new Set(EDITABLE_FIELDS_CLOSED));
        }
      }
    } catch {
      // Malformed legacy key — ignore, start fresh.
    }
    localStorage.removeItem("tt_edited_shifts");
    // Persist the migrated structure immediately so we don't migrate twice.
    persistEditedFields(map);
  }
  return map;
}

function persistEditedFields(map) {
  const obj = {};
  for (const [shiftId, set] of map) {
    obj[shiftId] = [...set];
  }
  localStorage.setItem("tt_edited_fields", JSON.stringify(obj));
}

/**
 * Pure helper exposed for tests: build a per-shift, per-field consumed-set
 * from a list of tt_edits rows owned by the current user. Mirrors the
 * `editedByMe` branch of `classifyEdits` but at field granularity. Backdate
 * annotations are skipped (same rule).
 *
 * @param {Array<{shift_id: any, edited_by: any, field_changed?: string|null, reason?: string|null}>} edits
 * @param {string|null} currentUserId
 * @returns {Map<string, Set<string>>}
 */
export function buildEditedFieldsMap(edits, currentUserId) {
  const out = new Map();
  if (!Array.isArray(edits)) return out;
  for (const e of edits) {
    if (!e) continue;
    if (e.edited_by !== currentUserId) continue;
    if (typeof e.reason === "string" && e.reason.startsWith(BACKDATE_REASON_PREFIX)) continue;
    if (!e.field_changed) continue;
    const key = String(e.shift_id);
    let set = out.get(key);
    if (!set) {
      set = new Set();
      out.set(key, set);
    }
    set.add(e.field_changed);
  }
  return out;
}

/**
 * Pure helper exposed for tests: compute the "stale" decision for the edit
 * form. snapshot = the latest tt_edits.created_at observed when the form was
 * opened (ISO string or null). current = freshly fetched latest
 * tt_edits.created_at right before save. Returns true when the shift was
 * touched between open and save (i.e. current > snapshot).
 *
 * @param {string|null|undefined} snapshot
 * @param {string|null|undefined} current
 * @returns {boolean}
 */
export function isShiftStale(snapshot, current) {
  if (!current) return false; // server has no edits → never stale
  if (!snapshot) return true; // first edit ever appeared while form was open
  const s = Date.parse(snapshot);
  const c = Date.parse(current);
  if (isNaN(s) || isNaN(c)) return false; // defensive: unparseable → don't block
  return c > s;
}

/**
 * Pure helper exposed for tests: render an inline 📝-expander row from a
 * tt_edits row. Backdate annotations get a natural-language treatment
 * ("Originally tapped at HH:MM:SS, recorded as HH:MM (Backdated)"); other rows
 * get the standard "old → new (field), <editor> at HH:MM, reason" form.
 *
 * @param {{shift_id: any, field_changed?: string|null, old_value?: string|null, new_value?: string|null, edited_by_name?: string|null, reason?: string|null, created_at?: string|null}} edit
 * @returns {string}
 */
export function formatEditHistoryRow(edit) {
  if (!edit) return "";
  const isBackdate =
    typeof edit.reason === "string" && edit.reason.startsWith(BACKDATE_REASON_PREFIX);
  const editor = edit.edited_by_name || "Unknown";
  const when = formatHmsLocal(edit.created_at);
  const field = edit.field_changed || "";

  if (isBackdate) {
    // `old_value` is the actual tap time, `new_value` is the backdated time
    // stored on the shift. Re-read as natural language.
    const tapped = formatHmsLocal(edit.old_value);
    const recorded = formatHmLocal(edit.new_value);
    return `Originally tapped at ${tapped}, recorded as ${recorded} (Backdated)`;
  }

  const isTime = field === "clock_in" || field === "clock_out";
  const oldDisp = isTime ? formatHmsLocal(edit.old_value) : (edit.old_value || "—");
  const newDisp = isTime ? formatHmsLocal(edit.new_value) : (edit.new_value || "—");
  const reasonPart = edit.reason ? `, "${edit.reason}"` : "";
  return `${oldDisp} → ${newDisp} (${field}), ${editor} at ${when}${reasonPart}`;
}

function formatHmsLocal(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatHmLocal(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Pay period configuration for this user (fetched once after auth)
let userPayPeriodType = "semi_monthly"; // default — matches all 22 employees as of migration
let periodMap = new Map(); // value-string → { start: Date, end: Date, label: string }

const EDIT_REASONS = [
  "Forgot to clock out",
  "Forgot to clock in",
  "Wrong time recorded",
  "Phone/app issue",
];

/**
 * Pure: classify tt_edits rows into "edited by current user" and "adjusted by
 * someone else" sets, ignoring backdate annotations. Also returns a per-field
 * map of which fields the current user has consumed on each shift.
 *
 * @param {Array<{shift_id: any, edited_by: any, field_changed?: string|null, reason?: string|null}>} edits
 * @param {string|null} currentUserId
 * @returns {{ editedByMe: Set<any>, adjustedByOthers: Set<any>, fieldsByShift: Map<string, Set<string>> }}
 */
export function classifyEdits(edits, currentUserId) {
  const editedByMe = new Set();
  const adjustedByOthers = new Set();
  const fieldsByShift = new Map();
  if (!Array.isArray(edits)) return { editedByMe, adjustedByOthers, fieldsByShift };

  for (const e of edits) {
    if (!e) continue;
    const isBackdate =
      typeof e.reason === "string" && e.reason.startsWith(BACKDATE_REASON_PREFIX);
    if (isBackdate) continue; // initial-entry annotation, ignore for quota/lockout
    if (e.edited_by === currentUserId) {
      editedByMe.add(e.shift_id);
      if (e.field_changed) {
        const key = String(e.shift_id);
        let set = fieldsByShift.get(key);
        if (!set) {
          set = new Set();
          fieldsByShift.set(key, set);
        }
        set.add(e.field_changed);
      }
    } else {
      adjustedByOthers.add(e.shift_id);
    }
  }
  return { editedByMe, adjustedByOthers, fieldsByShift };
}

function getConsumedFields(shiftId) {
  const set = editedFieldsByShift.get(String(shiftId));
  return set || new Set();
}

function hasUnconsumedField(shiftId, fields) {
  const consumed = getConsumedFields(shiftId);
  return fields.some((f) => !consumed.has(f));
}

function markFieldConsumed(shiftId, field) {
  const key = String(shiftId);
  let set = editedFieldsByShift.get(key);
  if (!set) {
    set = new Set();
    editedFieldsByShift.set(key, set);
  }
  set.add(field);
}

export function initHistory(elements) {
  els = elements;
}

export function setAuthState(authenticated, token, userId) {
  isUserAuthenticated = authenticated;
  authToken = token;
  authUserId = userId || null;
}

// Fetch this user's pay_period_type from tt_employee_settings.
// Defaults to "semi_monthly" if not set or unauthenticated. Cached for session.
async function fetchPayPeriodType() {
  if (!isUserAuthenticated || !store.userName) return;
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("tt_employee_settings")
      .select("pay_period_type")
      .eq("user_name", store.userName)
      .maybeSingle();
    if (data?.pay_period_type) userPayPeriodType = data.pay_period_type;
  } catch {
    // Network error — keep default
  }
}

export async function openHistory() {
  resetBadge();
  await fetchPayPeriodType();
  populatePeriods();

  // Auto-select the current period (first option, since periods are listed newest-first)
  if (els.periodSelect.options.length > 0) {
    els.periodSelect.value = els.periodSelect.options[0].value;
  }

  els.historyView.classList.remove("hidden");
  window.history.pushState({ modal: "history" }, "History", "#history");

  // SSO users: flush sync queue, then fetch fresh data from server
  if (isUserAuthenticated) {
    renderHistoryList(); // show local data first while loading
    renderReport();
    const list = document.getElementById("history-list");
    const syncNote = document.createElement("div");
    syncNote.className = "sync-loading";
    syncNote.textContent = "Syncing with server...";
    list.prepend(syncNote);
    await sync.processQueue(); // flush pending items first
    await fetchServerData();
    syncNote.remove();
  }

  renderHistoryList();
  renderReport();
}

export function closeHistory() {
  els.historyView.classList.add("hidden");
  if (window.history.state && window.history.state.modal === "history") {
    window.history.back();
  }
}

export function handlePeriodChange() {
  if (els.periodSelect.value === "custom") {
    els.customRangeBox.classList.remove("hidden");
  } else {
    els.customRangeBox.classList.add("hidden");
  }
  renderReport();
  renderHistoryList();
}

// --- Badge ---
export function incrementBadge() {
  store.unreadLogs++;
  updateBadgeUI();
}

function resetBadge() {
  store.unreadLogs = 0;
  updateBadgeUI();
}

function updateBadgeUI() {
  if (store.unreadLogs > 0) {
    els.badge.innerText = store.unreadLogs > 9 ? "9+" : store.unreadLogs;
    els.badge.classList.remove("hidden");
  } else {
    els.badge.classList.add("hidden");
  }
}

// --- Server Data (SSO users) ---
async function fetchServerData() {
  if (!isUserAuthenticated) return;

  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    // Fetch all shifts for this user (RLS filters by user_name)
    const { data: shifts, error } = await supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, duration_minutes, type, comment")
      .eq("user_name", store.userName)
      .order("clock_in", { ascending: false })
      .limit(500);

    if (error || !shifts) return;

    // Fetch edits to detect supervisor adjustments AND power the inline 📝
    // expander on each card. We need all of field_changed/old_value/new_value/
    // edited_by_name/created_at to render the history list (mirrors admin
    // editModal.js shape). reason is already needed for backdate filtering.
    const shiftIds = shifts.map((s) => s.id);
    let editsData = [];
    if (shiftIds.length > 0) {
      const { data: edits } = await supabase
        .from("tt_edits")
        .select("shift_id, edited_by, edited_by_name, field_changed, old_value, new_value, reason, created_at")
        .in("shift_id", shiftIds)
        .order("created_at", { ascending: true });
      editsData = edits || [];
    }
    serverEdits = editsData;

    // Reconcile editedFieldsByShift + adjustedShiftIds from the freshly
    // fetched edits. Backdate annotations ("Backdated at clock-in/clock-out")
    // are initial-entry markers, NOT corrections — they must not consume the
    // employee's edit quota or trigger the "Adjusted" badge.
    const { adjustedByOthers, fieldsByShift } = classifyEdits(editsData, authUserId);
    adjustedShiftIds = adjustedByOthers;
    // Merge server-derived consumed-fields into the local map. Server is the
    // authoritative source, but we keep any local-only optimistic entries
    // (added right after a successful edit before the next fetch).
    for (const [shiftId, fields] of fieldsByShift) {
      let set = editedFieldsByShift.get(shiftId);
      if (!set) {
        set = new Set();
        editedFieldsByShift.set(shiftId, set);
      }
      fields.forEach((f) => set.add(f));
    }
    persistEditedFields(editedFieldsByShift);

    // Normalize to same shape as localStorage items
    serverShifts = shifts.map((s) => {
      const inTime = s.clock_in ? new Date(s.clock_in).getTime() : null;
      const outTime = s.clock_out ? new Date(s.clock_out).getTime() : null;
      const typeMap = { work: "work", day_off: "Day Off", paid_off: "Paid Off" };
      return {
        id: s.id, // server ID (used for edit-shift API)
        serverId: s.id,
        dateObj: s.clock_in || s.clock_out,
        type: typeMap[s.type] || s.type,
        in: inTime,
        out: outTime,
        duration: s.duration_minutes || 0,
        comment: s.comment || null,
      };
    });
  } catch (err) {
    console.error("Failed to fetch server data:", err);
    serverShifts = null;
  }
}

function useServerData() {
  return isUserAuthenticated && serverShifts !== null;
}

/** Get local entries missing from server data */
function getUnsyncedLocalEntries() {
  if (!serverShifts) return [];

  // Collect server clock_in timestamps for dedup matching
  const serverTimes = new Set(
    serverShifts.map((s) => s.in).filter(Boolean)
  );

  return store.data
    .filter((item) => {
      if (!item.in) return false;
      // Skip deleted entries
      if (item.comment && item.comment.startsWith("[DELETED]")) return false;
      // Entry is unsynced if no server shift matches its clock-in time (±2min)
      return !serverTimes.has(item.in) &&
        ![...serverTimes].some((t) => Math.abs(t - item.in) < 120000);
    })
    .map((item) => ({ ...item, _unsynced: true }));
}

// --- Reports ---
function getReportItems() {
  const val = els.periodSelect.value;
  if (!val) return [];

  let startDate, endDate;

  if (val === "custom") {
    if (!els.dateStart.value || !els.dateEnd.value) return [];
    const [sY, sM, sD] = els.dateStart.value.split("-").map(Number);
    const [eY, eM, eD] = els.dateEnd.value.split("-").map(Number);
    startDate = new Date(sY, sM - 1, sD);
    endDate = new Date(eY, eM - 1, eD);
    endDate.setHours(23, 59, 59, 999);
  } else {
    const cached = periodMap.get(val);
    if (!cached) return [];
    startDate = cached.start;
    endDate = cached.end;
  }

  let source;
  if (useServerData()) {
    // Merge server data with any local entries not yet synced
    const unsynced = getUnsyncedLocalEntries();
    source = [...serverShifts, ...unsynced];
  } else {
    source = store.data;
  }

  return source
    .filter((i) => {
      const d = new Date(i.dateObj);
      return d >= startDate && d <= endDate;
    })
    .sort((a, b) => new Date(a.dateObj) - new Date(b.dateObj));
}

export function renderReport() {
  const items = getReportItems();
  let total = 0;
  let text = `Timesheet: ${store.userName}\n`;

  if (els.periodSelect.value === "custom") {
    text += `Period: ${els.dateStart.value} to ${els.dateEnd.value}\n`;
  } else {
    text += `Period: ${els.periodSelect.options[els.periodSelect.selectedIndex].text}\n`;
  }
  text += `----------------\n`;

  items.forEach((i) => {
    const dStr = formatDate(new Date(i.dateObj));
    if (i.type === "work" && i.out) {
      total += i.duration;
      text += `${dStr} ${formatTime(new Date(i.in))} - ${formatTime(new Date(i.out))} (${minsToHm(i.duration)})\n`;
    } else if (i.type.includes("Off")) {
      total += i.duration;
      text += `${dStr} ${i.type} (${minsToHm(i.duration)})\n`;
    }
  });

  const totalString = minsToHm(total);
  document.getElementById("total-hours").innerText = totalString;
  text += `----------------\nTotal: ${totalString}`;
  currentReportText = text;
}

export function renderHistoryList() {
  const list = document.getElementById("history-list");
  list.innerHTML = "";

  renderDraftsBanner();

  const items = getReportItems().reverse();

  if (items.length === 0) {
    list.innerHTML = `<div style="text-align:center; color:var(--gray); padding:20px; font-size:14px;">No records for this period</div>`;
    return;
  }

  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-card";

    if (item.type === "Paid Off") div.classList.add("paid-off");
    if (item.duration > 720) div.classList.add("long-shift");

    const isOpenShift = item.type === "work" && !item.out;
    let desc =
      item.type === "work"
        ? `${formatTime(new Date(item.in))} - ${item.out ? formatTime(new Date(item.out)) : "Active"}`
        : item.type;

    if (item.duration > 0) desc += ` (${minsToHm(item.duration)})`;

    // Keep the "live shift" cue visible regardless of EDIT button state — open
    // shifts now also show the EDIT button so the employee can fix a forgotten
    // Clock In mid-shift.
    const inProgressHtml = isOpenShift
      ? `<span class="edited-badge in-progress-badge">⏳ In progress</span>`
      : "";

    const commentHtml = item.comment
      ? `<div class="comment-box">💬 ${escapeHtml(item.comment)}</div>`
      : "";

    const isFromServer = useServerData();
    const editableFields = isOpenShift ? EDITABLE_FIELDS_OPEN : EDITABLE_FIELDS_CLOSED;
    const hasFreeField = hasUnconsumedField(item.id, editableFields);
    const alreadyEdited = !hasFreeField;
    const isAdjusted = isFromServer && adjustedShiftIds.has(item.id);

    let editHtml = "";
    let canClickEdit = false;
    if (item._unsynced) {
      editHtml = sync.pendingCount > 0
        ? `<span class="sync-pending-badge">⏳ Syncing...</span>`
        : "";
    } else if (isUserAuthenticated) {
      if (isAdjusted) {
        editHtml = `<span class="adjusted-badge">Adjusted</span>`;
      } else if (alreadyEdited) {
        editHtml = `<span class="edited-badge">✏️ Edited</span>`;
      } else {
        editHtml = `<button class="edit-btn" data-id="${item.id}">EDIT</button>`;
        canClickEdit = true;
      }
    }

    // Inline 📝 edit-history expander — show if this shift has any visible
    // tt_edits rows (incl. backdate annotations, which give useful context).
    const shiftEdits = getEditsForShift(item.id);
    const historyToggleHtml = shiftEdits.length > 0
      ? `<button class="history-toggle-btn" data-id="${item.id}" title="Show edit history">📝 history</button>`
      : "";

    div.innerHTML = `
      <div class="card-header">
        <span class="item-date">${formatDate(new Date(item.dateObj))}</span>
        <span class="item-time">${desc}</span>
      </div>
      ${commentHtml}
      <div class="card-actions">
        ${inProgressHtml}
        ${editHtml}
        ${historyToggleHtml}
        ${!isFromServer && !item._unsynced ? `<button class="comment-btn" data-id="${item.id}">💬</button>` : ""}
        ${!isFromServer || item._unsynced ? `<button class="del-btn" data-id="${item.id}">DELETE</button>` : ""}
      </div>
      ${shiftEdits.length > 0 ? `<div class="history-edits hidden" data-id="${item.id}">${renderEditHistoryHtml(shiftEdits)}</div>` : ""}
    `;

    // Event delegation
    if (canClickEdit) {
      const editBtn = div.querySelector(".edit-btn");
      if (editBtn) editBtn.addEventListener("click", () => editShift(item));
    }
    if (shiftEdits.length > 0) {
      const toggle = div.querySelector(".history-toggle-btn");
      const panel = div.querySelector(".history-edits");
      if (toggle && panel) {
        toggle.addEventListener("click", () => panel.classList.toggle("hidden"));
      }
    }
    if (!isFromServer && !item._unsynced) {
      div.querySelector(".comment-btn")?.addEventListener("click", () => addComment(item.id));
    }
    if (!isFromServer || item._unsynced) {
      div.querySelector(".del-btn")?.addEventListener("click", () => deleteItem(item.id));
    }

    list.appendChild(div);
  });
}

function getEditsForShift(shiftId) {
  if (!serverEdits || shiftId == null) return [];
  return serverEdits.filter((e) => e && e.shift_id === shiftId);
}

function renderEditHistoryHtml(edits) {
  return edits
    .map((e) => `<div class="history-edit-row">${escapeHtml(formatEditHistoryRow(e))}</div>`)
    .join("");
}

export function copyReport() {
  if (currentReportText) {
    copyToClipboard(currentReportText);
  } else {
    showToast("Report is empty or loading...");
  }
}

async function addComment(id) {
  const item = store.data.find((i) => i.id === id);
  if (!item) return;

  const text = await showDialog("Edit Comment:", "text", item.comment || "");
  if (text !== false) {
    item.comment = text;
    store.save();
    renderHistoryList();
    sync.schedule(Date.now(), {
      type: "comment",
      targetId: id,
      comment: text,
      name: store.userName,
    });
  }
}

async function deleteItem(id) {
  if (await showDialog("Delete entry?", false)) {
    const item = store.deleteEntry(id);

    if (String(store.currentShiftId) === String(id)) {
      store.status = "out";
      store.currentShiftId = null;
      store.save();
      // Update main UI — import dynamically to avoid circular dep
      import("./timer.js").then(({ stopTimerLoop }) => stopTimerLoop());
      const mainBtn = document.getElementById("main-action-btn");
      const statusLabel = document.getElementById("status-label");
      if (mainBtn) {
        mainBtn.innerText = "CLOCK IN";
        mainBtn.classList.remove("clock-out");
      }
      if (statusLabel) {
        statusLabel.innerText = "OFF DUTY";
        statusLabel.style.color = "var(--gray)";
      }
    }

    renderHistoryList();
    renderReport();

    if (item) {
      // Only sync [DELETED] if the entry exists on server (has a matching server shift)
      const isOnServer = serverShifts && serverShifts.some(
        (s) => s.in && item.in && Math.abs(s.in - item.in) < 120000
      );
      if (isOnServer) {
        const newComment = `[DELETED] ${item.comment || ""}`.trim();
        sync.schedule(Date.now(), {
          type: "comment",
          targetId: id,
          comment: newComment,
          name: store.userName,
        });
      }
    }
  }
}

export function exportData() {
  const a = document.createElement("a");
  a.href =
    "data:text/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(store.data));
  a.download = "timetracker_backup.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function triggerRestore() {
  els.restoreInput.click();
}

export async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const importedData = JSON.parse(text);
    if (!Array.isArray(importedData)) throw new Error("Invalid file format");

    let addedCount = 0;
    const existingIds = new Set(store.data.map((i) => i.id));

    importedData.forEach((item) => {
      if (item.id && !existingIds.has(item.id)) {
        store.data.push(item);
        existingIds.add(item.id);
        addedCount++;
      }
    });

    store.data.sort((a, b) => new Date(b.dateObj) - new Date(a.dateObj));
    store.save();
    renderHistoryList();
    renderReport();
    showToast(addedCount > 0 ? `Restored ${addedCount} entries` : "No new data found");
  } catch (e) {
    console.error(e);
    showToast("Error reading backup file");
  }
  event.target.value = "";
}

// --- Edit Shift ---

/**
 * After a successful /api/edit-shift call, mirror the change into store.data
 * so the History merge view (getUnsyncedLocalEntries) doesn't render a phantom
 * "unsynced" card. We match the local entry against the PRE-edit clock_in with
 * a generous ±20 min window — large enough to survive prior edits, small
 * enough to avoid grabbing an adjacent same-day shift in typical cases.
 *
 * Edge case: if two local shifts have clock_in within 20 min of each other
 * (very rare — would mean two clock-ins within 20 min), we update the closest
 * match. Worst case: we update the wrong twin and the other one still phantoms;
 * no data loss, just an extra card until next page refresh that re-fetches.
 */
function syncLocalCacheAfterEdit(oldInMs, changes) {
  if (!oldInMs) return;
  const WINDOW_MS = 20 * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;
  for (const entry of store.data) {
    if (!entry.in) continue;
    if (entry.comment && entry.comment.startsWith("[DELETED]")) continue;
    const diff = Math.abs(entry.in - oldInMs);
    if (diff < WINDOW_MS && diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }
  if (!best) return;

  if (changes.clock_in) {
    best.in = new Date(changes.clock_in).getTime();
  }
  if (changes.clock_out !== undefined) {
    best.out = changes.clock_out ? new Date(changes.clock_out).getTime() : null;
  }
  if (changes.clock_in || changes.clock_out !== undefined) {
    best.duration =
      best.in && best.out ? Math.floor((best.out - best.in) / 60000) : 0;
  }
  if (changes.type !== undefined) {
    best.type = changes.type;
  }
  if (changes.comment !== undefined) {
    best.comment = changes.comment;
  }
  store.save();
}

async function editShift(item) {
  let shift;
  const supabase = getSupabaseClient();

  if (item.serverId) {
    // Server data — we already have the shift info
    shift = {
      id: item.serverId,
      clock_in: item.in ? new Date(item.in).toISOString() : null,
      clock_out: item.out ? new Date(item.out).toISOString() : null,
      type: typeof item.type === "string" && item.type.toLowerCase().includes("off")
        ? (item.type === "Paid Off" ? "paid_off" : "day_off")
        : "work",
      comment: item.comment,
    };
  } else {
    // Local data — find server-side shift by date + user_name
    if (!supabase) {
      showToast("Not connected to server");
      return;
    }

    const itemDate = new Date(item.dateObj || item.in);
    const dayStart = new Date(itemDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(itemDate);
    dayEnd.setHours(23, 59, 59, 999);

    const { data: shifts } = await supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, duration_minutes, type, comment")
      .eq("user_name", store.userName)
      .gte("clock_in", dayStart.toISOString())
      .lte("clock_in", dayEnd.toISOString())
      .order("clock_in", { ascending: false });

    if (!shifts || shifts.length === 0) {
      showToast("Shift not found on server");
      return;
    }

    shift = shifts[0];
    if (shifts.length > 1 && item.in) {
      const target = item.in;
      shift = shifts.reduce((best, s) => {
        const diff = Math.abs(new Date(s.clock_in).getTime() - target);
        const bestDiff = Math.abs(new Date(best.clock_in).getTime() - target);
        return diff < bestDiff ? s : best;
      });
    }
  }

  // Stale-data snapshot: capture the latest tt_edits.created_at for this
  // shift at the moment the form opens. On save we'll re-fetch and abort if
  // it changed (someone else, likely supervisor, edited mid-form). Defense
  // in depth on top of the adjustedByOthers UI gate.
  const staleSnapshot = supabase ? await fetchLatestEditTimestamp(supabase, shift.id) : null;

  // Per-field gating: disable any field already consumed by the current user.
  const isOpen = !shift.clock_out;
  const consumed = getConsumedFields(item.serverId || item.id);
  const inLocked = consumed.has("clock_in");
  const outLocked = consumed.has("clock_out");
  const typeLocked = consumed.has("type");
  const commentLocked = consumed.has("comment");

  // Build edit dialog with dropdown reasons
  const inStr = shift.clock_in ? toLocalInput(shift.clock_in) : "";
  const outStr = shift.clock_out ? toLocalInput(shift.clock_out) : "";
  const reasonOptions = EDIT_REASONS.map((r) => `<option value="${r}">${r}</option>`).join("");
  const lockedNote = `<div class="edit-field-locked-note">🔒 already corrected</div>`;
  const openShiftNote = `<div class="edit-field-locked-note">Clock Out not set yet (still in progress)</div>`;
  const shiftType = shift.type || "work";
  const typeOptions = [
    { value: "work", label: "Work" },
    { value: "day_off", label: "Day Off" },
    { value: "paid_off", label: "Paid Off" },
  ]
    .map((o) => `<option value="${o.value}"${o.value === shiftType ? " selected" : ""}>${o.label}</option>`)
    .join("");

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px;text-align:left;">
      <label style="font-size:12px;color:var(--gray);">Clock In
        <input type="datetime-local" id="edit-in" value="${inStr}"${inLocked ? " disabled" : ""} style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
        ${inLocked ? lockedNote : ""}
      </label>
      ${isOpen
        ? `<label style="font-size:12px;color:var(--gray);">Clock Out
            <input type="datetime-local" id="edit-out" value="" disabled style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;opacity:0.5;">
            ${openShiftNote}
          </label>`
        : `<label style="font-size:12px;color:var(--gray);">Clock Out
            <input type="datetime-local" id="edit-out" value="${outStr}"${outLocked ? " disabled" : ""} style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
            ${outLocked ? lockedNote : ""}
          </label>`}
      <label style="font-size:12px;color:var(--gray);">Type
        <select id="edit-type"${typeLocked ? " disabled" : ""} style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
          ${typeOptions}
        </select>
        ${typeLocked ? lockedNote : ""}
      </label>
      <label style="font-size:12px;color:var(--gray);">Comment
        <input type="text" id="edit-cmt" value="${escapeHtml(shift.comment || "")}"${commentLocked ? " disabled" : ""} placeholder="Optional" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
        ${commentLocked ? lockedNote : ""}
      </label>
      <label style="font-size:12px;color:var(--gray);">Reason
        <select id="edit-reason" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
          ${reasonOptions}
          <option value="">Other...</option>
        </select>
        <input type="text" id="edit-reason-other" placeholder="Describe reason..." style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;display:none;">
      </label>
    </div>
  `;

  const result = await showDialog(html, "html");
  if (!result) return;

  const newIn = result["edit-in"];
  const newOut = result["edit-out"];
  const newType = result["edit-type"] || shiftType;
  const newComment = (result["edit-cmt"] || "").trim();
  const reasonSelect = result["edit-reason"] || "";
  const reasonOther = (result["edit-reason-other"] || "").trim();
  const reason = reasonSelect || reasonOther || "Employee self-edit";

  const changes = {};
  const oldInMs = shift.clock_in ? new Date(shift.clock_in).getTime() : 0;
  const oldOutMs = shift.clock_out ? new Date(shift.clock_out).getTime() : 0;
  const newInMs = newIn ? new Date(newIn).getTime() : 0;
  const newOutMs = newOut ? new Date(newOut).getTime() : 0;

  // Disabled fields cannot produce a change — skip them defensively even if
  // somebody bypasses the `disabled` attribute via devtools.
  if (!inLocked && newIn && newInMs !== oldInMs) {
    changes.clock_in = new Date(newIn).toISOString();
  }
  if (!isOpen && !outLocked && newOut && newOutMs !== oldOutMs) {
    changes.clock_out = new Date(newOut).toISOString();
  }
  if (!typeLocked && newType && newType !== shiftType) {
    changes.type = newType;
  }
  if (!commentLocked && newComment !== (shift.comment || "")) {
    changes.comment = newComment || null;
  }

  if (Object.keys(changes).length === 0) {
    showToast("No changes");
    return;
  }

  // Stale-data check: if the latest tt_edits.created_at for this shift moved
  // forward since the form opened, the shift was touched in the meantime.
  // Abort and force a reload so the user sees current state.
  if (supabase) {
    const currentLatest = await fetchLatestEditTimestamp(supabase, shift.id);
    if (isShiftStale(staleSnapshot, currentLatest)) {
      showToast("This shift was just updated by someone else. Reload and try again.");
      try {
        await fetchServerData();
      } catch {
        /* non-fatal: re-render below still helps */
      }
      renderHistoryList();
      renderReport();
      return;
    }
  }

  // Offline pre-check: if we're known-offline and drafts are enabled, save as
  // a draft instead of attempting the fetch (which would fail with a misleading
  // generic error after the browser timeout).
  if (OFFLINE_DRAFTS_ENABLED && typeof navigator !== "undefined" && navigator.onLine === false) {
    persistEditAsDraft(shift, changes, reason);
    return;
  }

  try {
    const res = await fetch("/api/edit-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ shiftId: shift.id, changes, reason }),
    });

    const apiResult = await res.json();
    if (!res.ok) {
      showToast(apiResult.error || "Error");
      return;
    }

    // Per-field 1× edit limit: mark each field actually present in `changes`
    // as consumed. Optimistic — the next fetchServerData() merge will confirm
    // the same set from authoritative tt_edits rows.
    const targetShiftId = String(item.serverId || item.id);
    for (const field of Object.keys(changes)) {
      markFieldConsumed(targetShiftId, field);
    }
    persistEditedFields(editedFieldsByShift);

    // Update local-cache mirror so getUnsyncedLocalEntries doesn't render a
    // phantom card. Match by pre-edit clock_in within a generous ±20 min window
    // (handles chained edits that may have already shifted the timestamp).
    syncLocalCacheAfterEdit(oldInMs, changes);

    // Refresh from server if using server data
    if (useServerData()) {
      await fetchServerData();
    } else {
      // Update local data on the item reference too (non-SSO render path)
      if (changes.clock_in) item.in = new Date(changes.clock_in).getTime();
      if (changes.clock_out !== undefined) {
        item.out = changes.clock_out ? new Date(changes.clock_out).getTime() : null;
      }
      if (item.in && item.out) {
        item.duration = Math.floor((item.out - item.in) / 60000);
      } else if (!item.out) {
        item.duration = 0;
      }
      if (changes.type !== undefined) item.type = changes.type;
      if (changes.comment !== undefined) item.comment = changes.comment;
      store.save();
    }

    showToast("Shift updated");
    renderHistoryList();
    renderReport();
  } catch (err) {
    // Network error (TypeError, AbortError, timeout). With the offline-drafts
    // flag on we persist the user's intent so they can confirm-on-reconnect
    // instead of silently losing the edit. With the flag off we preserve the
    // Step-2 behavior of a generic toast.
    if (OFFLINE_DRAFTS_ENABLED && isLikelyNetworkError(err)) {
      persistEditAsDraft(shift, changes, reason);
    } else {
      showToast("Network error");
    }
  }
}

// True for typical client-side fetch failures (no DNS, dropped wifi, captive
// portal, request aborted, timeout). False for unexpected programming errors
// so we don't silently mask them as "offline".
function isLikelyNetworkError(err) {
  if (!err) return true; // defensive — undefined err from non-Response throw
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err instanceof TypeError) return true; // fetch network failure
  return false;
}

function persistEditAsDraft(shift, changes, reason) {
  const draft = {
    shift_id: String(shift.id),
    snapshot: {
      clock_in: shift.clock_in || null,
      clock_out: shift.clock_out || null,
      type: shift.type || null,
      comment: shift.comment || null,
      latest_edit_at: null, // re-captured on Apply via fetchLatestEditTimestamp
    },
    proposed_changes: { ...changes },
    reason,
    created_at: new Date().toISOString(),
    user_name: store.userName || null,
  };
  saveDraft(draft);
  showToast("No internet. Saved as draft — confirm when back online.");
  renderHistoryList();
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

/**
 * Fetch the latest tt_edits.created_at for a given shift (or null if none).
 * Used as a lightweight version proxy for the stale-data check. `tt_shifts`
 * itself has no updated_at column, so the audit log is our cheapest source.
 *
 * @param {object} supabase
 * @param {number|string} shiftId
 * @returns {Promise<string|null>}
 */
export async function fetchLatestEditTimestamp(supabase, shiftId) {
  if (!supabase || shiftId == null) return null;
  try {
    const { data } = await supabase
      .from("tt_edits")
      .select("created_at")
      .eq("shift_id", shiftId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.created_at || null;
  } catch {
    return null;
  }
}

function populatePeriods() {
  const select = els.periodSelect;
  select.innerHTML = "";
  periodMap.clear();

  // Generate the 4 most recent periods of the user's pay period type (current + 3 prior)
  const periods = getPeriodList(userPayPeriodType, 4, new Date());

  for (const p of periods) {
    periodMap.set(p.value, { start: p.start, end: p.end, label: p.label });
    const opt = document.createElement("option");
    opt.value = p.value;
    opt.innerText = p.label;
    select.appendChild(opt);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "custom";
  customOpt.innerText = "⚙️ Custom Range...";
  select.appendChild(customOpt);
}

// ---------------------------------------------------------------------------
// Offline edit drafts UI (Phase 3) — entirely no-op when OFFLINE_DRAFTS_ENABLED
// is false. The banner DOM is only inserted when there are visible drafts AND
// the flag is on; the Review modal only opens via the banner button.
// ---------------------------------------------------------------------------

/**
 * Render (or hide) the drafts banner at the top of the History modal. Safe
 * to call when the History modal isn't visible — the banner element is
 * created/removed lazily next to #history-list.
 */
export function renderDraftsBanner() {
  if (!OFFLINE_DRAFTS_ENABLED) {
    // Flag off → guarantee no banner exists, no localStorage reads on hot path.
    const stale = document.getElementById("drafts-banner");
    if (stale) stale.remove();
    return;
  }

  const list = document.getElementById("history-list");
  if (!list) return;

  const drafts = loadDrafts();
  let banner = document.getElementById("drafts-banner");

  if (drafts.length === 0) {
    if (banner) banner.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "drafts-banner";
    banner.className = "drafts-banner";
    list.parentNode?.insertBefore(banner, list);
  }

  const now = Date.now();
  const soon = drafts
    .map((d) => ({ d, age: daysOldOf(d, now) }))
    .filter(({ age }) => age >= 5);
  const isSoon = soon.length > 0;
  let suffix = "";
  if (isSoon) {
    const minDaysLeft = Math.max(
      0,
      Math.ceil(EDIT_DRAFT_TTL_DAYS - Math.max(...soon.map((s) => s.age))),
    );
    suffix = ` (expires in ${minDaysLeft} day${minDaysLeft === 1 ? "" : "s"})`;
  }

  const word = drafts.length === 1 ? "pending edit" : "pending edits";
  banner.innerHTML = `
    <span class="drafts-banner-icon" aria-hidden="true">⏳</span>
    <span class="drafts-banner-text">${drafts.length} ${word}${escapeHtml(suffix)}</span>
    <button type="button" class="drafts-review-btn">Review ▸</button>
  `;
  banner.classList.toggle("pulse", isSoon);
  banner.querySelector(".drafts-review-btn")?.addEventListener("click", openDraftsReview);
}

/** Open the drafts Review modal with one row per draft. */
function openDraftsReview() {
  const modal = document.getElementById("drafts-review-modal");
  if (!modal) return;
  renderDraftsReviewBody();
  modal.classList.remove("hidden");
  const closeBtn = document.getElementById("drafts-review-close");
  if (closeBtn) closeBtn.onclick = closeDraftsReview;
}

function closeDraftsReview() {
  const modal = document.getElementById("drafts-review-modal");
  if (modal) modal.classList.add("hidden");
}

function renderDraftsReviewBody() {
  const body = document.getElementById("drafts-review-body");
  if (!body) return;

  const drafts = loadDrafts();
  if (drafts.length === 0) {
    body.innerHTML = `<div class="drafts-empty">No pending edits.</div>`;
    closeDraftsReview();
    return;
  }

  const now = Date.now();
  body.innerHTML = drafts.map((d) => renderDraftRowHtml(d, now)).join("");

  // Wire per-row buttons (post-render so DOM exists).
  body.querySelectorAll("[data-draft-apply]").forEach((btn) => {
    btn.addEventListener("click", () => applyDraft(btn.getAttribute("data-draft-apply")));
  });
  body.querySelectorAll("[data-draft-discard]").forEach((btn) => {
    btn.addEventListener("click", () => discardDraft(btn.getAttribute("data-draft-discard")));
  });
}

function renderDraftRowHtml(draft, now) {
  const snap = draft.snapshot || {};
  const dateStr = snap.clock_in
    ? formatDate(new Date(snap.clock_in))
    : "(unknown date)";
  const timeRange = snap.clock_in
    ? `${formatTime(new Date(snap.clock_in))}${snap.clock_out ? " - " + formatTime(new Date(snap.clock_out)) : " (open)"}`
    : "";
  const changes = draft.proposed_changes || {};
  const changeLines = Object.entries(changes).map(([field, val]) => {
    if (field === "clock_in" || field === "clock_out") {
      const oldRaw = snap[field];
      const oldDisp = oldRaw ? formatTime(new Date(oldRaw)) : "—";
      const newDisp = val ? formatTime(new Date(val)) : "—";
      return `<div class="draft-change-line">${escapeHtml(field)}: ${escapeHtml(oldDisp)} → ${escapeHtml(newDisp)}</div>`;
    }
    return `<div class="draft-change-line">${escapeHtml(field)}: ${escapeHtml(String(snap[field] ?? "—"))} → ${escapeHtml(String(val ?? "—"))}</div>`;
  }).join("");

  const ageDays = Math.floor(daysOldOf(draft, now));
  const ageStr = ageDays <= 0 ? "today" : ageDays === 1 ? "1 day ago" : `${ageDays} days ago`;
  const reason = draft.reason ? escapeHtml(draft.reason) : "(no reason)";

  return `
    <div class="draft-row" data-shift-id="${escapeHtml(String(draft.shift_id))}">
      <div class="draft-row-head">
        <span class="draft-row-date">${escapeHtml(dateStr)}</span>
        <span class="draft-row-time">${escapeHtml(timeRange)}</span>
        <span class="draft-row-age">${escapeHtml(ageStr)}</span>
      </div>
      <div class="draft-row-changes">${changeLines || "<em>(no changes)</em>"}</div>
      <div class="draft-row-reason">Reason: ${reason}</div>
      <div class="draft-row-actions">
        <button type="button" class="btn-primary draft-apply" data-draft-apply="${escapeHtml(String(draft.shift_id))}">Apply</button>
        <button type="button" class="btn-outline draft-discard" data-draft-discard="${escapeHtml(String(draft.shift_id))}">Discard</button>
      </div>
    </div>
  `;
}

async function applyDraft(shiftId) {
  const drafts = loadDrafts();
  const draft = drafts.find((d) => String(d.shift_id) === String(shiftId));
  if (!draft) {
    renderDraftsReviewBody();
    return;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    showToast("Still offline. Try again when connected.");
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    showToast("Not connected to server");
    return;
  }

  // Re-fetch the shift's current server state + all edits.
  let currentState = null;
  let currentEdits = [];
  try {
    const { data: shift } = await supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, type, comment")
      .eq("id", draft.shift_id)
      .maybeSingle();
    currentState = shift || null;

    if (currentState) {
      const { data: edits } = await supabase
        .from("tt_edits")
        .select("shift_id, edited_by, edited_by_name, field_changed, old_value, new_value, reason, created_at")
        .eq("shift_id", draft.shift_id)
        .order("created_at", { ascending: true });
      currentEdits = edits || [];
    }
  } catch (err) {
    console.error("Failed to fetch shift state for draft apply:", err);
    showToast("Could not reach server. Try again.");
    return;
  }

  const decision = evaluateDraftApplicability(draft, currentState, currentEdits, authUserId);
  if (decision.action === "discard") {
    removeDraft(draft.shift_id);
    showToast(decision.message || "Draft discarded.");
    renderDraftsReviewBody();
    renderHistoryList();
    return;
  }

  // Clean → fire the edit API just like the live path.
  try {
    const res = await fetch("/api/edit-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        shiftId: draft.shift_id,
        changes: draft.proposed_changes,
        reason: draft.reason || "Employee self-edit (draft)",
      }),
    });
    const apiResult = await res.json();
    if (!res.ok) {
      // Keep the draft so the user can retry later.
      showToast(apiResult.error || "Could not apply draft. Try again.");
      return;
    }

    // Success — same bookkeeping as live edit path.
    const targetShiftId = String(draft.shift_id);
    for (const field of Object.keys(draft.proposed_changes || {})) {
      markFieldConsumed(targetShiftId, field);
    }
    persistEditedFields(editedFieldsByShift);
    const oldInMs = draft.snapshot?.clock_in
      ? new Date(draft.snapshot.clock_in).getTime()
      : 0;
    syncLocalCacheAfterEdit(oldInMs, draft.proposed_changes || {});

    removeDraft(draft.shift_id);
    if (useServerData()) await fetchServerData();
    showToast("Draft applied.");
    renderDraftsReviewBody();
    renderHistoryList();
    renderReport();
  } catch (err) {
    if (isLikelyNetworkError(err)) {
      showToast("Network error. Draft kept for later.");
    } else {
      console.error("Apply draft failed:", err);
      showToast("Could not apply draft.");
    }
  }
}

function discardDraft(shiftId) {
  removeDraft(shiftId);
  showToast("Draft discarded.");
  renderDraftsReviewBody();
  renderHistoryList();
}

/**
 * Called by main.js at app load and on visibility/online events. Discards
 * expired drafts (one toast per removed) and refreshes the banner. No-op when
 * the feature flag is off.
 */
export function refreshDrafts() {
  if (!OFFLINE_DRAFTS_ENABLED) return;
  const { removed } = expireOldDrafts(Date.now());
  for (const d of removed) {
    const date = d.snapshot?.clock_in
      ? formatDate(new Date(d.snapshot.clock_in))
      : "(unknown date)";
    showToast(`Draft for shift on ${date} expired and was discarded.`);
  }
  // Only re-render the banner if the History modal is open — otherwise the
  // next openHistory() pass will render it fresh.
  const historyView = document.getElementById("history-view");
  if (historyView && !historyView.classList.contains("hidden")) {
    renderDraftsBanner();
  }
}
