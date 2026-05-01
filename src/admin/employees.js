import { state, isAdmin } from "./state.js";
import { $, $$, esc, formatDateISO, formatDateShort, formatTimeShort, showToast } from "./helpers.js";
import { calculateWeeklyOvertime } from "../payPeriods.js";

function minsToHm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Compute reg/OT split for an employee across the visible period.
// Returns null if employee is not active W2 (OT only applies to active W2 employees).
function computeOvertimeFor(name, shifts, employeeSettings, periodStart, periodEnd) {
  const settings = employeeSettings.find((e) => e.user_name === name);
  if (!settings || settings.employment_type !== "W2") return null;
  if (settings.active === false) return null; // soft-deleted employees: skip OT/payroll
  const threshold = settings.overtime_threshold || 40;
  const allBuckets = calculateWeeklyOvertime(shifts, threshold);
  const buckets = (periodStart && periodEnd)
    ? allBuckets.filter((b) => b.weekEnd >= periodStart && b.weekStart <= periodEnd)
    : allBuckets;
  const totalReg = buckets.reduce((sum, b) => sum + b.regMin, 0);
  const totalOt = buckets.reduce((sum, b) => sum + b.otMin, 0);
  return { regMin: totalReg, otMin: totalOt, threshold, buckets };
}

// --- Employees Tab ---

