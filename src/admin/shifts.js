import { state } from "./state.js";
import { $, $$, esc, formatDateShort, formatTimeShort, showToast } from "./helpers.js";
import { getZoneColor, geoIcon, geoZoneLabel } from "./geo.js";

// --- Shifts ---
export function setupFilters() {
  $("#apply-filters").addEventListener("click", () => {
    state.currentPage = 0;
    loadShifts();
  });
  $("#copy-table").addEventListener("click", copyShiftsTable);
  $("#prev-page").addEventListener("click", () => {
    if (state.currentPage > 0) {
      state.currentPage--;
      renderShifts();
    }
  });
  $("#next-page").addEventListener("click", () => {
    const maxPage = Math.floor((state.shiftsData.length - 1) / state.PAGE_SIZE);
    if (state.currentPage < maxPage) {
      state.currentPage++;
      renderShifts();
    }
  });
}

export async function loadShifts() {
  const start = $("#filter-start").value;
  const end = $("#filter-end").value;
  const employee = $("#filter-employee").value;
  const warehouse = ($("#filter-warehouse") || {}).value;

  if (!start || !end) return;

  // Show loading
  const loading = $("#shifts-loading");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const empty = $("#shifts-empty");
  const pagination = $(".pagination");

  loading.classList.remove("hidden");
  table.style.opacity = "0.4";
  cards.style.opacity = "0.4";
  empty.classList.add("hidden");

  // Resolve warehouse → employee names
  let warehouseNames = null;
  if (warehouse && !employee) {
    const { data: settings } = await state.supabase
      .from("tt_employee_settings")
      .select("user_name")
      .eq("warehouse", warehouse);
    warehouseNames = settings ? settings.map((s) => s.user_name) : [];
  }

  let query = state.supabase
    .from("tt_shifts")
    .select("id, user_name, clock_in, clock_out, duration_minutes, type, comment")
    .gte("clock_in", `${start}T00:00:00`)
    .lte("clock_in", `${end}T23:59:59`)
    .order("clock_in", { ascending: false })
    .limit(5000);

  if (employee === "__working__") {
    if (state.workingNames.length > 0) {
      query = query.in("user_name", state.workingNames);
    } else {
      state.shiftsData = [];
      loading.classList.add("hidden");
      table.style.opacity = "1";
      cards.style.opacity = "1";
      renderShifts();
      return;
    }
  } else if (employee) {
    query = query.eq("user_name", employee);
  } else if (warehouseNames && warehouseNames.length > 0) {
    query = query.in("user_name", warehouseNames);
  }

  const { data, error } = await query;

  loading.classList.add("hidden");
  table.style.opacity = "1";
  cards.style.opacity = "1";

  if (error) {
    console.error("Shifts error:", error);
    return;
  }

  state.shiftsData = data || [];
  state.currentPage = 0;

  // Load edit history + geo data for these shifts
  state.editsMap = {};
  state.geoMap = {};
  if (state.shiftsData.length > 0) {
    const shiftIds = state.shiftsData.map((s) => s.id);

    // Fetch edits and geo in parallel
    const [editsResult, logsResult] = await Promise.all([
      state.supabase
        .from("tt_edits")
        .select("shift_id, field_changed, old_value, new_value, edited_by_name, reason, created_at")
        .in("shift_id", shiftIds)
        .order("created_at", { ascending: true }),
      state.supabase
        .from("tt_logs")
        .select("user_name, client_time, lat, lng")
        .eq("action", "Clock In")
        .gte("client_time", `${start}T00:00:00`)
        .lte("client_time", `${end}T23:59:59`)
        .not("lat", "is", null),
    ]);

    if (editsResult.data) {
      editsResult.data.forEach((e) => {
        if (!state.editsMap[e.shift_id]) state.editsMap[e.shift_id] = [];
        state.editsMap[e.shift_id].push(e);
      });
    }

    // Match logs to shifts by user_name + closest time
    if (logsResult.data) {
      state.shiftsData.forEach((s) => {
        if (!s.clock_in) return;
        const shiftTime = new Date(s.clock_in).getTime();
        const match = logsResult.data.find((log) => {
          if (log.user_name !== s.user_name) return false;
          const logTime = new Date(log.client_time).getTime();
          return Math.abs(logTime - shiftTime) < 120000; // within 2 min
        });
        if (match) {
          state.geoMap[s.id] = { lat: match.lat, lng: match.lng };
        }
      });
    }
  }

  // Zone filter
  const zoneFilter = ($("#filter-zone") || {}).value;
  if (zoneFilter) {
    state.shiftsData = state.shiftsData.filter((s) => {
      const geo = state.geoMap[s.id];
      if (zoneFilter === "none") return !geo;
      if (!geo) return false;
      return getZoneColor(geo.lat, geo.lng) === zoneFilter;
    });
  }

  // Decide: summary view (no specific employee) or detail view
  const selectedEmployee = $("#filter-employee").value;
  const showSummary = !selectedEmployee || selectedEmployee === "__working__";

  if (showSummary) {
    renderShiftsSummary();
  } else {
    renderShifts();
  }
}

