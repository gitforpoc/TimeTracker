import { state } from "./state.js";
import { $, esc, formatDateISO, formatDateShort, formatTimeShort } from "./helpers.js";

// --- Employees Tab ---

export async function loadEmployeesTab() {
  if (!state.supabase || !state.dashPeriod) return;

  // Load employee settings
  const { data: settings } = await state.supabase.from("tt_employee_settings").select("*");
  state.employeeSettings = settings || [];

  const startISO = formatDateISO(state.dashPeriod.start);
  const endISO = formatDateISO(state.dashPeriod.end);

  const { data: shifts } = await state.supabase
    .from("tt_shifts")
    .select("user_name, duration_minutes, type")
    .gte("clock_in", `${startISO}T00:00:00`)
    .lte("clock_in", `${endISO}T23:59:59`)
    .limit(5000);

  const rows = shifts || [];

  // Aggregate per employee
  const empStats = {};
  rows.forEach((s) => {
    if (!empStats[s.user_name]) {
      empStats[s.user_name] = { hours: 0, shifts: 0, workShifts: 0 };
    }
    empStats[s.user_name].shifts++;
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

      html += `<div class="emp-card" data-name="${esc(name)}">
        <div class="emp-card-name"><span class="emp-status-dot ${isWorking ? "online" : "offline"}"></span>${esc(name)}</div>
        <div class="emp-stat"><div class="emp-stat-value">${totalH}h</div><div class="emp-stat-label">Hours</div></div>
        <div class="emp-stat"><div class="emp-stat-value">${stats.shifts}</div><div class="emp-stat-label">Shifts</div></div>
        <div class="emp-stat"><div class="emp-stat-value">${avg}h</div><div class="emp-stat-label">Avg</div></div>
        <div class="emp-progress-wrap"><div class="emp-progress-bar"><div class="emp-progress-fill ${progressClass}" style="width:${Math.min(100, pct)}%"></div></div></div>
      </div>`;
    });
    html += "</div>";
  });

  listEl.innerHTML = html;

  // Attach click handlers
  listEl.querySelectorAll(".emp-card").forEach((card) => {
    card.addEventListener("click", () => showEmployeeDetail(card.dataset.name));
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

  $("#emp-detail-name").innerHTML = `${esc(name)}`;
  $("#emp-detail-cards").innerHTML = `
    <div class="dash-card"><div class="dash-card-label">Total Hours</div><div class="dash-card-value accent-blue">${totalH}h ${totalM}m</div></div>
    <div class="dash-card"><div class="dash-card-label">Shifts</div><div class="dash-card-value accent-pink">${shifts.length}</div></div>
    <div class="dash-card"><div class="dash-card-label">Avg Shift</div><div class="dash-card-value accent-green">${avg}h</div></div>
    <div class="dash-card"><div class="dash-card-label">Edits</div><div class="dash-card-value accent-yellow">${editsCount}</div></div>
  `;

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
}

export function hideEmployeeDetail() {
  $("#emp-detail").classList.add("hidden");
  $("#emp-list").classList.remove("hidden");
}
