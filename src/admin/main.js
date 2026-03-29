import "./admin.css";
import { checkAdminAuth, getSupabaseClient } from "../auth.js";

// --- State ---
let supabase = null;
let authToken = null;
let currentTab = "status";
let shiftsData = [];
let editsMap = {};
let currentPage = 0;
const PAGE_SIZE = 50;
let statusInterval = null;
let workingNames = []; // names of currently working employees
let editOriginal = {}; // original values when edit modal opens

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Init ---
async function init() {
  const auth = await checkAdminAuth();

  if (!auth) {
    $("#auth-gate").classList.add("hidden");
    $("#access-denied").classList.remove("hidden");
    return;
  }

  supabase = getSupabaseClient();
  const { data: { session } } = await supabase.auth.getSession();
  authToken = session?.access_token;
  $("#admin-name").textContent = auth.name;
  $("#auth-gate").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");

  // Set default date range (current week, Mon-today)
  const today = new Date();
  const monday = new Date(today);
  const dayOfWeek = today.getDay();
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(today.getDate() - daysBack);
  $("#filter-start").value = formatDateISO(monday);
  $("#filter-end").value = formatDateISO(today);

  setupTabs();
  setupFilters();
  setupKeyboard();
  loadEmployeeList();
  loadStatus();

  // Auto-refresh status every 60s
  statusInterval = setInterval(() => {
    if (currentTab === "status") loadStatus();
  }, 60000);
}

// --- Tabs ---
function setupTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;

      $$(".tab-content").forEach((c) => {
        c.classList.add("hidden");
        c.classList.remove("active-tab");
      });
      const target = $(`#tab-${currentTab}`);
      target.classList.remove("hidden");
      // Trigger transition after removing hidden
      requestAnimationFrame(() => target.classList.add("active-tab"));

      // Auto-load shifts on tab switch
      if (currentTab === "shifts") {
        loadShifts();
      }
    });
  });
}

// --- Keyboard ---
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#confirm-modal").classList.contains("hidden")) {
        closeConfirmModal();
      } else if (!$("#edit-modal").classList.contains("hidden")) {
        closeEditModal();
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (!$("#confirm-modal").classList.contains("hidden")) {
        e.preventDefault();
        $("#confirm-ok").click();
      } else if (!$("#edit-modal").classList.contains("hidden")) {
        if (!$("#edit-save").disabled) {
          e.preventDefault();
          $("#edit-save").click();
        }
      }
    }
  });
}

