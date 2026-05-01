import { state, isAdmin } from "./state.js";
import { $, esc, formatDateISO, formatDateShort, formatTimeShort } from "./helpers.js";
import { hideEmployeeDetail, loadEmployeesTab } from "./employees.js";
import {
  calculateWeeklyOvertime,
  getWorkWeekStart,
  getSemiMonthlyPeriod,
  getBiWeeklyPeriod,
  getWeeklyPeriod,
} from "../payPeriods.js";

const PERIOD_TYPE_KEY = "tt_admin_period_type";
const CUSTOM_PERIOD_KEY = "tt_admin_custom_period";

// Soft-deleted (inactive) employees should not appear in payroll/OT calcs or alerts.
// They still exist in tt_employee_settings for audit; the Employees tab still shows them
// (greyed out) so admins can re-activate.
function isActive(settings) {
  return settings && settings.active !== false;
}

function fmtMoney(n) {
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtHours(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// --- Dashboard ---

// Backward-compat export — kept in case external code references it
export function getBimonthlyPeriod(date) {
  return getSemiMonthlyPeriod(date);
}

function periodForType(date, type) {
  if (type === "bi_weekly") return getBiWeeklyPeriod(date);
  if (type === "weekly") return getWeeklyPeriod(date);
  return getSemiMonthlyPeriod(date);
}

function shiftPeriod(dir) {
  const type = state.payPeriodType;
  if (type === "custom") return state.dashPeriod; // no nav for custom
  const ref = new Date(state.dashPeriod.start);
  if (type === "bi_weekly") {
    ref.setDate(ref.getDate() + dir * 14);
    return getBiWeeklyPeriod(ref);
  }
  if (type === "weekly") {
    ref.setDate(ref.getDate() + dir * 7);
    return getWeeklyPeriod(ref);
  }
  // semi_monthly
  if (dir === -1) {
    if (ref.getDate() === 16) return getSemiMonthlyPeriod(new Date(ref.getFullYear(), ref.getMonth(), 1));
    const prev = new Date(ref.getFullYear(), ref.getMonth(), 0);
    return getSemiMonthlyPeriod(prev);
  }
  if (ref.getDate() === 1) return getSemiMonthlyPeriod(new Date(ref.getFullYear(), ref.getMonth(), 16));
  const next = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  return getSemiMonthlyPeriod(next);
}

export function initDashPeriod() {
  const saved = localStorage.getItem(PERIOD_TYPE_KEY);
  if (saved && ["semi_monthly", "bi_weekly", "weekly", "custom"].includes(saved)) {
    state.payPeriodType = saved;
  }
  if (state.payPeriodType === "custom") {
    // Restore last custom range if persisted
    try {
      const raw = localStorage.getItem(CUSTOM_PERIOD_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.startISO && parsed?.endISO) {
        const [sy, sm, sd] = parsed.startISO.split("-").map(Number);
        const [ey, em, ed] = parsed.endISO.split("-").map(Number);
        state.dashPeriod = {
          start: new Date(sy, sm - 1, sd),
          end: new Date(ey, em - 1, ed, 23, 59, 59, 999),
          label: `${parsed.startISO} – ${parsed.endISO}`,
        };
        $("#custom-start").value = parsed.startISO;
        $("#custom-end").value = parsed.endISO;
      } else {
        // No saved custom range → use current bi-weekly window as a starting visual
        state.dashPeriod = getBiWeeklyPeriod(new Date());
      }
    } catch {
      state.dashPeriod = getBiWeeklyPeriod(new Date());
    }
  } else {
    state.dashPeriod = periodForType(new Date(), state.payPeriodType);
  }
  syncPeriodTypeUI();
  renderPeriodLabel();
}

function syncPeriodTypeUI() {
  const sel = $("#period-type-select");
  if (sel) sel.value = state.payPeriodType;
  const customBox = $("#custom-period-controls");
  const prev = $("#dash-prev");
  const next = $("#dash-next");
  const isCustom = state.payPeriodType === "custom";
  if (customBox) customBox.classList.toggle("hidden", !isCustom);
  if (prev) prev.style.visibility = isCustom ? "hidden" : "";
  if (next) next.style.visibility = isCustom ? "hidden" : "";
}

function renderPeriodLabel() {
  const el = $("#dash-period-label");
  if (el) el.textContent = state.dashPeriod.label;
}

function reloadAllTabsForPeriod() {
  if (state.currentTab === "dashboard") loadDashboard();
  else if (state.currentTab === "employees") loadEmployeesTab();
  // Other tabs (Shift Log, Live, Map) don't use dashPeriod — period change applies when user navigates back.
}

export function setupDashboardNav() {
  $("#dash-prev").addEventListener("click", () => {
    state.dashPeriod = shiftPeriod(-1);
    renderPeriodLabel();
    reloadAllTabsForPeriod();
  });
  $("#dash-next").addEventListener("click", () => {
    state.dashPeriod = shiftPeriod(1);
    renderPeriodLabel();
    reloadAllTabsForPeriod();
  });

  $("#period-type-select").addEventListener("change", (e) => {
    const type = e.target.value;
    state.payPeriodType = type;
    localStorage.setItem(PERIOD_TYPE_KEY, type);
    if (type === "custom") {
      // Initialize custom inputs with current period if not set
      const startEl = $("#custom-start");
      const endEl = $("#custom-end");
      if (!startEl.value) startEl.value = formatDateISO(state.dashPeriod.start);
      if (!endEl.value) endEl.value = formatDateISO(state.dashPeriod.end);
    } else {
      state.dashPeriod = periodForType(new Date(), type);
      renderPeriodLabel();
      reloadAllTabsForPeriod();
    }
    syncPeriodTypeUI();
  });

  $("#custom-apply").addEventListener("click", () => {
    const startStr = $("#custom-start").value;
    const endStr = $("#custom-end").value;
    if (!startStr || !endStr) return;
    const [sy, sm, sd] = startStr.split("-").map(Number);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed, 23, 59, 59, 999);
    if (end < start) return;
    state.dashPeriod = {
      start,
      end,
      label: `${startStr} – ${endStr}`,
    };
    localStorage.setItem(CUSTOM_PERIOD_KEY, JSON.stringify({ startISO: startStr, endISO: endStr }));
    renderPeriodLabel();
    reloadAllTabsForPeriod();
  });

  $("#emp-back").addEventListener("click", hideEmployeeDetail);
}

export async function loadDashboard() {
  if (!state.supabase || !state.dashPeriod) return;

  // Guard against stale results from rapid period changes — only the latest call wins.
  const myToken = ++state.loadToken;

  const startISO = formatDateISO(state.dashPeriod.start);
  const endISO = formatDateISO(state.dashPeriod.end);

  // Current workweek for OT alerts — independent of the visible period so alerts always reflect
  // today's reality (e.g. when user is browsing a past period dashboard).
  const currentWeekStart = getWorkWeekStart(new Date());
  const currentWeekStartISO = formatDateISO(currentWeekStart);

  const [shiftsResult, settingsResult, weekShiftsResult] = await Promise.all([
    state.supabase
      .from("tt_shifts")
      .select("id, user_name, clock_in, clock_out, duration_minutes, type")
      .gte("clock_in", `${startISO}T00:00:00`)
      .lte("clock_in", `${endISO}T23:59:59`)
      .limit(5000),
    state.supabase.from("tt_employee_settings").select("*"),
    state.supabase
      .from("tt_shifts")
      .select("user_name, clock_in, duration_minutes, type")
      .eq("type", "work")
      .gte("clock_in", `${currentWeekStartISO}T00:00:00`)
      .limit(2000),
  ]);

  if (myToken !== state.loadToken) return; // a newer call superseded this one

  const rows = shiftsResult.data || [];
  const settings = settingsResult.data || [];
  const currentWeekShifts = weekShiftsResult.data || [];
  state.employeeSettings = settings; // share with employees tab

  const workShifts = rows.filter((s) => s.type === "work");
  const totalMin = workShifts.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const uniqueEmployees = [...new Set(rows.map((s) => s.user_name))];

  // Per-employee weekly OT calc, period-bounded so Reg + OT == Total Hours always.
  // Trade-off: workweeks split by the period boundary may show slightly low OT (a few hours).
  // This keeps the math intuitive and matches simple payroll-period summaries.
  const settingsByName = {};
  settings.forEach((s) => { settingsByName[s.user_name] = s; });

  const otByEmployee = {};
  for (const s of settings) {
    if (s.employment_type !== "W2") continue;
    if (!isActive(s)) continue; // soft-deleted employees skip payroll
    const empShifts = rows.filter((r) => r.user_name === s.user_name && r.type === "work");
    const buckets = calculateWeeklyOvertime(empShifts, s.overtime_threshold || 40);
    const regMin = buckets.reduce((sum, b) => sum + b.regMin, 0);
    const otMin = buckets.reduce((sum, b) => sum + b.otMin, 0);
    const rate = Number(s.rate) || 0;
    const payTotal = (regMin / 60) * rate + (otMin / 60) * rate * 1.5;
    otByEmployee[s.user_name] = { regMin, otMin, payTotal, isW2: true, rate };
  }

  // Aggregate W2 totals for dashboard summary
  const w2Total = Object.values(otByEmployee).reduce(
    (acc, e) => ({
      regMin: acc.regMin + e.regMin,
      otMin: acc.otMin + e.otMin,
      payTotal: acc.payTotal + e.payTotal,
      hasRate: acc.hasRate || e.rate > 0,
    }),
    { regMin: 0, otMin: 0, payTotal: 0, hasRate: false }
  );
  const w2Count = Object.keys(otByEmployee).length;

  // Setup status: how many ACTIVE employees have employment_type set
  const activeSettings = settings.filter(isActive);
  const totalEmployees = activeSettings.length;
  const configuredCount = activeSettings.filter((s) => s.employment_type).length;
  const unsetCount = totalEmployees - configuredCount;

  // Summary cards
  const cardsEl = $("#dash-cards");
  let cardsHtml = `
    <div class="dash-card"><div class="dash-card-label">Working Now</div><div class="dash-card-value accent-green">${state.workingNames.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Shifts This Period</div><div class="dash-card-value accent-pink">${rows.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${Math.round(totalMin / 60)}</div></div>`;

  if (w2Count > 0) {
    const otH = Math.round(w2Total.otMin / 60 * 10) / 10;
    cardsHtml += `<div class="dash-card"><div class="dash-card-label">W2 Overtime</div><div class="dash-card-value ${otH > 0 ? "accent-pink" : "accent-gray"}">${otH}h</div><div class="dash-card-sub">${w2Count} W2 employee${w2Count > 1 ? "s" : ""}</div></div>`;

    // Pay totals are admin-only (supervisors see hours, not money)
    if (isAdmin() && w2Total.hasRate && w2Total.payTotal > 0) {
      cardsHtml += `<div class="dash-card"><div class="dash-card-label">W2 Payroll Cost</div><div class="dash-card-value accent-yellow">${fmtMoney(w2Total.payTotal)}</div><div class="dash-card-sub">reg + OT (1.5×)</div></div>`;
    }
  } else {
    cardsHtml += `<div class="dash-card"><div class="dash-card-label">Active Employees</div><div class="dash-card-value accent-yellow">${uniqueEmployees.length}</div></div>`;
  }

  // Setup status nudge (only shown if any employees are unset)
  if (unsetCount > 0) {
    cardsHtml += `<div class="dash-card dash-card-action" id="dash-setup-nudge"><div class="dash-card-label">Setup</div><div class="dash-card-value accent-gray">${configuredCount}/${totalEmployees}</div><div class="dash-card-sub">${unsetCount} employee${unsetCount > 1 ? "s" : ""} need W2/1099 set</div></div>`;
  }

  cardsEl.innerHTML = cardsHtml;

  // Wire setup nudge → switch to Employees tab
  const nudge = $("#dash-setup-nudge");
  if (nudge) {
    nudge.addEventListener("click", () => {
      const tabBtn = document.querySelector(".tab[data-tab=\"employees\"]");
      if (tabBtn) tabBtn.click();
    });
  }

  // Hours bar chart — segmented for W2 (reg blue + OT pink), single bar for others
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
      const otData = otByEmployee[name];
      const empType = settingsByName[name]?.employment_type;
      const typeBadge = empType ? `<span class="dash-bar-type type-${empType.toLowerCase()}">${esc(empType)}</span>` : "";

      let fillHtml;
      let labelText;
      if (otData && otData.otMin > 0) {
        // Two-color split: reg portion vs OT portion
        const regPct = Math.round((otData.regMin / (otData.regMin + otData.otMin)) * 100);
        fillHtml = `<div class="dash-bar-fill split" style="width:${pct}%">
          <div class="dash-bar-reg" style="width:${regPct}%"></div>
          <div class="dash-bar-ot" style="width:${100 - regPct}%"></div>
        </div>`;
        const regH = Math.round(otData.regMin / 60 * 10) / 10;
        const otH = Math.round(otData.otMin / 60 * 10) / 10;
        labelText = `${regH}h <span class="dash-bar-ot-text">+${otH}h OT</span>`;
      } else {
        fillHtml = `<div class="dash-bar-fill" style="width:${pct}%"></div>`;
        labelText = fmtHours(min);
      }

      return `<div class="dash-bar-row">
        <span class="dash-bar-name">${esc(name)}${typeBadge}</span>
        <div class="dash-bar-track">${fillHtml}</div>
        <span class="dash-bar-hours">${labelText}</span>
      </div>`;
    }).join("");
  }

  // Daily activity — matches selected period
  const dailyEl = $("#dash-daily");
  const days = [];
  const cur = new Date(state.dashPeriod.start);
  const dailyEnd = new Date(state.dashPeriod.end);
  while (cur <= dailyEnd) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  // Aggregate shifts and hours per day
  const dayStats = {};
  rows.forEach((s) => {
    const key = new Date(s.clock_in).toDateString();
    if (!dayStats[key]) dayStats[key] = { count: 0, minutes: 0, names: [] };
    dayStats[key].count++;
    if (s.type === "work") dayStats[key].minutes += s.duration_minutes || 0;
    if (!dayStats[key].names.includes(s.user_name)) dayStats[key].names.push(s.user_name);
  });
  const maxCount = Math.max(1, ...Object.values(dayStats).map((d) => d.count));
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  dailyEl.innerHTML = days.map((d) => {
    const key = d.toDateString();
    const stat = dayStats[key] || { count: 0, minutes: 0, names: [] };
    const hPct = stat.count > 0 ? Math.max(8, Math.round((stat.count / maxCount) * 100)) : 0;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const dayName = dayNames[d.getDay()];
    const h = Math.floor(stat.minutes / 60);
    const m = stat.minutes % 60;
    const tooltip = stat.count > 0
      ? `${dayName} ${label}: ${stat.count} shifts, ${h}h ${m}m\n${stat.names.join(", ")}`
      : `${dayName} ${label}: no shifts`;
    return `<div class="dash-daily-bar">
      <div class="dash-daily-fill" style="height:${hPct}%" title="${tooltip}"></div>
      <span class="dash-daily-label">${label}</span>
    </div>`;
  }).join("");

  // Alerts
  const alertsEl = $("#dash-alerts");
  const alerts = [];

  // OT alerts — use the dedicated current-week query so we capture the FULL Thu-Wed
  // workweek regardless of the visible period. Alerts are about today's reality, not history.
  const now = new Date();
  for (const s of settings) {
    if (s.employment_type !== "W2") continue;
    if (!isActive(s)) continue;
    const empWeekMin = currentWeekShifts
      .filter((r) => r.user_name === s.user_name)
      .reduce((sum, r) => {
        if (r.clock_out || r.duration_minutes) return sum + (r.duration_minutes || 0);
        // Open shift in current week: count elapsed since clock_in
        return sum + Math.max(0, (now - new Date(r.clock_in)) / 60000);
      }, 0);
    const weekH = empWeekMin / 60;
    const threshold = s.overtime_threshold || 40;

    if (weekH > threshold) {
      const overH = Math.round((weekH - threshold) * 10) / 10;
      alerts.push({
        type: "danger",
        icon: "💸",
        text: `${esc(s.user_name)} is over OT this week (${Math.round(weekH * 10) / 10}h, +${overH}h OT)`,
      });
    } else if (weekH >= threshold - 5) {
      alerts.push({
        type: "warn",
        icon: "⏳",
        text: `${esc(s.user_name)} is approaching OT (${Math.round(weekH * 10) / 10}h / ${threshold}h this week)`,
      });
    }
  }

  // Long shifts (within period)
  const longShifts = workShifts.filter((s) => s.duration_minutes > 720);
  longShifts.forEach((s) => {
    const h = Math.floor(s.duration_minutes / 60);
    const m = s.duration_minutes % 60;
    alerts.push({ type: "warn", icon: "⚠️", text: `${esc(s.user_name)} worked ${h}h ${m}m on ${formatDateShort(s.clock_in)}` });
  });

  // Open shifts — only alert if older than 14 hours (likely forgot to clock out)
  const openShifts = rows.filter((s) => {
    if (s.type !== "work" || s.clock_out) return false;
    const ageMinutes = (now - new Date(s.clock_in)) / 60000;
    return ageMinutes > 840; // 14 hours
  });
  openShifts.forEach((s) => {
    alerts.push({ type: "danger", icon: "🔴", text: `${esc(s.user_name)} has an open shift since ${formatDateShort(s.clock_in)} ${formatTimeShort(s.clock_in)}` });
  });

  if (alerts.length === 0) {
    alertsEl.innerHTML = '<div class="dash-alert-none">No alerts — looking good</div>';
  } else {
    alertsEl.innerHTML = alerts.map((a) =>
      `<div class="dash-alert alert-${a.type}"><span class="dash-alert-icon">${a.icon}</span> ${a.text}</div>`
    ).join("");
  }
}