function renderShiftsSummary() {
  const empty = $("#shifts-empty");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const pagination = $(".pagination");
  const summaryEl = $("#shifts-summary-table");

  // Hide detail views
  table.classList.add("hidden");
  cards.classList.add("hidden");
  pagination.classList.add("hidden");

  if (state.shiftsData.length === 0) {
    empty.classList.remove("hidden");
    if (summaryEl) summaryEl.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Aggregate by employee
  const stats = {};
  state.shiftsData.forEach((s) => {
    if (!stats[s.user_name]) stats[s.user_name] = { shifts: 0, minutes: 0, workShifts: 0 };
    stats[s.user_name].shifts++;
    if (s.type === "work") {
      stats[s.user_name].minutes += s.duration_minutes || 0;
      stats[s.user_name].workShifts++;
    }
  });

  // Get warehouse info
  const whMap = {};
  state.employeeSettings.forEach((e) => { whMap[e.user_name] = e.warehouse || "—"; });

  const sorted = Object.entries(stats).sort((a, b) => b[1].minutes - a[1].minutes);
  const totalMinutes = sorted.reduce((sum, [, s]) => sum + s.minutes, 0);
  const totalShifts = sorted.reduce((sum, [, s]) => sum + s.shifts, 0);

  $("#shifts-count").textContent = `${totalShifts} shifts`;
  $("#shifts-hours").textContent = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m total`;
  $("#shifts-avg").textContent = `${sorted.length} employees`;

  let html = `<table class="summary-table"><thead><tr>
    <th>Employee</th><th>Warehouse</th><th>Shifts</th><th>Total Hours</th><th>Avg Shift</th><th>Decimal</th>
  </tr></thead><tbody>`;

  sorted.forEach(([name, s]) => {
    const h = Math.floor(s.minutes / 60);
    const m = s.minutes % 60;
    const avg = s.workShifts > 0 ? (s.minutes / s.workShifts / 60).toFixed(1) : "—";
    const decimal = (s.minutes / 60).toFixed(2); // for payroll multiplication
    html += `<tr class="summary-row" data-name="${esc(name)}">
      <td><strong>${esc(name)}</strong></td>
      <td>${esc(whMap[name] || "—")}</td>
      <td>${s.shifts}</td>
      <td>${h}h ${m}m</td>
      <td>${avg}h</td>
      <td>${decimal}</td>
    </tr>`;
  });

  // Totals row
  const totalH = Math.floor(totalMinutes / 60);
  const totalM = totalMinutes % 60;
  const totalDecimal = (totalMinutes / 60).toFixed(2);
  html += `<tr class="summary-total">
    <td><strong>TOTAL</strong></td><td></td>
    <td>${totalShifts}</td>
    <td>${totalH}h ${totalM}m</td>
    <td></td>
    <td>${totalDecimal}</td>
  </tr>`;

  html += "</tbody></table>";

  // Render into summary container (create if needed)
  if (!summaryEl) {
    const div = document.createElement("div");
    div.id = "shifts-summary-table";
    div.className = "shifts-summary-view";
    // Insert before shifts-table
    table.parentElement.insertBefore(div, table);
    div.innerHTML = html;
  } else {
    summaryEl.innerHTML = html;
    summaryEl.classList.remove("hidden");
  }

  // Click row → filter to that employee
  document.querySelectorAll(".summary-row").forEach((row) => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      $("#filter-employee").value = row.dataset.name;
      state.currentPage = 0;
      loadShifts();
    });
  });
}

export function renderShifts() {
  // Hide summary if visible
  const summaryEl = $("#shifts-summary-table");
  if (summaryEl) summaryEl.classList.add("hidden");

  const start = state.currentPage * state.PAGE_SIZE;
  const page = state.shiftsData.slice(start, start + state.PAGE_SIZE);
  const totalMinutes = state.shiftsData.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const maxPage = Math.max(0, Math.ceil(state.shiftsData.length / state.PAGE_SIZE) - 1);

  const shiftsWithDuration = state.shiftsData.filter((s) => s.duration_minutes > 0);
  const avgMinutes = shiftsWithDuration.length > 0
    ? Math.round(totalMinutes / shiftsWithDuration.length)
    : 0;

  $("#shifts-count").textContent = `${state.shiftsData.length} shifts`;
  $("#shifts-hours").textContent = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m total`;
  $("#shifts-avg").textContent = avgMinutes > 0
    ? `${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m avg`
    : "";
  $("#page-info").textContent = `Page ${state.currentPage + 1} of ${maxPage + 1}`;
  $("#prev-page").disabled = state.currentPage === 0;
  $("#next-page").disabled = state.currentPage >= maxPage;

  // Show/hide empty state
  const empty = $("#shifts-empty");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const pagination = $(".pagination");

  if (state.shiftsData.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    cards.classList.add("hidden");
    pagination.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  table.classList.remove("hidden");
  cards.classList.remove("hidden");
  pagination.classList.remove("hidden");

  // Desktop table
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

      const rowClass = s.type !== 'work' ? 'row-special'
        : s.duration_minutes > 720 ? 'row-overtime'
        : s.duration_minutes > 540 ? 'row-long' : '';

      return `<tr class="${rowClass}" data-id="${s.id}">
        <td>${date}</td>
        <td>${esc(s.user_name)}</td>
        <td>${inTime}</td>
        <td>${outTime}</td>
        <td>${hours}</td>
        <td>${typeLabel}</td>
        <td>${esc(s.comment)}</td>
        <td>
          ${geoIcon(s.id)}
          ${state.editsMap[s.id] ? `<span class="edit-indicator" data-id="${s.id}" title="Edited">✏️</span>` : ""}
          <button class="btn-edit" data-id="${s.id}">Edit</button>
        </td>
      </tr>`;
    })
    .join("");

  // Mobile cards
  cards.innerHTML = page
    .map((s) => {
      const date = formatDateShort(s.clock_in);
      const inTime = formatTimeShort(s.clock_in);
      const outTime = s.clock_out ? formatTimeShort(s.clock_out) : "—";
      const hours = s.duration_minutes
        ? `${Math.floor(s.duration_minutes / 60)}h ${s.duration_minutes % 60}m`
        : "—";
      const typeLabel =
        s.type === "day_off" ? "Day Off" : s.type === "paid_off" ? "Paid Off" : "Work";

      const cardClass = s.type !== 'work' ? 'card-special'
        : s.duration_minutes > 720 ? 'card-overtime'
        : s.duration_minutes > 540 ? 'card-long' : '';

      return `<div class="shift-card ${cardClass}" data-id="${s.id}">
        <div class="card-header">
          <span class="card-name">${esc(s.user_name)}</span>
          <span class="card-date">${date}</span>
        </div>
        <div class="card-body">
          <div class="card-times">
            <span class="card-label">In</span> <span class="card-value">${inTime}</span>
            <span class="card-label">Out</span> <span class="card-value">${outTime}</span>
          </div>
          <div class="card-meta">
            <span class="card-hours">${hours}</span>
            ${typeLabel !== "Work" ? `<span class="card-type">${typeLabel}</span>` : ""}
          </div>
        </div>
        ${s.comment ? `<div class="card-comment">${esc(s.comment)}</div>` : ""}
        <div class="card-actions">
          ${geoIcon(s.id)}
          <button class="btn-edit card-edit" data-id="${s.id}">Edit</button>
        </div>
      </div>`;
    })
    .join("");

  // Attach mini-map popups to geo icons
  attachGeoPopups();
}

