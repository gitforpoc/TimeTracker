import { state, isAdmin } from "./state.js";
import { $, esc, showToast, goToShiftLogForEmployee } from "./helpers.js";

// --- Employees Tab ---

export async function loadEmployeesTab() {
  if (!state.supabase) return;

  // Guard against stale results from rapid period changes (still used to coordinate with
  // dashboard reloads that share state.loadToken).
  const myToken = ++state.loadToken;

  // Switch-panel employees view is purely about config — no per-period stats. Single
  // tt_employee_settings query is enough; shift data lives in the Shift Log tab.
  const { data: settingsData } = await state.supabase.from("tt_employee_settings").select("*");

  if (myToken !== state.loadToken) return;

  state.employeeSettings = settingsData || [];

  // Build warehouse map + group employees by warehouse
  const whMap = {};
  state.employeeSettings.forEach((es) => {
    whMap[es.user_name] = es.warehouse || "Unassigned";
  });
  const allNames = state.employeeSettings.map((e) => e.user_name).sort();
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

  // Row click → jump to Shift Log filtered to this employee. Edit/configure button stops
  // propagation so it opens the modal instead.
  listEl.querySelectorAll(".emp-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".emp-row-edit")) return;
      goToShiftLogForEmployee(row.dataset.name);
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
  listEl.classList.remove("hidden");
}

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