export async function loadEmployeesTab() {
  if (!state.supabase || !state.dashPeriod) return;

  // Guard against stale results from rapid period changes
  const myToken = ++state.loadToken;

  const startISO = formatDateISO(state.dashPeriod.start);
  const endISO = formatDateISO(state.dashPeriod.end);

  const [settingsResult, shiftsResult] = await Promise.all([
    state.supabase.from("tt_employee_settings").select("*"),
    state.supabase
      .from("tt_shifts")
      .select("user_name, clock_in, duration_minutes, type")
      .gte("clock_in", `${startISO}T00:00:00`)
      .lte("clock_in", `${endISO}T23:59:59`)
      .limit(5000),
  ]);

  if (myToken !== state.loadToken) return;

  state.employeeSettings = settingsResult.data || [];
  const rows = shiftsResult.data || [];

  // Aggregate per employee + keep raw shifts for OT calc
  const empStats = {};
  const empShifts = {};
  rows.forEach((s) => {
    if (!empStats[s.user_name]) {
      empStats[s.user_name] = { hours: 0, shifts: 0, workShifts: 0 };
      empShifts[s.user_name] = [];
    }
    empStats[s.user_name].shifts++;
    empShifts[s.user_name].push(s);
    if (s.type === "work") {
      empStats[s.user_name].hours += s.duration_minutes || 0;
      empStats[s.user_name].workShifts++;
    }
  });

  // Build warehouse map
  const whMap = {};
  state.employeeSettings.forEach((es) => {
    whMap[es.user_name] = es.warehouse || "Unassigned";
  });

  // Group by warehouse
  const allNames = [...new Set([...Object.keys(empStats), ...state.employeeSettings.map((e) => e.user_name)])].sort();
  const groups = {};
  allNames.forEach((name) => {
    const wh = whMap[name] || "Unassigned";
    if (!groups[wh]) groups[wh] = [];
    groups[wh].push(name);
  });

  // Populate warehouse filter (preserve selection)
  const filterEl = $("#emp-warehouse-filter");
  const savedFilter = filterEl.value;
  while (filterEl.options.length > 1) filterEl.remove(1);
  Object.keys(groups).sort().forEach((wh) => {
    const opt = document.createElement("option");
    opt.value = wh;
    opt.textContent = wh;
    filterEl.appendChild(opt);
  });
  if (savedFilter) filterEl.value = savedFilter;
  const filterWh = filterEl.value;

  // Render
  const listEl = $("#emp-list");
  let html = "";

  const sortedGroups = Object.keys(groups).sort();
  sortedGroups.forEach((wh) => {
    if (filterWh && filterWh !== wh) return;
    html += `<div class="emp-wh-group"><div class="emp-wh-header">${esc(wh)}</div>`;
    groups[wh].forEach((name) => {
      const stats = empStats[name] || { hours: 0, shifts: 0, workShifts: 0 };
      const totalH = Math.round(stats.hours / 60);
      const avg = stats.workShifts > 0 ? Math.round(stats.hours / stats.workShifts / 60 * 10) / 10 : 0;
      const target = stats.workShifts * 480; // 8h per shift
      const pct = target > 0 ? Math.min(150, Math.round((stats.hours / target) * 100)) : 0;
      const isWorking = state.workingNames.includes(name);
      const progressClass = pct > 120 ? "way-over" : pct > 100 ? "over" : "";

      const settings = state.employeeSettings.find((e) => e.user_name === name);
      const isInactive = settings && settings.active === false;
      const empType = settings?.employment_type || "";
      const typeBadge = empType ? `<span class="emp-type-badge emp-type-${empType.toLowerCase()}">${esc(empType)}</span>` : "";

      // Overtime: only W2, only if there's any OT in the visible period
      const ot = computeOvertimeFor(name, empShifts[name] || [], state.employeeSettings, state.dashPeriod.start, state.dashPeriod.end);
      let otBadge = "";
      if (ot && ot.otMin > 0) {
        const otH = Math.round(ot.otMin / 60 * 10) / 10;
        // Pay info in tooltip: admin only
        let payHint = "";
        if (isAdmin() && settings?.rate) {
          const otPay = (ot.otMin / 60) * Number(settings.rate) * 1.5;
          payHint = ` ($${otPay.toFixed(0)})`;
        }
        otBadge = `<div class="emp-stat emp-stat-ot" title="Weekly hours over ${ot.threshold}h${payHint ? ` · 1.5× rate${payHint}` : ""}"><div class="emp-stat-value">${otH}h</div><div class="emp-stat-label">OT</div></div>`;
      }

      html += `<div class="emp-card${isInactive ? " emp-inactive" : ""}" data-name="${esc(name)}">
        <div class="emp-card-name"><span class="emp-status-dot ${isWorking ? "online" : "offline"}"></span>${esc(name)}${typeBadge}</div>
        <div class="emp-stat"><div class="emp-stat-value">${totalH}h</div><div class="emp-stat-label">Hours</div></div>
        ${otBadge}
        <div class="emp-stat"><div class="emp-stat-value">${stats.shifts}</div><div class="emp-stat-label">Shifts</div></div>
        <div class="emp-stat"><div class="emp-stat-value">${avg}h</div><div class="emp-stat-label">Avg</div></div>
        <div class="emp-progress-wrap"><div class="emp-progress-bar"><div class="emp-progress-fill ${progressClass}" style="width:${Math.min(100, pct)}%"></div></div></div>
        <button class="emp-edit-btn" data-edit-name="${esc(name)}" title="Edit employee settings" aria-label="Edit ${esc(name)}">&#9881;</button>
      </div>`;
    });
    html += "</div>";
  });

  listEl.innerHTML = html;

  // Attach click handlers
  listEl.querySelectorAll(".emp-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      // Don't drill down if user clicked the edit button
      if (e.target.closest(".emp-edit-btn")) return;
      showEmployeeDetail(card.dataset.name);
    });
  });

  // Edit-button handlers (event delegation via direct binding to keep scope tight)
  listEl.querySelectorAll(".emp-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEmployeeEditModal(btn.dataset.editName);
    });
  });

  // Filter change
  filterEl.onchange = () => loadEmployeesTab();

  // Ensure list visible, detail hidden
  listEl.classList.remove("hidden");
  $("#emp-detail").classList.add("hidden");
}