// --- Employee & Warehouse lists for Shift Log filters ---
export async function loadEmployeeList() {
  // Get all employees from settings (22 employees, 8 warehouses)
  const { data: settings } = await state.supabase
    .from("tt_employee_settings")
    .select("user_name, warehouse")
    .order("user_name");

  const employees = settings || [];

  // Populate employee dropdown
  const select = $("#filter-employee");
  // Keep existing "All" and "Working now" options, remove the rest
  while (select.options.length > 2) select.remove(2);
  employees.forEach((e) => {
    const opt = document.createElement("option");
    opt.value = e.user_name;
    opt.textContent = e.user_name;
    select.appendChild(opt);
  });

  // Populate warehouse dropdown (for shift log)
  const whSelect = $("#filter-warehouse");
  if (whSelect) {
    const warehouses = [...new Set(employees.map((e) => e.warehouse).filter(Boolean))].sort();
    while (whSelect.options.length > 1) whSelect.remove(1);
    warehouses.forEach((wh) => {
      const opt = document.createElement("option");
      opt.value = wh;
      opt.textContent = wh;
      whSelect.appendChild(opt);
    });

    // Warehouse filter: update employee dropdown to show only that warehouse's employees
    whSelect.onchange = () => {
      const selectedWh = whSelect.value;
      while (select.options.length > 2) select.remove(2);
      const filtered = selectedWh ? employees.filter((e) => e.warehouse === selectedWh) : employees;
      filtered.forEach((e) => {
        const opt = document.createElement("option");
        opt.value = e.user_name;
        opt.textContent = e.user_name;
        select.appendChild(opt);
      });
      select.value = "";
    };
  }
}