// --- Live Status ---
async function loadStatus() {
  const loading = $("#status-loading");
  const table = $("#status-table");
  loading.classList.remove("hidden");
  table.style.opacity = "0.4";

  const { data, error } = await supabase.rpc("tt_get_user_statuses");

  loading.classList.add("hidden");
  table.style.opacity = "1";

  if (error) {
    console.error("Status error:", error);
    return;
  }

  const now = new Date();
  const working = data.filter((u) => u.action === "Clock In");
  const offline = data.filter((u) => u.action !== "Clock In");
  const sorted = [...working, ...offline];

  // Update working names for filter
  workingNames = working.map((u) => u.user_name);

  // Update badge
  const badge = $("#working-badge");
  if (working.length > 0) {
    badge.textContent = working.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  $("#status-count").textContent = `${working.length} working, ${offline.length} offline`;

  const tbody = $("#status-body");
  tbody.innerHTML = sorted
    .map((u) => {
      const isWorking = u.action === "Clock In";
      const isPaidOff = u.action === "Paid Off";
      const statusText = isWorking
        ? "Working"
        : isPaidOff
          ? "Paid Off"
          : "Offline";
      const statusClass = isWorking
        ? "status-working"
        : isPaidOff
          ? "status-paid"
          : "status-offline";

      let duration = "—";
      let durationClass = "";
      if (isWorking) {
        duration = calcDuration(u.client_time, now);
        const diffMin = Math.floor((now - new Date(u.client_time)) / 60000);
        const diffHours = diffMin / 60;
        if (diffHours > 10) durationClass = "duration-red";
        else if (diffHours >= 8) durationClass = "duration-yellow";
        else durationClass = "duration-green";
      }

      return `<tr class="${statusClass}">
        <td>${u.user_name}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td class="${durationClass}">${duration}</td>
      </tr>`;
    })
    .join("");

  $("#refresh-status").onclick = loadStatus;
}

// --- Shifts ---
function setupFilters() {
  $("#apply-filters").addEventListener("click", () => {
    currentPage = 0;
    loadShifts();
  });
  $("#copy-table").addEventListener("click", copyShiftsTable);
  $("#prev-page").addEventListener("click", () => {
    if (currentPage > 0) {
      currentPage--;
      renderShifts();
    }
  });
  $("#next-page").addEventListener("click", () => {
    const maxPage = Math.floor((shiftsData.length - 1) / PAGE_SIZE);
    if (currentPage < maxPage) {
      currentPage++;
      renderShifts();
    }
  });
}

async function loadShifts() {
  const start = $("#filter-start").value;
  const end = $("#filter-end").value;
  const employee = $("#filter-employee").value;

  if (!start || !end) return;

  // Show loading
  const loading = $("#shifts-loading");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const empty = $("#shifts-empty");
  const pagination = $(".pagination");

  loading.classList.remove("hidden");
  table.style.opacity = "0.4";
  cards.style.opacity = "0.4";
  empty.classList.add("hidden");

  let query = supabase
    .from("tt_shifts")
    .select("id, user_name, clock_in, clock_out, duration_minutes, type, comment")
    .gte("clock_in", `${start}T00:00:00`)
    .lte("clock_in", `${end}T23:59:59`)
    .order("clock_in", { ascending: false })
    .limit(5000);

  if (employee === "__working__") {
    // Filter to only currently working employees
    if (workingNames.length > 0) {
      query = query.in("user_name", workingNames);
    } else {
      // No one working — show empty
      shiftsData = [];
      loading.classList.add("hidden");
      table.style.opacity = "1";
      cards.style.opacity = "1";
      renderShifts();
      return;
    }
  } else if (employee) {
    query = query.eq("user_name", employee);
  }

  const { data, error } = await query;

  loading.classList.add("hidden");
  table.style.opacity = "1";
  cards.style.opacity = "1";

  if (error) {
    console.error("Shifts error:", error);
    return;
  }

  shiftsData = data || [];
  currentPage = 0;

  // Load edit history for these shifts
  editsMap = {};
  if (shiftsData.length > 0) {
    const shiftIds = shiftsData.map((s) => s.id);
    const { data: edits } = await supabase
      .from("tt_edits")
      .select("shift_id, field_changed, old_value, new_value, edited_by_name, reason, created_at")
      .in("shift_id", shiftIds)
      .order("created_at", { ascending: true });

    if (edits) {
      edits.forEach((e) => {
        if (!editsMap[e.shift_id]) editsMap[e.shift_id] = [];
        editsMap[e.shift_id].push(e);
      });
    }
  }

  renderShifts();
}

function renderShifts() {
  const start = currentPage * PAGE_SIZE;
  const page = shiftsData.slice(start, start + PAGE_SIZE);
  const totalMinutes = shiftsData.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const maxPage = Math.max(0, Math.ceil(shiftsData.length / PAGE_SIZE) - 1);

  const shiftsWithDuration = shiftsData.filter((s) => s.duration_minutes > 0);
  const avgMinutes = shiftsWithDuration.length > 0
    ? Math.round(totalMinutes / shiftsWithDuration.length)
    : 0;

  $("#shifts-count").textContent = `${shiftsData.length} shifts`;
  $("#shifts-hours").textContent = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m total`;
  $("#shifts-avg").textContent = avgMinutes > 0
    ? `${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m avg`
    : "";
  $("#page-info").textContent = `Page ${currentPage + 1} of ${maxPage + 1}`;
  $("#prev-page").disabled = currentPage === 0;
  $("#next-page").disabled = currentPage >= maxPage;

  // Show/hide empty state
  const empty = $("#shifts-empty");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const pagination = $(".pagination");

  if (shiftsData.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    cards.classList.add("hidden");
    pagination.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  table.classList.remove("hidden");
  cards.classList.remove("hidden");
  pagination.classList.remove("hidden");

  // Desktop table
  const tbody = $("#shifts-body");
  tbody.innerHTML = page
    .map((s) => {
      const date = formatDateShort(s.clock_in);
      const inTime = formatTimeShort(s.clock_in);
      const outTime = s.clock_out ? formatTimeShort(s.clock_out) : "—";
      const hours = s.duration_minutes
        ? `${Math.floor(s.duration_minutes / 60)}h ${s.duration_minutes % 60}m`
        : "—";
      const typeLabel =
        s.type === "day_off" ? "Day Off" : s.type === "paid_off" ? "Paid Off" : "";

      return `<tr class="${s.type !== 'work' ? 'row-special' : ''}" data-id="${s.id}">
        <td>${date}</td>
        <td>${s.user_name}</td>
        <td>${inTime}</td>
        <td>${outTime}</td>
        <td>${hours}</td>
        <td>${typeLabel}</td>
        <td>${esc(s.comment)}</td>
        <td>
          ${editsMap[s.id] ? `<span class="edit-indicator" data-id="${s.id}" title="Edited">✏️</span>` : ""}
          <button class="btn-edit" data-id="${s.id}">Edit</button>
        </td>
      </tr>`;
    })
    .join("");

  // Mobile cards
  cards.innerHTML = page
    .map((s) => {
      const date = formatDateShort(s.clock_in);
      const inTime = formatTimeShort(s.clock_in);
      const outTime = s.clock_out ? formatTimeShort(s.clock_out) : "—";
      const hours = s.duration_minutes
        ? `${Math.floor(s.duration_minutes / 60)}h ${s.duration_minutes % 60}m`
        : "—";
      const typeLabel =
        s.type === "day_off" ? "Day Off" : s.type === "paid_off" ? "Paid Off" : "Work";

      return `<div class="shift-card ${s.type !== 'work' ? 'card-special' : ''}" data-id="${s.id}">
        <div class="card-header">
          <span class="card-name">${s.user_name}</span>
          <span class="card-date">${date}</span>
        </div>
        <div class="card-body">
          <div class="card-times">
            <span class="card-label">In</span> <span class="card-value">${inTime}</span>
            <span class="card-label">Out</span> <span class="card-value">${outTime}</span>
          </div>
          <div class="card-meta">
            <span class="card-hours">${hours}</span>
            ${typeLabel !== "Work" ? `<span class="card-type">${typeLabel}</span>` : ""}
          </div>
        </div>
        ${s.comment ? `<div class="card-comment">${esc(s.comment)}</div>` : ""}
        <button class="btn-edit card-edit" data-id="${s.id}">Edit</button>
      </div>`;
    })
    .join("");
}

// --- Employee list ---
async function loadEmployeeList() {
  // Get distinct employee names from profiles (lightweight query)
  let names = [];

  const { data: profiles } = await supabase
    .from("profiles")
    .select("name")
    .order("name");

  if (profiles && profiles.length > 0) {
    names = [...new Set(profiles.map((p) => p.name).filter(Boolean))];
  } else {
    // Fallback: get distinct names from shifts
    const { data } = await supabase
      .from("tt_shifts")
      .select("user_name")
      .limit(5000);

    if (!data) return;
    names = [...new Set(data.map((r) => r.user_name))].sort();
  }

  const select = $("#filter-employee");
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

// --- Copy to clipboard ---
function copyShiftsTable() {
  if (shiftsData.length === 0) return;

  const header = "Date\tEmployee\tClock In\tClock Out\tHours\tType\tComment";
  const rows = shiftsData.map((s) => {
    const date = formatDateShort(s.clock_in);
    const inTime = formatTimeShort(s.clock_in);
    const outTime = s.clock_out ? formatTimeShort(s.clock_out) : "";
    const hours = s.duration_minutes
      ? (s.duration_minutes / 60).toFixed(2)
      : "";
    const type =
      s.type === "day_off" ? "Day Off" : s.type === "paid_off" ? "Paid Off" : "Work";
    return `${date}\t${s.user_name}\t${inTime}\t${outTime}\t${hours}\t${type}\t${s.comment || ""}`;
  });

  const text = [header, ...rows].join("\n");
  navigator.clipboard.writeText(text).then(() => showToast("Copied!"));
}

// --- Helpers ---
function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDateISO(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
}

function formatTimeShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

function calcDuration(fromISO, to) {
  const diff = Math.floor((to - new Date(fromISO)) / 60000);
  if (diff < 0) return "—";
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

// --- Edit Modal ---
function setupEditListeners() {
  document.addEventListener("click", (e) => {
    // Edit button
    if (e.target.classList.contains("btn-edit")) {
      const id = Number(e.target.dataset.id);
      const shift = shiftsData.find((s) => s.id === id);
      if (shift) openEditModal(shift);
      return;
    }
    // Edit history indicator
    if (e.target.classList.contains("edit-indicator")) {
      const id = Number(e.target.dataset.id);
      showEditHistory(id, e.target);
      return;
    }
    // Close popover on outside click
    const popover = document.querySelector(".edit-popover");
    if (popover && !popover.contains(e.target)) {
      popover.remove();
    }
  });

  $("#edit-cancel").addEventListener("click", closeEditModal);
  $("#edit-overlay").addEventListener("click", closeEditModal);
  $("#edit-save").addEventListener("click", confirmBeforeSave);

  // Track changes to highlight fields and enable/disable save
  const fields = ["#edit-clock-in", "#edit-clock-out", "#edit-type", "#edit-comment"];
  fields.forEach((sel) => {
    $(sel).addEventListener("input", trackEditChanges);
    $(sel).addEventListener("change", trackEditChanges);
  });

  // Confirm modal
  $("#confirm-cancel").addEventListener("click", closeConfirmModal);
  $("#confirm-overlay").addEventListener("click", closeConfirmModal);
  $("#confirm-ok").addEventListener("click", saveEdit);
}

function openEditModal(shift) {
  const modal = $("#edit-modal");
  modal.dataset.shiftId = shift.id;

  $("#edit-employee").textContent = shift.user_name;

  const clockInVal = toLocalDatetimeStr(shift.clock_in);
  const clockOutVal = shift.clock_out ? toLocalDatetimeStr(shift.clock_out) : "";

  $("#edit-clock-in").value = clockInVal;
  $("#edit-clock-out").value = clockOutVal;
  $("#edit-type").value = shift.type;
  $("#edit-comment").value = shift.comment || "";
  $("#edit-reason").value = "";

  // Store original values
  editOriginal = {
    clockIn: clockInVal,
    clockOut: clockOutVal,
    type: shift.type,
    comment: shift.comment || "",
  };

  // Reset field highlights
  $$(".modal-fields label").forEach((l) => l.classList.remove("field-changed"));
  $("#edit-save").disabled = true;

  modal.classList.remove("hidden");
  $("#edit-overlay").classList.remove("hidden");
}

function trackEditChanges() {
  const clockIn = $("#edit-clock-in");
  const clockOut = $("#edit-clock-out");
  const type = $("#edit-type");
  const comment = $("#edit-comment");

  const changes = {
    clockIn: clockIn.value !== editOriginal.clockIn,
    clockOut: clockOut.value !== editOriginal.clockOut,
    type: type.value !== editOriginal.type,
    comment: comment.value !== editOriginal.comment,
  };

  // Highlight changed fields
  clockIn.closest("label").classList.toggle("field-changed", changes.clockIn);
  clockOut.closest("label").classList.toggle("field-changed", changes.clockOut);
  type.closest("label").classList.toggle("field-changed", changes.type);
  comment.closest("label").classList.toggle("field-changed", changes.comment);

  const hasChanges = Object.values(changes).some(Boolean);
  $("#edit-save").disabled = !hasChanges;
}

function closeEditModal() {
  $("#edit-modal").classList.add("hidden");
  $("#edit-overlay").classList.add("hidden");
}

function confirmBeforeSave() {
  // Build change summary
  const changes = [];
  if ($("#edit-clock-in").value !== editOriginal.clockIn) {
    changes.push(`<strong>Clock In:</strong> ${editOriginal.clockIn || "(empty)"} → ${$("#edit-clock-in").value || "(empty)"}`);
  }
  if ($("#edit-clock-out").value !== editOriginal.clockOut) {
    changes.push(`<strong>Clock Out:</strong> ${editOriginal.clockOut || "(empty)"} → ${$("#edit-clock-out").value || "(empty)"}`);
  }
  if ($("#edit-type").value !== editOriginal.type) {
    changes.push(`<strong>Type:</strong> ${editOriginal.type} → ${$("#edit-type").value}`);
  }
  if ($("#edit-comment").value !== editOriginal.comment) {
    changes.push(`<strong>Comment:</strong> "${editOriginal.comment || "(empty)"}" → "${$("#edit-comment").value || "(empty)"}"`);
  }

  if (changes.length === 0) return;

  const reason = $("#edit-reason").value.trim();
  if (reason) {
    changes.push(`<strong>Reason:</strong> ${esc(reason)}`);
  }

  $("#confirm-changes").innerHTML = changes.map((c) => `<div class="confirm-line">${c}</div>`).join("");
  $("#confirm-modal").classList.remove("hidden");
  $("#confirm-overlay").classList.remove("hidden");
}

function closeConfirmModal() {
  $("#confirm-modal").classList.add("hidden");
  $("#confirm-overlay").classList.add("hidden");
}

async function saveEdit() {
  closeConfirmModal();

  const shiftId = Number($("#edit-modal").dataset.shiftId);
  const shift = shiftsData.find((s) => s.id === shiftId);
  if (!shift) return;

  const changes = {};
  const rawIn = $("#edit-clock-in").value;
  const rawOut = $("#edit-clock-out").value;

  if (rawIn && isNaN(new Date(rawIn).getTime())) {
    showToast("Invalid Clock In date");
    return;
  }
  if (rawOut && isNaN(new Date(rawOut).getTime())) {
    showToast("Invalid Clock Out date");
    return;
  }

  const newClockIn = rawIn ? new Date(rawIn).toISOString() : null;
  const newClockOut = rawOut ? new Date(rawOut).toISOString() : null;
  const newType = $("#edit-type").value;
  const newComment = $("#edit-comment").value.trim();
  const reason = $("#edit-reason").value.trim();

  // Compare by epoch ms to avoid ISO string format mismatches
  const oldInMs = shift.clock_in ? new Date(shift.clock_in).getTime() : 0;
  const oldOutMs = shift.clock_out ? new Date(shift.clock_out).getTime() : 0;
  const newInMs = new Date(newClockIn).getTime();
  const newOutMs = newClockOut ? new Date(newClockOut).getTime() : 0;

  if (newInMs !== oldInMs) changes.clock_in = newClockIn;
  if (newOutMs !== oldOutMs) changes.clock_out = newClockOut;
  if (newType !== shift.type) changes.type = newType;
  if (newComment !== (shift.comment || "")) changes.comment = newComment || null;

  if (Object.keys(changes).length === 0) {
    closeEditModal();
    return;
  }

  $("#edit-save").disabled = true;
  $("#edit-save").textContent = "Saving...";

  try {
    const res = await fetch("/api/edit-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ shiftId, changes, reason }),
    });

    const result = await res.json();

    if (!res.ok) {
      showToast(result.error || "Error saving");
      return;
    }

    showToast(`Updated ${result.edits} field(s)`);
    closeEditModal();
    loadShifts(); // Reload to show updated data
  } catch (err) {
    showToast("Network error");
    console.error(err);
  } finally {
    $("#edit-save").disabled = false;
    $("#edit-save").textContent = "Save";
  }
}

