import { store } from "./store.js";
import { sync } from "./sync.js";
import { showDialog } from "./dialogs.js";
import { formatTime, formatDate, minsToHm, copyToClipboard, showToast } from "./utils.js";
import { getSupabaseClient } from "./auth.js";

let els = null;
let currentReportText = "";
let isUserAuthenticated = false;
let authToken = null;

export function initHistory(elements) {
  els = elements;
}

export function setAuthState(authenticated, token) {
  isUserAuthenticated = authenticated;
  authToken = token;
}

export function openHistory() {
  resetBadge();
  populatePeriods();

  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const range = d <= 15 ? "1-15" : "16-31";
  const currentVal = `${y}_${m}_${range}`;

  if (els.periodSelect.querySelector(`option[value="${currentVal}"]`)) {
    els.periodSelect.value = currentVal;
  }

  renderHistoryList();
  renderReport();

  els.historyView.classList.remove("hidden");
  window.history.pushState({ modal: "history" }, "History", "#history");
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
    const [y, m, range] = val.split("_");
    const [startD, endD] = range.includes("15") ? [1, 15] : [16, 31];
    startDate = new Date(y, m, startD);
    const lastDay = new Date(y, Number(m) + 1, 0).getDate();
    endDate = new Date(y, m, Math.min(endD, lastDay));
    endDate.setHours(23, 59, 59, 999);
  }

  return store.data
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

    let desc =
      item.type === "work"
        ? `${formatTime(new Date(item.in))} - ${item.out ? formatTime(new Date(item.out)) : "Active"}`
        : item.type;

    if (item.duration > 0) desc += ` (${minsToHm(item.duration)})`;

    const commentHtml = item.comment
      ? `<div class="comment-box">💬 ${item.comment}</div>`
      : "";

    const editBtn = isUserAuthenticated
      ? `<button class="edit-btn" data-id="${item.id}">EDIT</button>`
      : "";

    div.innerHTML = `
      <div class="card-header">
        <span class="item-date">${formatDate(new Date(item.dateObj))}</span>
        <span class="item-time">${desc}</span>
      </div>
      ${commentHtml}
      <div class="card-actions">
        ${editBtn}
        <button class="comment-btn" data-id="${item.id}">💬</button>
        <button class="del-btn" data-id="${item.id}">DELETE</button>
      </div>
    `;

    // Event delegation
    if (isUserAuthenticated) {
      div.querySelector(".edit-btn").addEventListener("click", () => editShift(item));
    }
    div.querySelector(".comment-btn").addEventListener("click", () => addComment(item.id));
    div.querySelector(".del-btn").addEventListener("click", () => deleteItem(item.id));

    list.appendChild(div);
  });
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

    if (store.currentShiftId === id) {
      store.status = "out";
      store.currentShiftId = null;
      store.save();
    }

    renderHistoryList();
    renderReport();

    if (item) {
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
async function editShift(item) {
  // Find server-side shift by date + user_name
  const supabase = getSupabaseClient();
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

  // If multiple shifts same day, pick closest to local time
  let shift = shifts[0];
  if (shifts.length > 1 && item.in) {
    const target = item.in;
    shift = shifts.reduce((best, s) => {
      const diff = Math.abs(new Date(s.clock_in).getTime() - target);
      const bestDiff = Math.abs(new Date(best.clock_in).getTime() - target);
      return diff < bestDiff ? s : best;
    });
  }

  // Build edit dialog
  const inStr = shift.clock_in ? toLocalInput(shift.clock_in) : "";
  const outStr = shift.clock_out ? toLocalInput(shift.clock_out) : "";

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px;text-align:left;">
      <label style="font-size:12px;color:var(--gray);">Clock In
        <input type="datetime-local" id="edit-in" value="${inStr}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
      </label>
      <label style="font-size:12px;color:var(--gray);">Clock Out
        <input type="datetime-local" id="edit-out" value="${outStr}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
      </label>
      <label style="font-size:12px;color:var(--gray);">Comment
        <input type="text" id="edit-cmt" value="${shift.comment || ""}" placeholder="Optional" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:14px;margin-top:4px;">
      </label>
    </div>
  `;

  const confirmed = await showDialog(html, "html");
  if (!confirmed) return;

  const newIn = document.getElementById("edit-in").value;
  const newOut = document.getElementById("edit-out").value;
  const newComment = document.getElementById("edit-cmt").value.trim();

  const changes = {};
  if (newIn && new Date(newIn).toISOString() !== shift.clock_in) {
    changes.clock_in = new Date(newIn).toISOString();
  }
  if (newOut && new Date(newOut).toISOString() !== shift.clock_out) {
    changes.clock_out = new Date(newOut).toISOString();
  }
  if (newComment !== (shift.comment || "")) {
    changes.comment = newComment || null;
  }

  if (Object.keys(changes).length === 0) {
    showToast("No changes");
    return;
  }

  try {
    const res = await fetch("/api/edit-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        shiftId: shift.id,
        changes,
        reason: "Employee self-edit",
      }),
    });

    const result = await res.json();
    if (!res.ok) {
      showToast(result.error || "Error");
      return;
    }

    // Update local data too
    if (changes.clock_in) item.in = new Date(changes.clock_in).getTime();
    if (changes.clock_out) {
      item.out = new Date(changes.clock_out).getTime();
      item.duration = Math.floor((item.out - item.in) / 60000);
    }
    if (changes.comment !== undefined) item.comment = changes.comment;
    store.save();

    showToast("Shift updated");
    renderHistoryList();
    renderReport();
  } catch {
    showToast("Network error");
  }
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function populatePeriods() {
  const select = els.periodSelect;
  select.innerHTML = "";

  const today = new Date();
  const currentY = today.getFullYear();
  const currentM = today.getMonth();

  const addOpt = (y, m, isFirst) => {
    const mName = new Date(y, m, 1).toLocaleDateString("en-US", { month: "short" });
    const val = `${y}_${m}_${isFirst ? "1-15" : "16-31"}`;
    const label = `${mName} ${isFirst ? "1-15" : "16-End"}, ${y}`;
    const opt = document.createElement("option");
    opt.value = val;
    opt.innerText = label;
    select.appendChild(opt);
  };

  const isFirst = today.getDate() <= 15;
  addOpt(currentY, currentM, isFirst);
  addOpt(currentY, currentM, !isFirst);
  const prevDate = new Date(currentY, currentM - 1, 1);
  addOpt(prevDate.getFullYear(), prevDate.getMonth(), false);
  addOpt(prevDate.getFullYear(), prevDate.getMonth(), true);

  const customOpt = document.createElement("option");
  customOpt.value = "custom";
  customOpt.innerText = "⚙️ Custom Range...";
  select.appendChild(customOpt);
}