// --- Copy to clipboard ---
export function copyShiftsTable() {
  if (state.shiftsData.length === 0) return;

  const header = "Date\tEmployee\tClock In\tClock Out\tHours\tType\tComment";
  const rows = state.shiftsData.map((s) => {
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

// --- Mini-map popup for shift log geo icons ---
export function attachGeoPopups() {
  document.querySelectorAll(".geo-zone").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const shiftId = parseInt(el.dataset.shift);
      const geo = state.geoMap[shiftId];
      if (!geo) return;

      // Remove existing popup
      document.querySelectorAll(".minimap-popup").forEach((p) => p.remove());

      const popup = document.createElement("div");
      popup.className = "minimap-popup";
      popup.innerHTML = `<div id="minimap-${shiftId}" style="width:300px;height:200px;"></div><button class="minimap-close">✕</button>`;
      el.parentElement.style.position = "relative";
      el.parentElement.appendChild(popup);

      const mm = L.map(`minimap-${shiftId}`, { zoomControl: false, attributionControl: false })
        .setView([geo.lat, geo.lng], 15);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(mm);

      // Draw zones
      state.zonesData.forEach((z) => {
        L.circle([z.lat, z.lng], { radius: z.radius_yellow, color: "#f59e0b", fillOpacity: 0.07, weight: 1 }).addTo(mm);
        L.circle([z.lat, z.lng], { radius: z.radius_green, color: "#22c55e", fillOpacity: 0.12, weight: 2 }).addTo(mm);
      });

      // Employee marker
      const { color } = geoZoneLabel(shiftId);
      const colors = { green: "#22c55e", yellow: "#f59e0b", red: "#ef4444" };
      L.circleMarker([geo.lat, geo.lng], {
        radius: 8, color: colors[color] || "#888", fillColor: colors[color] || "#888", fillOpacity: 0.9, weight: 2,
      }).addTo(mm);

      setTimeout(() => mm.invalidateSize(), 100);

      popup.querySelector(".minimap-close").addEventListener("click", () => {
        mm.remove();
        popup.remove();
      });
    });
  });
}
