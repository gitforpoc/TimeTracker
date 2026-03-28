import { store } from "./store.js";
import { sync } from "./sync.js";
import { showDialog } from "./dialogs.js";
import { formatTime, formatDate, minsToHm, copyToClipboard, showToast } from "./utils.js";

let els = null;
let currentReportText = "";

export function initHistory(elements) {
  els = elements;
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

    div.innerHTML = `
      <div class="card-header">
        <span class="item-date">${formatDate(new Date(item.dateObj))}</span>
        <span class="item-time">${desc}</span>
      </div>
      ${commentHtml}
      <div class="card-actions">
        <button class="comment-btn" data-id="${item.id}">💬</button>
        <button class="del-btn" data-id="${item.id}">DELETE</button>
      </div>
    `;

    // Event delegation
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
