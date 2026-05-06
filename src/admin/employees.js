import { state, isAdmin } from "./state.js";
import { $, $$, esc, formatDateISO, formatDateShort, formatTimeShort, showToast } from "./helpers.js";
import { calculatePeriodOvertime } from "../payPeriods.js";

function minsToHm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const FIELD_LABELS = {
  clock_in: "Clock In",
  clock_out: "Clock Out",
  duration_minutes: "Duration",
  type: "Type",
  comment: "Comment",
};

function formatEditValue(field, value) {
  if (value == null || value === "") return "—";
  if (field === "clock_in" || field === "clock_out") {
    const d = new Date(value);
    if (isNaN(d.getTime())) return esc(String(value));
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (field === "duration_minutes") {
    const n = Number(value);
    return Number.isFinite(n) ? minsToHm(n) : esc(String(value));
  }
  return esc(String(value));
}

function renderEditsList(edits, shiftsById) {
  const host = $("#emp-detail-edits");
  if (!edits.length) {
    host.innerHTML = '<div class="dash-alert-none">No edits in this period</div>';
    return;
  }
  let html = `<table class="emp-edits-table"><thead><tr>
    <th>When</th>
    <th>Shift</th>
    <th>Field</th>
    <th>Old → New</th>
    <th>By</th>
    <th>Reason</th>
  </tr></thead><tbody>`;
  for (const e of edits) {
    const editedAt = new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const shift = shiftsById[e.shift_id];
    const shiftLabel = shift
      ? new Date(shift.clock_in).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : `#${e.shift_id}`;
    const fieldLabel = FIELD_LABELS[e.field_changed] || e.field_changed;
    const oldFmt = formatEditValue(e.field_changed, e.old_value);
    const newFmt = formatEditValue(e.field_changed, e.new_value);
    const reason = e.reason ? esc(e.reason) : '<span class="dash-alert-none-inline">—</span>';
    html += `<tr>
      <td>${editedAt}</td>
      <td>${shiftLabel}</td>
      <td>${esc(fieldLabel)}</td>
      <td><span class="edit-old">${oldFmt}</span> → <span class="edit-new">${newFmt}</span></td>
      <td>${esc(e.edited_by_name || "—")}</td>
      <td class="edit-reason">${reason}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  host.innerHTML = html;
}

// Compute reg/OT split for an employee across the visible pay period.
// Returns null if employee is not active W2 (OT only applies to active W2 employees).
function computeOvertimeFor(name, shifts, employeeSettings, periodStart, periodEnd) {
  const settings = employeeSettings.find((e) => e.user_name === name);
  if (!settings || settings.employment_type !== "W2") return null;
  if (settings.active === false) return null; // soft-deleted employees: skip OT/payroll
  const threshold = settings.overtime_threshold || 80;
  const { regMin, otMin, totalMin } = calculatePeriodOvertime(shifts, threshold, periodStart, periodEnd);
  return { regMin, otMin, totalMin, threshold };
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

  // Switch-panel render: dense ops-console rows grouped by warehouse, with ⨯⨯ markers
  // for unconfigured fields (the visual primary signal that someone needs setup).
  const PERIOD_SHORT = { bi_weekly: "BIWK", semi_monthly: "SEMI", weekly: "WK" };
  const UNSET = '<span class="emp-cfg-unset">⨯⨯</span>';

  const sortedGroups = Object.keys(groups).sort();
  sortedGroups.forEach((wh) => {
    if (filterWh && filterWh !== wh) return;

    // Count set vs warn per warehouse for the header chip.
    const total = groups[wh].length;
    const setCount = groups[wh].filter((n) => {
      const s = state.employeeSettings.find((e) => e.user_name === n);
      return s && s.employment_type;
    }).length;
    const warnCount = total - setCount;

    html += `<section class="emp-wh-group">
      <header class="emp-wh-header">
        <h3 class="emp-wh-name">${esc(wh)}</h3>
        <div class="emp-wh-counter">
          <span class="emp-wh-counter-total">${total}</span>
          <span class="emp-wh-counter-sep">▸</span>
          <span class="emp-wh-counter-set">${setCount} cfg</span>
          ${warnCount > 0 ? `<span class="emp-wh-counter-divider">│</span><span class="emp-wh-counter-warn">${warnCount} ⚠</span>` : ""}
        </div>
      </header>
      <div class="emp-wh-rows">`;

    groups[wh].forEach((name) => {
      const isWorking = state.workingNames.includes(name);
      const settings = state.employeeSettings.find((e) => e.user_name === name);
      const isInactive = settings && settings.active === false;
      const empType = settings?.employment_type || null;
      const isUnset = !empType;

      const typeCell = empType
        ? `<span class="emp-cfg emp-cfg-type emp-cfg-type-${empType.toLowerCase()}">${esc(empType)}</span>`
        : UNSET;
      const periodCell = empType
        ? `<span class="emp-cfg emp-cfg-period">${PERIOD_SHORT[settings?.pay_period_type] || "SEMI"}</span>`
        : UNSET;
      const thresholdCell = empType
        ? `<span class="emp-cfg emp-cfg-threshold">${settings?.overtime_threshold || 80}h</span>`
        : UNSET;
      const rateCell = isAdmin() && settings?.rate
        ? `<span class="emp-cfg emp-cfg-rate">$${settings.rate}</span>`
        : `<span class="emp-cfg emp-cfg-rate-unset">$—</span>`;

      const editBtn = isUnset
        ? `<button class="emp-row-edit emp-row-edit-warn" data-edit-name="${esc(name)}" title="Configure ${esc(name)}">⚠ CONFIGURE</button>`
        : `<button class="emp-row-edit" data-edit-name="${esc(name)}" title="Edit ${esc(name)}" aria-label="Edit ${esc(name)}">⚙</button>`;

      const rowClasses = ["emp-row"];
      if (isUnset) rowClasses.push("emp-row-unset");
      if (isInactive) rowClasses.push("emp-row-inactive");
      if (isWorking) rowClasses.push("emp-row-working");

      html += `<div class="${rowClasses.join(" ")}" data-name="${esc(name)}">
        <span class="emp-row-status" aria-label="${isWorking ? "working" : "offline"}">${isWorking ? "▮" : "▯"}</span>
        <span class="emp-row-name">${esc(name)}</span>
        <span class="emp-row-divider" aria-hidden="true">│</span>
        <span class="emp-row-config">
          ${typeCell}<span class="emp-cfg-sep" aria-hidden="true">▪</span>${periodCell}<span class="emp-cfg-sep" aria-hidden="true">▪</span>${thresholdCell}<span class="emp-cfg-sep" aria-hidden="true">▪</span>${rateCell}
        </span>
        <span class="emp-row-divider" aria-hidden="true">│</span>
        <span class="emp-row-active emp-row-active-${isInactive ? "off" : "on"}">${isInactive ? "OFF" : "ON"}</span>
        ${editBtn}
      </div>`;
    });

    html += "</div></section>";
  });

  listEl.innerHTML = html;

  // Row click → drill into employee detail (Day-by-Day, Edit History, etc.)
  listEl.querySelectorAll(".emp-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      // Don't drill down if user clicked the edit / configure button
      if (e.target.closest(".emp-row-edit")) return;
      showEmployeeDetail(row.dataset.name);
    });
  });

  // Edit / configure button → open modal
  listEl.querySelectorAll(".emp-row-edit").forEach((btn) => {
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

  // Step 1: fetch this employee's shifts in the period
  const { data: shiftsData } = await state.supabase
    .from("tt_shifts")
    .select("id, clock_in, clock_out, duration_minutes, type, comment")
    .eq("user_name", name)
    .gte("clock_in", `${startISO}T00:00:00`)
    .lte("clock_in", `${endISO}T23:59:59`)
    .order("clock_in", { ascending: true });

  const shifts = shiftsData || [];

  // Step 2: fetch edits filtered to ONLY this employee's shifts (not all edits in period)
  const shiftIds = shifts.map((s) => s.id);
  let editsList = [];
  if (shiftIds.length > 0) {
    const { data: editsData } = await state.supabase
      .from("tt_edits")
      .select("id, shift_id, field_changed, old_value, new_value, edited_by_name, reason, created_at")
      .in("shift_id", shiftIds)
      .order("created_at", { ascending: false });
    editsList = editsData || [];
  }
  const editsCount = editsList.length;
  // Make available to the renderer below
  state.employeeEditsList = editsList;
  state.employeeShiftsByIdForEdits = Object.fromEntries(shifts.map((s) => [s.id, s]));

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

  // Edits card: clickable when count > 0 — toggles the edit-history section below
  const editsCardClass = editsCount > 0 ? "dash-card dash-card-action" : "dash-card";
  const editsCardId = editsCount > 0 ? ' id="emp-detail-edits-toggle"' : "";
  const editsHint = editsCount > 0 ? '<div class="dash-card-sub">Click to view</div>' : "";

  $("#emp-detail-cards").innerHTML = `
    <div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${totalH}h ${totalM}m</div></div>
    <div class="dash-card"><div class="dash-card-label">Shifts</div><div class="dash-card-value accent-pink">${shifts.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Avg Shift</div><div class="dash-card-value accent-green">${avg}h</div></div>
    ${otCard}
    <div class="${editsCardClass}"${editsCardId}><div class="dash-card-label">Edits</div><div class="dash-card-value accent-yellow">${editsCount}</div>${editsHint}</div>
  `;

  // Wire toggle for edits section
  if (editsCount > 0) {
    const toggleBtn = $("#emp-detail-edits-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const wrap = $("#emp-detail-edits-wrap");
        const isHidden = wrap.style.display === "none" || wrap.style.display === "";
        if (isHidden) {
          renderEditsList(editsList, state.employeeShiftsByIdForEdits);
          wrap.style.display = "block";
          wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          wrap.style.display = "none";
        }
      });
    }
  } else {
    $("#emp-detail-edits-wrap").style.display = "none";
  }

  // (Weekly breakdown removed — company computes OT per pay period, not per workweek.)

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
    overtime_threshold: Number($("#emp-edit-ot-threshold").value) || 80,
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
  $("#emp-edit-ot-threshold").value = settings.overtime_threshold != null ? settings.overtime_threshold : 80;
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