async function showEmployeeDetail(name) {
  if (!state.supabase || !state.dashPeriod) return;

  const startISO = formatDateISO(state.dashPeriod.start);
  const endISO = formatDateISO(state.dashPeriod.end);

  const [shiftsResult, editsResult] = await Promise.all([
    state.supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, duration_minutes, type, comment")
      .eq("user_name", name)
      .gte("clock_in", `${startISO}T00:00:00`)
      .lte("clock_in", `${endISO}T23:59:59`)
      .order("clock_in", { ascending: true }),
    state.supabase
      .from("tt_edits")
      .select("shift_id")
      .gte("created_at", `${startISO}T00:00:00`)
      .lte("created_at", `${endISO}T23:59:59`),
  ]);

  const shifts = shiftsResult.data || [];
  const editsCount = editsResult.data ? editsResult.data.length : 0;

  // Summary
  const workShifts = shifts.filter((s) => s.type === "work");
  const totalMin = workShifts.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const totalH = Math.floor(totalMin / 60);
  const totalM = totalMin % 60;
  const avg = workShifts.length > 0 ? Math.round(totalMin / workShifts.length / 60 * 10) / 10 : 0;

  // Overtime (W2 only) — period-bounded so Reg + OT == Total Hours visible.
  // Note: workweeks split by the period boundary may show slightly low OT (≤5h typical);
  // this is the simple/intuitive trade-off and matches what most small payroll runs do.
  const ot = computeOvertimeFor(name, workShifts, state.employeeSettings, state.dashPeriod.start, state.dashPeriod.end);
  const settings = state.employeeSettings.find((e) => e.user_name === name) || {};
  let otCard = "";
  if (ot) {
    const otH = Math.round(ot.otMin / 60 * 10) / 10;
    const regH = Math.round(ot.regMin / 60 * 10) / 10;
    let payLine = "";
    // Pay totals: admin only — supervisors see hours, not money
    if (isAdmin() && settings.rate) {
      const regPay = (ot.regMin / 60) * Number(settings.rate);
      const otPay = (ot.otMin / 60) * Number(settings.rate) * 1.5;
      const total = regPay + otPay;
      payLine = `<div class="dash-card-sub">~$${total.toFixed(0)} ($${regPay.toFixed(0)} reg + $${otPay.toFixed(0)} OT)</div>`;
    }
    otCard = `<div class="dash-card"><div class="dash-card-label">Reg / OT (W2)</div><div class="dash-card-value accent-yellow">${regH}h / ${otH}h</div>${payLine}</div>`;
  }

  // Header with employment type badge and period label
  const empTypeBadge = settings.employment_type
    ? `<span class="emp-detail-type-badge type-${settings.employment_type.toLowerCase()}">${esc(settings.employment_type)}</span>`
    : "";
  $("#emp-detail-name").innerHTML = `${esc(name)}${empTypeBadge}`;
  $("#emp-detail-period").textContent = state.dashPeriod.label || "";

  $("#emp-detail-cards").innerHTML = `
    <div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${totalH}h ${totalM}m</div></div>
    <div class="dash-card"><div class="dash-card-label">Shifts</div><div class="dash-card-value accent-pink">${shifts.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Avg Shift</div><div class="dash-card-value accent-green">${avg}h</div></div>
    ${otCard}
    <div class="dash-card"><div class="dash-card-label">Edits</div><div class="dash-card-value accent-yellow">${editsCount}</div></div>
  `;

  // Weekly breakdown — only meaningful when period spans 2+ workweeks
  const weekWrap = $("#emp-detail-week-wrap");
  const weekHost = $("#emp-detail-week");
  if (ot && ot.buckets.length >= 2) {
    // Pay column: admin only
    const hasPay = isAdmin() && !!settings.rate;
    let html = `<table class="emp-week-table"><thead><tr><th>Week of</th><th>Total</th><th>Regular</th><th>Overtime</th>${hasPay ? "<th>Pay</th>" : ""}</tr></thead><tbody>`;
    ot.buckets.forEach((b) => {
      const totalHs = minsToHm(b.totalMin);
      const regHs = minsToHm(b.regMin);
      const otHs = b.otMin > 0 ? minsToHm(b.otMin) : "—";
      const otClass = b.otMin > 0 ? "ot-positive" : "";
      let payCell = "";
      if (hasPay) {
        const reg = (b.regMin / 60) * Number(settings.rate);
        const otPay = (b.otMin / 60) * Number(settings.rate) * 1.5;
        payCell = `<td>$${(reg + otPay).toFixed(0)}</td>`;
      }
      html += `<tr class="${otClass}"><td>${b.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td><td>${totalHs}</td><td>${regHs}</td><td>${otHs}</td>${payCell}</tr>`;
    });
    html += "</tbody></table>";
    weekHost.innerHTML = html;
    weekWrap.style.display = "";
  } else {
    weekWrap.style.display = "none";
    weekHost.innerHTML = "";
  }

  // Day-by-day table
  const shiftsByDate = {};
  shifts.forEach((s) => {
    const key = new Date(s.clock_in).toDateString();
    if (!shiftsByDate[key]) shiftsByDate[key] = [];
    shiftsByDate[key].push(s);
  });

  // Generate all dates in period
  const allDates = [];
  const cur = new Date(state.dashPeriod.start);
  const endDate = new Date(state.dashPeriod.end);
  while (cur <= endDate) {
    allDates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let tableHtml = `<table class="emp-day-table"><thead><tr><th>Date</th><th>Day</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th></tr></thead><tbody>`;

  allDates.forEach((d) => {
    const key = d.toDateString();
    const dayShifts = shiftsByDate[key];

    if (!dayShifts || dayShifts.length === 0) {
      tableHtml += `<tr class="no-data">
        <td>${formatDateShort(d.toISOString())}</td>
        <td>${dayNames[d.getDay()]}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td>
      </tr>`;
      return;
    }

    dayShifts.forEach((s) => {
      let rowClass = "";
      let statusLabel = "Work";
      if (s.type === "day_off") { rowClass = "day-off"; statusLabel = "Day Off"; }
      else if (s.type === "paid_off") { rowClass = "paid-off"; statusLabel = "Paid Off"; }

      const min = s.duration_minutes || 0;
      const h = Math.floor(min / 60);
      const m = min % 60;
      const hoursStr = min > 0 ? `${h}h ${m}m` : "—";

      // Bar
      let barClass = "bar-green";
      let barWidth = 0;
      if (s.type === "work" && min > 0) {
        barWidth = Math.min(100, Math.round((min / 720) * 100)); // 12h = 100%
        if (min > 600) barClass = "bar-red";
        else if (min >= 480) barClass = "bar-yellow";
      }

      tableHtml += `<tr class="${rowClass}">
        <td>${formatDateShort(s.clock_in)}</td>
        <td>${dayNames[d.getDay()]}</td>
        <td>${statusLabel}</td>
        <td>${formatTimeShort(s.clock_in)}</td>
        <td>${s.clock_out ? formatTimeShort(s.clock_out) : "—"}</td>
        <td>${hoursStr}${barWidth > 0 ? ` <span class="emp-hour-bar ${barClass}" style="width:${barWidth}px"></span>` : ""}</td>
      </tr>`;
    });
  });

  tableHtml += "</tbody></table>";
  $("#emp-detail-table").innerHTML = tableHtml;

  // Show detail, hide list
  $("#emp-list").classList.add("hidden");
  $("#emp-detail").classList.remove("hidden");
  // If we're already showing a different employee's detail, replace history (don't stack).
  // Otherwise push so browser Back returns to the list.
  if (window.history.state?.empDetail) {
    window.history.replaceState({ empDetail: name }, "", `#employee-${encodeURIComponent(name)}`);
  } else {
    window.history.pushState({ empDetail: name }, "", `#employee-${encodeURIComponent(name)}`);
  }
}

export function hideEmployeeDetail() {
  $("#emp-detail").classList.add("hidden");
  $("#emp-list").classList.remove("hidden");
  // Go back in history if we pushed a state
  if (window.history.state?.empDetail) {
    window.history.back();
  }
}

// Handle browser back button / swipe
window.addEventListener("popstate", (e) => {
  if ($("#emp-detail") && !$("#emp-detail").classList.contains("hidden")) {
    $("#emp-detail").classList.add("hidden");
    $("#emp-list").classList.remove("hidden");
  }
});

// --- Employee Edit Modal ---

function getEditOriginal() {
  return state.empEditOriginal || {};
}

function trackEmpEditChanges() {
  const orig = getEditOriginal();
  const current = readEmpEditForm();
  const changed = Object.keys(current).some((k) => current[k] !== orig[k]);
  $("#emp-edit-save").disabled = !changed;
}

function readEmpEditForm() {
  const rateRaw = $("#emp-edit-rate").value.trim();
  return {
    warehouse: $("#emp-edit-warehouse").value,
    employment_type: $("#emp-edit-employment-type").value || null,
    rate: rateRaw === "" ? null : Number(rateRaw),
    pay_period_type: $("#emp-edit-pay-period").value,
    overtime_threshold: Number($("#emp-edit-ot-threshold").value) || 40,
    active: $("#emp-edit-active").checked,
  };
}

function openEmployeeEditModal(name) {
  const settings = state.employeeSettings.find((e) => e.user_name === name) || {};

  $("#emp-edit-name").textContent = name;
  $("#emp-edit-warehouse").value = settings.warehouse || "Maspeth";
  $("#emp-edit-employment-type").value = settings.employment_type || "";
  $("#emp-edit-rate").value = settings.rate != null ? settings.rate : "";
  $("#emp-edit-pay-period").value = settings.pay_period_type || "semi_monthly";
  $("#emp-edit-ot-threshold").value = settings.overtime_threshold != null ? settings.overtime_threshold : 40;
  $("#emp-edit-active").checked = settings.active !== false; // default true if missing

  // Hide rate field for supervisors — admin-only data
  const rateLabel = $("#emp-edit-rate")?.closest("label");
  if (rateLabel) rateLabel.style.display = isAdmin() ? "" : "none";

  state.empEditOriginal = readEmpEditForm();
  state.empEditTargetName = name;
  $("#emp-edit-save").disabled = true;

  $("#emp-edit-modal").classList.remove("hidden");
  $("#emp-edit-overlay").classList.remove("hidden");
}

function closeEmployeeEditModal() {
  $("#emp-edit-modal").classList.add("hidden");
  $("#emp-edit-overlay").classList.add("hidden");
  state.empEditOriginal = null;
  state.empEditTargetName = null;
}

async function saveEmployeeEdit() {
  if (!state.supabase || !state.empEditTargetName) return;

  const name = state.empEditTargetName;
  const data = readEmpEditForm();

  // Supervisors cannot change pay rate — strip it from the upsert payload
  // (UI hides the field, but be defensive in case it leaks through)
  if (!isAdmin()) {
    delete data.rate;
  }

  if (data.rate != null && (Number.isNaN(data.rate) || data.rate < 0)) {
    showToast("Rate must be 0 or positive (or empty)");
    return;
  }
  if (Number.isNaN(data.overtime_threshold) || data.overtime_threshold < 1 || data.overtime_threshold > 168) {
    showToast("Overtime threshold must be 1-168");
    return;
  }

  const saveBtn = $("#emp-edit-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  const { error } = await state.supabase
    .from("tt_employee_settings")
    .upsert({ user_name: name, ...data }, { onConflict: "user_name" });

  saveBtn.textContent = "Save";

  if (error) {
    showToast(`Save failed: ${error.message}`);
    saveBtn.disabled = false;
    return;
  }

  showToast(`Saved ${name}`);
  closeEmployeeEditModal();
  await loadEmployeesTab();
}

export function setupEmployeeEditListeners() {
  $("#emp-edit-cancel").addEventListener("click", closeEmployeeEditModal);
  $("#emp-edit-overlay").addEventListener("click", closeEmployeeEditModal);
  $("#emp-edit-save").addEventListener("click", saveEmployeeEdit);

  const fields = [
    "#emp-edit-warehouse",
    "#emp-edit-employment-type",
    "#emp-edit-rate",
    "#emp-edit-pay-period",
    "#emp-edit-ot-threshold",
    "#emp-edit-active",
  ];
  fields.forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", trackEmpEditChanges);
    el.addEventListener("change", trackEmpEditChanges);
  });
}
