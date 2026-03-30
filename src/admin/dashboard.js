import { state } from "./state.js";
import { $, esc, formatDateISO, formatDateShort, formatTimeShort } from "./helpers.js";
import { hideEmployeeDetail } from "./employees.js";

// --- Dashboard ---

export function getBimonthlyPeriod(date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  if (d <= 15) {
    return {
      start: new Date(y, m, 1),
      end: new Date(y, m, 15, 23, 59, 59),
      label: `${(m + 1).toString().padStart(2, "0")}/01 – ${(m + 1).toString().padStart(2, "0")}/15/${y}`,
    };
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    start: new Date(y, m, 16),
    end: new Date(y, m, lastDay, 23, 59, 59),
    label: `${(m + 1).toString().padStart(2, "0")}/16 – ${(m + 1).toString().padStart(2, "0")}/${lastDay}/${y}`,
  };
}

function shiftPeriod(dir) {
  const ref = new Date(state.dashPeriod.start);
  if (dir === -1) {
    // prev
    if (ref.getDate() === 16) {
      return getBimonthlyPeriod(new Date(ref.getFullYear(), ref.getMonth(), 1));
    }
    const prev = new Date(ref.getFullYear(), ref.getMonth(), 0); // last day of prev month
    return getBimonthlyPeriod(prev);
  }
  // next
  if (ref.getDate() === 1) {
    return getBimonthlyPeriod(new Date(ref.getFullYear(), ref.getMonth(), 16));
  }
  const next = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  return getBimonthlyPeriod(next);
}

export function initDashPeriod() {
  state.dashPeriod = getBimonthlyPeriod(new Date());
  renderPeriodLabel();
}

function renderPeriodLabel() {
  const el = $("#dash-period-label");
  if (el) el.textContent = state.dashPeriod.label;
}

export function setupDashboardNav() {
  $("#dash-prev").addEventListener("click", () => {
    state.dashPeriod = shiftPeriod(-1);
    renderPeriodLabel();
    loadDashboard();
  });
  $("#dash-next").addEventListener("click", () => {
    state.dashPeriod = shiftPeriod(1);
    renderPeriodLabel();
    loadDashboard();
  });
  $("#emp-back").addEventListener("click", hideEmployeeDetail);
}

export async function loadDashboard() {
  if (!state.supabase || !state.dashPeriod) return;

  const startISO = formatDateISO(state.dashPeriod.start);
  const endISO = formatDateISO(state.dashPeriod.end);

  const { data: shifts } = await state.supabase
    .from("tt_shifts")
    .select("id, user_name, clock_in, clock_out, duration_minutes, type")
    .gte("clock_in", `${startISO}T00:00:00`)
    .lte("clock_in", `${endISO}T23:59:59`)
    .limit(5000);

  const rows = shifts || [];
  const workShifts = rows.filter((s) => s.type === "work");
  const totalMin = workShifts.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const uniqueEmployees = [...new Set(rows.map((s) => s.user_name))];

  // Summary cards
  const cardsEl = $("#dash-cards");
  cardsEl.innerHTML = `
    <div class="dash-card"><div class="dash-card-label">Working Now</div><div class="dash-card-value accent-green">${state.workingNames.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Shifts This Period</div><div class="dash-card-value accent-pink">${rows.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${Math.round(totalMin / 60)}</div></div>
    <div class="dash-card"><div class="dash-card-label">Active Employees</div><div class="dash-card-value accent-yellow">${uniqueEmployees.length}</div></div>
  `;

  // Hours bar chart
  const hoursByEmp = {};
  workShifts.forEach((s) => {
    hoursByEmp[s.user_name] = (hoursByEmp[s.user_name] || 0) + (s.duration_minutes || 0);
  });
  const sorted = Object.entries(hoursByEmp).sort((a, b) => b[1] - a[1]);
  const maxMin = sorted.length ? sorted[0][1] : 1;

  const barsEl = $("#dash-bars");
  if (sorted.length === 0) {
    barsEl.innerHTML = '<div class="dash-alert-none">No work shifts in this period</div>';
  } else {
    barsEl.innerHTML = sorted.map(([name, min]) => {
      const pct = Math.max(1, Math.round((min / maxMin) * 100));
      const h = Math.floor(min / 60);
      const m = min % 60;
      return `<div class="dash-bar-row">
        <span class="dash-bar-name">${esc(name)}</span>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%"></div></div>
        <span class="dash-bar-hours">${h}h ${m}m</span>
      </div>`;
    }).join("");
  }

  // Daily activity (last 14 days from today, not from period)
  const dailyEl = $("#dash-daily");
  const today = new Date();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  const dayCounts = {};
  rows.forEach((s) => {
    const key = new Date(s.clock_in).toDateString();
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });
  const maxCount = Math.max(1, ...Object.values(dayCounts));

  dailyEl.innerHTML = days.map((d) => {
    const key = d.toDateString();
    const count = dayCounts[key] || 0;
    const hPct = count > 0 ? Math.max(8, Math.round((count / maxCount) * 100)) : 0;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    return `<div class="dash-daily-bar">
      <div class="dash-daily-fill" style="height:${hPct}%" title="${count} shifts"></div>
      <span class="dash-daily-label">${label}</span>
    </div>`;
  }).join("");

  // Alerts
  const alertsEl = $("#dash-alerts");
  const alerts = [];

  // Long shifts
  const longShifts = workShifts.filter((s) => s.duration_minutes > 720);
  longShifts.forEach((s) => {
    const h = Math.floor(s.duration_minutes / 60);
    const m = s.duration_minutes % 60;
    alerts.push({ type: "warn", icon: "⚠️", text: `${esc(s.user_name)} worked ${h}h ${m}m on ${formatDateShort(s.clock_in)}` });
  });

  // Open shifts
  const openShifts = rows.filter((s) => s.type === "work" && !s.clock_out);
  openShifts.forEach((s) => {
    alerts.push({ type: "danger", icon: "🔴", text: `${esc(s.user_name)} has an open shift since ${formatDateShort(s.clock_in)} ${formatTimeShort(s.clock_in)}` });
  });

  if (alerts.length === 0) {
    alertsEl.innerHTML = '<div class="dash-alert-none">No alerts for this period</div>';
  } else {
    alertsEl.innerHTML = alerts.map((a) =>
      `<div class="dash-alert alert-${a.type}"><span class="dash-alert-icon">${a.icon}</span> ${a.text}</div>`
    ).join("");
  }
}
