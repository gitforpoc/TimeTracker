import { state, isAdmin } from "./state.js";
import { $, esc, formatDateISO, formatDateShort, formatTimeShort } from "./helpers.js";
import { hideEmployeeDetail, loadEmployeesTab } from "./employees.js";
import {
  calculatePeriodOvertime,
  getSemiMonthlyPeriod,
  getBiWeeklyPeriod,
  getWeeklyPeriod,
  effectiveShiftMinutes,
  isHeatDay,
} from "../payPeriods.js";
import { SOFT_CAP_HOURS } from "../constants.js";
import { loadSchedule } from "./schedule.js";
import { forecastEmployeeHours } from "./forecast.js";

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
  // Update pill active state
  document.querySelectorAll(".period-pill").forEach((p) => {
    const isActive = p.dataset.period === state.payPeriodType;
    p.classList.toggle("is-active", isActive);
    p.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  const customBox = $("#custom-period-controls");
  const stepper = document.querySelector(".period-stepper");
  const isCustom = state.payPeriodType === "custom";
  if (customBox) customBox.classList.toggle("hidden", !isCustom);
  if (stepper) stepper.style.display = isCustom ? "none" : "";
}

function renderPeriodLabel() {
  const el = $("#dash-period-label");
  if (el && state.dashPeriod) el.textContent = state.dashPeriod.label;
  renderPeriodProgress();
  renderJumpNow();
}

// Sub-line under the date label: shows where today falls inside the visible period.
// Empty if today is outside the period (past or future).
function renderPeriodProgress() {
  const fill = $("#period-progress-fill");
  if (!fill || !state.dashPeriod) return;
  const now = new Date();
  const start = state.dashPeriod.start;
  const end = state.dashPeriod.end;
  if (now < start || now > end) {
    fill.style.width = "0%";
    fill.dataset.state = "outside";
    return;
  }
  const pct = ((now - start) / (end - start)) * 100;
  fill.style.width = `${Math.min(100, Math.max(2, pct))}%`;
  fill.dataset.state = "inside";
}

// "Jump to current period" — visible only when browsing a past/future period.
function renderJumpNow() {
  const btn = $("#period-jump-now");
  if (!btn || !state.dashPeriod) return;
  const now = new Date();
  const isCurrent = now >= state.dashPeriod.start && now <= state.dashPeriod.end;
  btn.classList.toggle("hidden", isCurrent || state.payPeriodType === "custom");
}

function reloadAllTabsForPeriod() {
  // Dashboard + Employees + Shift Log all consume the global period.
  // For Shift Log, sync the period dates into the From/To filter inputs so the user can still
  // tweak them manually (custom dates within a period). Then trigger the same query.
  if (state.payPeriodType !== "custom" && state.dashPeriod) {
    const fStart = $("#filter-start");
    const fEnd = $("#filter-end");
    if (fStart && fEnd) {
      fStart.value = formatDateISO(state.dashPeriod.start);
      fEnd.value = formatDateISO(state.dashPeriod.end);
    }
  }
  if (state.currentTab === "dashboard") loadDashboard();
  else if (state.currentTab === "employees") loadEmployeesTab();
  else if (state.currentTab === "shifts") {
    // Lazy-import to avoid a circular dependency at module load
    import("./shifts.js").then((m) => { state.currentPage = 0; m.loadShifts(); });
  }
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

  // Period-type pills replace the old <select>
  document.querySelectorAll(".period-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const type = pill.dataset.period;
      if (type === state.payPeriodType) return;
      state.payPeriodType = type;
      localStorage.setItem(PERIOD_TYPE_KEY, type);
      if (type === "custom") {
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
  });

  // "→ NOW" — jump to current period (only visible when browsing past/future)
  const jumpBtn = $("#period-jump-now");
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      if (state.payPeriodType === "custom") return;
      state.dashPeriod = periodForType(new Date(), state.payPeriodType);
      renderPeriodLabel();
      reloadAllTabsForPeriod();
    });
  }

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

  // Current pay period for OT alerts — independent of the visible period so alerts always reflect
  // today's reality (e.g. when user is browsing a past period dashboard).
  const currentPeriod = getBiWeeklyPeriod(new Date());
  const currentPeriodStartISO = formatDateISO(currentPeriod.start);
  const currentPeriodEndISO = formatDateISO(currentPeriod.end);

  const [shiftsResult, settingsResult, periodShiftsResult] = await Promise.all([
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
      .gte("clock_in", `${currentPeriodStartISO}T00:00:00`)
      .lte("clock_in", `${currentPeriodEndISO}T23:59:59`)
      .limit(2000),
  ]);

  if (myToken !== state.loadToken) return; // a newer call superseded this one

  const rows = shiftsResult.data || [];
  const settings = settingsResult.data || [];
  const currentPeriodShifts = periodShiftsResult.data || [];
  state.employeeSettings = settings; // share with employees tab

  const workShifts = rows.filter((s) => s.type === "work");
  const totalMin = workShifts.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const uniqueEmployees = [...new Set(rows.map((s) => s.user_name))];

  // Per-employee per-PERIOD OT calc — sums all work hours in the visible period and applies
  // threshold (default 80h) ONCE. Matches the company's actual payroll model.
  const settingsByName = {};
  settings.forEach((s) => { settingsByName[s.user_name] = s; });

  const otByEmployee = {};
  for (const s of settings) {
    if (s.employment_type !== "W2") continue;
    if (!isActive(s)) continue; // soft-deleted employees skip payroll
    const empShifts = rows.filter((r) => r.user_name === s.user_name && r.type === "work");
    const { regMin, otMin } = calculatePeriodOvertime(
      empShifts,
      s.overtime_threshold || 80,
      state.dashPeriod.start,
      state.dashPeriod.end,
    );
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

  // Lazy-load schedule once per session — used for forecast and heat map.
  if (!state.scheduleMap) {
    state.scheduleMap = await loadSchedule();
  }

  const now = new Date();

  // ============================================================================================
  // SECTION 1: Right Now
  // ============================================================================================

  const todayStr = now.toDateString();
  const todayMin = workShifts
    .filter((s) => new Date(s.clock_in).toDateString() === todayStr)
    .reduce((sum, s) => sum + effectiveShiftMinutes(s, now), 0);

  // Scheduled Today: cross-reference today's planned shifts (from CSV) with who's actually working.
  // Format: "8 planned · 5 working · 1 missing" — supervisor can see coverage at a glance.
  const todayISO = formatDateISO(now);
  const scheduledToday = state.scheduleMap?.get(todayISO);
  let coverageHtml;
  if (scheduledToday && scheduledToday.size > 0) {
    const scheduledNames = new Set(scheduledToday.keys());
    const actuallyWorkingScheduled = state.workingNames.filter((n) => scheduledNames.has(n));
    const startedToday = new Set(
      workShifts.filter((s) => new Date(s.clock_in).toDateString() === todayStr).map((s) => s.user_name)
    );
    const missing = [...scheduledNames].filter((n) => !startedToday.has(n) && !state.workingNames.includes(n));
    const planned = scheduledNames.size;
    const working = actuallyWorkingScheduled.length;
    const missingCount = missing.length;
    const missingHtml = missingCount > 0
      ? `<div class="dash-card-sub" title="${esc(missing.join(", "))}">${missingCount} missing: ${missing.slice(0, 3).map(esc).join(", ")}${missing.length > 3 ? "…" : ""}</div>`
      : `<div class="dash-card-sub">all on track</div>`;
    coverageHtml = `<div class="dash-card"><div class="dash-card-label">Scheduled Today</div><div class="dash-card-value accent-yellow">${planned} <span class="dash-card-fraction">· ${working} working</span></div>${missingHtml}</div>`;
  } else {
    coverageHtml = `<div class="dash-card"><div class="dash-card-label">Scheduled Today</div><div class="dash-card-value accent-gray">—</div><div class="dash-card-sub">no schedule for today</div></div>`;
  }

  $("#dash-now").innerHTML = `
    <div class="dash-card"><div class="dash-card-label">Working Now</div><div class="dash-card-value accent-green">${state.workingNames.length}</div><div class="dash-card-sub">of ${activeSettings.length} active</div></div>
    <div class="dash-card"><div class="dash-card-label">Today's Hours</div><div class="dash-card-value accent-blue">${Math.round(todayMin / 60)}h</div><div class="dash-card-sub">${todayStr.split(" ").slice(0, 3).join(" ")}</div></div>
    ${coverageHtml}`;

  // Right-Now alerts: open-shift-too-long, long completed shifts, soft-cap warnings (current period)
  const alerts = [];
  for (const s of settings) {
    if (s.employment_type !== "W2") continue;
    if (!isActive(s)) continue;
    const empPeriodMin = currentPeriodShifts
      .filter((r) => r.user_name === s.user_name)
      .reduce((sum, r) => sum + effectiveShiftMinutes(r, now), 0);
    const periodH = empPeriodMin / 60;
    const threshold = s.overtime_threshold || 80;
    const periodHRounded = Math.round(periodH * 10) / 10;
    if (periodH > SOFT_CAP_HOURS) {
      alerts.push({ type: "danger", icon: "🛑", text: `${esc(s.user_name)} over soft cap (${periodHRounded}h / ${SOFT_CAP_HOURS}h)` });
    } else if (periodH >= SOFT_CAP_HOURS - 20) {
      alerts.push({ type: "warn", icon: "⚠️", text: `${esc(s.user_name)} approaching soft cap (${periodHRounded}h / ${SOFT_CAP_HOURS}h)` });
    } else if (periodH > threshold) {
      const overH = Math.round((periodH - threshold) * 10) / 10;
      alerts.push({ type: "danger", icon: "💸", text: `${esc(s.user_name)} over OT (${periodHRounded}h, +${overH}h)` });
    } else if (periodH >= threshold - 8) {
      alerts.push({ type: "warn", icon: "⏳", text: `${esc(s.user_name)} approaching OT (${periodHRounded}h / ${threshold}h)` });
    }
  }
  workShifts.filter((s) => s.duration_minutes > 720).forEach((s) => {
    const h = Math.floor(s.duration_minutes / 60);
    const m = s.duration_minutes % 60;
    alerts.push({ type: "warn", icon: "⚠️", text: `${esc(s.user_name)} worked ${h}h ${m}m on ${formatDateShort(s.clock_in)}` });
  });
  rows.filter((s) => s.type === "work" && !s.clock_out && (now - new Date(s.clock_in)) / 60000 > 840).forEach((s) => {
    alerts.push({ type: "danger", icon: "🔴", text: `${esc(s.user_name)} has an open shift since ${formatDateShort(s.clock_in)} ${formatTimeShort(s.clock_in)}` });
  });
  $("#dash-alerts").innerHTML = alerts.length === 0
    ? '<div class="dash-alert-none">No anomalies — all good</div>'
    : alerts.map((a) => `<div class="dash-alert alert-${a.type}"><span class="dash-alert-icon">${a.icon}</span> ${a.text}</div>`).join("");

  // ============================================================================================
  // SECTION 2: Pay Period Status (cards + W2 employee table)
  // ============================================================================================

  let cardsHtml = `<div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${Math.round(totalMin / 60)}</div><div class="dash-card-sub">${rows.length} shifts</div></div>`;
  if (w2Count > 0) {
    const otH = Math.round(w2Total.otMin / 60 * 10) / 10;
    cardsHtml += `<div class="dash-card"><div class="dash-card-label">W2 Overtime</div><div class="dash-card-value ${otH > 0 ? "accent-pink" : "accent-gray"}">${otH}h</div><div class="dash-card-sub">${w2Count} W2 employees</div></div>`;
    if (isAdmin() && w2Total.hasRate && w2Total.payTotal > 0) {
      cardsHtml += `<div class="dash-card"><div class="dash-card-label">W2 Payroll Cost</div><div class="dash-card-value accent-yellow">${fmtMoney(w2Total.payTotal)}</div><div class="dash-card-sub">reg + OT (1.5×)</div></div>`;
    }
  }
  if (unsetCount > 0) {
    cardsHtml += `<div class="dash-card dash-card-action" id="dash-setup-nudge"><div class="dash-card-label">Setup</div><div class="dash-card-value accent-gray">${configuredCount}/${totalEmployees}</div><div class="dash-card-sub">${unsetCount} need W2/1099</div></div>`;
  }
  $("#dash-cards").innerHTML = cardsHtml;
  const nudge = $("#dash-setup-nudge");
  if (nudge) nudge.addEventListener("click", () => {
    document.querySelector(".tab[data-tab=\"employees\"]")?.click();
  });

  // Per-W2-employee table with progress bar + forecast
  const tableEl = $("#dash-period-table");
  const w2Rows = [];
  for (const s of settings) {
    if (s.employment_type !== "W2") continue;
    if (!isActive(s)) continue;
    const ot = otByEmployee[s.user_name] || { regMin: 0, otMin: 0 };
    const empTotalMin = ot.regMin + ot.otMin;
    const threshold = s.overtime_threshold || 80;
    const fc = forecastEmployeeHours({
      userName: s.user_name,
      actualMinutes: empTotalMin,
      periodStart: state.dashPeriod.start,
      periodEnd: state.dashPeriod.end,
      scheduleMap: state.scheduleMap,
      now,
    });
    w2Rows.push({ name: s.user_name, totalMin: empTotalMin, threshold, fc, ot, rate: Number(s.rate) || 0 });
  }
  // Sort by predicted hours descending (most-at-risk first)
  w2Rows.sort((a, b) => b.fc.predictedMin - a.fc.predictedMin);

  if (w2Rows.length === 0) {
    tableEl.innerHTML = '<div class="dash-alert-none">No W2 employees configured yet — set them up in the Employees tab</div>';
  } else {
    let tableHtml = `<table class="dash-pp-table">
      <thead><tr><th>Employee</th><th>Hours</th><th class="dash-pp-col-progress">Progress (0 → ${SOFT_CAP_HOURS}h cap)</th><th>Forecast end-of-period</th></tr></thead><tbody>`;
    for (const r of w2Rows) {
      const h = r.totalMin / 60;
      const predH = r.fc.predictedMin / 60;
      const pctOfCap = Math.min(100, (h / SOFT_CAP_HOURS) * 100);
      let zone = "ok";
      if (h > SOFT_CAP_HOURS) { zone = "cap"; }
      else if (h > r.threshold) { zone = "ot"; }
      else if (h >= r.threshold * 0.875) { zone = "near"; }

      let fcClass = "fc-ok";
      let fcSuffix = "";
      if (predH > SOFT_CAP_HOURS) { fcClass = "fc-cap"; fcSuffix = " ⚠ over cap"; }
      else if (predH > r.threshold) { fcClass = "fc-ot"; fcSuffix = " ⚠ OT"; }
      const fcBasisLabel = r.fc.basis === "schedule" ? "from schedule"
        : r.fc.basis === "mixed" ? "schedule + est"
        : r.fc.basis === "heuristic" ? "estimated"
        : "final";

      let payCell = "";
      if (isAdmin() && r.rate > 0) {
        const pay = (r.ot.regMin / 60) * r.rate + (r.ot.otMin / 60) * r.rate * 1.5;
        payCell = `<div class="dash-pp-pay">~$${Math.round(pay)}</div>`;
      }

      const otMarkerPct = (r.threshold / SOFT_CAP_HOURS) * 100;

      tableHtml += `<tr class="dash-pp-row dash-pp-zone-${zone}">
        <td class="dash-pp-name"><a href="#" data-emp="${esc(r.name)}">${esc(r.name)}</a></td>
        <td class="dash-pp-hours"><div class="dash-pp-hours-num">${Math.round(h * 10) / 10}h</div>${payCell}</td>
        <td class="dash-pp-progress">
          <div class="dash-pp-bar">
            <div class="dash-pp-fill dash-pp-fill-${zone}" style="width:${pctOfCap}%"></div>
            <span class="dash-pp-marker" title="OT threshold ${r.threshold}h" style="left:${otMarkerPct}%"></span>
          </div>
          <span class="dash-pp-bar-label">${Math.round(h)}h<span class="dash-pp-bar-mark"> · OT@${r.threshold}h · cap@${SOFT_CAP_HOURS}h</span></span>
        </td>
        <td class="dash-pp-forecast ${fcClass}">
          <div class="dash-pp-fc-num">${Math.round(predH * 10) / 10}h${fcSuffix}</div>
          <div class="dash-pp-fc-basis">${fcBasisLabel}</div>
        </td>
      </tr>`;
    }
    tableHtml += "</tbody></table>";
    tableEl.innerHTML = tableHtml;
    tableEl.querySelectorAll("a[data-emp]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelector(".tab[data-tab=\"employees\"]")?.click();
      });
    });
  }

  // ============================================================================================
  // SECTION 3: Period Heat Map — per-day planned + actual aggregated across team
  // ============================================================================================

  const hmEl = $("#dash-heatmap");
  const days = [];
  const dayCur = new Date(state.dashPeriod.start);
  const periodEnd = new Date(state.dashPeriod.end);
  while (dayCur <= periodEnd) {
    days.push(new Date(dayCur));
    dayCur.setDate(dayCur.getDate() + 1);
  }

  const actualByDay = {};
  workShifts.forEach((s) => {
    const iso = formatDateISO(new Date(s.clock_in));
    actualByDay[iso] = (actualByDay[iso] || 0) + (s.duration_minutes || 0);
  });
  const plannedByDay = {};
  if (state.scheduleMap) {
    days.forEach((d) => {
      const iso = formatDateISO(d);
      const dayMap = state.scheduleMap.get(iso);
      if (dayMap) {
        let sum = 0;
        for (const v of dayMap.values()) sum += v.planMinutes;
        plannedByDay[iso] = sum;
      }
    });
  }
  const hmMaxMin = Math.max(1, ...days.map((d) => {
    const iso = formatDateISO(d);
    return Math.max(actualByDay[iso] || 0, plannedByDay[iso] || 0);
  }));
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  hmEl.innerHTML = days.map((d) => {
    const iso = formatDateISO(d);
    const actual = actualByDay[iso] || 0;
    const planned = plannedByDay[iso] || 0;
    const dayName = dayNames[d.getDay()];
    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    const heat = isHeatDay(d);
    const actPct = Math.round((actual / hmMaxMin) * 100);
    const plnPct = Math.round((planned / hmMaxMin) * 100);
    const isPast = d < now && d.toDateString() !== now.toDateString();
    const isToday = d.toDateString() === now.toDateString();
    const tooltip = `${dayName} ${dayLabel}\nPlanned: ${Math.round(planned / 60 * 10) / 10}h\nActual: ${Math.round(actual / 60 * 10) / 10}h${heat ? "\n⚡ Expected high load (end/start of month)" : ""}`;
    const cellClass = ["dash-hm-cell"];
    if (heat) cellClass.push("dash-hm-heat");
    if (isToday) cellClass.push("dash-hm-today");
    if (isPast) cellClass.push("dash-hm-past");
    return `<div class="${cellClass.join(" ")}" title="${tooltip}">
      <div class="dash-hm-day">${dayName}</div>
      <div class="dash-hm-date">${dayLabel}</div>
      <div class="dash-hm-bars">
        <div class="dash-hm-planned" style="height:${plnPct}%"></div>
        <div class="dash-hm-actual" style="height:${actPct}%"></div>
      </div>
      <div class="dash-hm-hours">${Math.round(actual / 60)}h${planned > 0 ? `<span class="dash-hm-planned-label"> / ${Math.round(planned / 60)}h</span>` : ""}</div>
    </div>`;
  }).join("");
}