function toLocalDatetimeStr(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

// --- Edit History Popover ---
function showEditHistory(shiftId, anchor) {
  // Remove existing popover
  document.querySelectorAll(".edit-popover").forEach((p) => p.remove());

  const edits = editsMap[shiftId];
  if (!edits || edits.length === 0) return;

  const popover = document.createElement("div");
  popover.className = "edit-popover";

  const rows = edits.map((e) => {
    const time = new Date(e.created_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const isAdmin = e.edited_by_name !== shiftsData.find((s) => s.id === shiftId)?.user_name;
    const badge = isAdmin ? "supervisor" : "employee";
    return `<div class="edit-entry">
      <div class="edit-meta">
        <span class="edit-badge edit-badge-${badge}">${esc(e.edited_by_name)}</span>
        <span class="edit-time">${time}</span>
      </div>
      <div class="edit-detail">${esc(e.field_changed)}: ${esc(e.old_value) || "—"} → ${esc(e.new_value) || "—"}</div>
      ${e.reason ? `<div class="edit-reason">${esc(e.reason)}</div>` : ""}
    </div>`;
  }).join("");

  popover.innerHTML = `<div class="popover-title">Edit History</div>${rows}`;

  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`;

  document.body.appendChild(popover);
}

// --- Start ---
setupEditListeners();
init();
