import "./admin.css";
import { checkAdminAuth, getSupabaseClient } from "../auth.js";

// --- State ---
let supabase = null;
let currentTab = "status";
let shiftsData = [];
let currentPage = 0;
const PAGE_SIZE = 50;
let statusInterval = null;

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
  $("#admin-name").textContent = auth.name;
  $("#auth-gate").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");

  // Set default date range (current week)
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - today.getDay() + 1);
  $("#filter-start").value = formatDateISO(monday);
  $("#filter-end").value = formatDateISO(today);

  setupTabs();
  setupFilters();
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
      $$(".tab-content").forEach((c) => c.classList.add("hidden"));
      $(`#tab-${currentTab}`).classList.remove("hidden");

      if (currentTab === "shifts" && shiftsData.length === 0) {
        loadShifts();
      }
    });
  });
}

// --- Live Status ---
async function loadStatus() {
  const { data, error } = await supabase.rpc("tt_get_user_statuses");
  if (error) {
    console.error("Status error:", error);
    return;
  }

  const now = new Date();
  const working = data.filter((u) => u.action === "Clock In");
  const offline = data.filter((u) => u.action !== "Clock In");
  const sorted = [...working, ...offline];

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
      const duration = isWorking ? calcDuration(u.client_time, now) : "—";

      return `<tr class="${statusClass}">
        <td>${u.user_name}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td>${duration}</td>
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

  let query = supabase
    .from("tt_shifts")
    .select("user_name, clock_in, clock_out, duration_minutes, type, comment")
    .gte("clock_in", `${start}T00:00:00`)
    .lte("clock_in", `${end}T23:59:59`)
    .order("clock_in", { ascending: false })
    .limit(5000);

  if (employee) {
    query = query.eq("user_name", employee);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Shifts error:", error);
    return;
  }

  shiftsData = data || [];
  currentPage = 0;
  renderShifts();
}

function renderShifts() {
  const start = currentPage * PAGE_SIZE;
  const page = shiftsData.slice(start, start + PAGE_SIZE);
  const totalHours = shiftsData.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const maxPage = Math.max(0, Math.ceil(shiftsData.length / PAGE_SIZE) - 1);

  $("#shifts-count").textContent = `${shiftsData.length} shifts`;
  $("#shifts-hours").textContent = `${Math.floor(totalHours / 60)}h ${totalHours % 60}m total`;
  $("#page-info").textContent = `Page ${currentPage + 1} of ${maxPage + 1}`;
  $("#prev-page").disabled = currentPage === 0;
  $("#next-page").disabled = currentPage >= maxPage;

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

      return `<tr class="${s.type !== 'work' ? 'row-special' : ''}">
        <td>${date}</td>
        <td>${s.user_name}</td>
        <td>${inTime}</td>
        <td>${outTime}</td>
        <td>${hours}</td>
        <td>${typeLabel}</td>
        <td>${s.comment || ""}</td>
      </tr>`;
    })
    .join("");
}

// --- Employee list ---
async function loadEmployeeList() {
  const { data } = await supabase
    .from("tt_shifts")
    .select("user_name")
    .limit(5000);

  if (!data) return;
  const names = [...new Set(data.map((r) => r.user_name))].sort();
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
function formatDateISO(d) {
  return d.toISOString().split("T")[0];
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

// --- Start ---
init();
