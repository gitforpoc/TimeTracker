import "./admin.css";
import { checkAdminAuth, getSupabaseClient } from "../auth.js";

// --- State ---
let supabase = null;
let authToken = null;
let currentTab = "status";
let shiftsData = [];
let editsMap = {};
let geoMap = {};
let currentPage = 0;
const PAGE_SIZE = 50;
let statusInterval = null;
let workingNames = []; // names of currently working employees
let editOriginal = {}; // original values when edit modal opens
let zonesData = []; // from tt_zones
let leafletMap = null;
let zoneLayers = []; // { zone, greenCircle, yellowCircle, marker }
let employeeLayers = []; // employee markers on map
let editingZone = null; // zone being edited

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
  const { data: { session } } = await supabase.auth.getSession();
  authToken = session?.access_token;
  $("#admin-name").textContent = auth.name;
  $("#auth-gate").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");

  // Set default date range (current week, Mon-today)
  const today = new Date();
  const monday = new Date(today);
  const dayOfWeek = today.getDay();
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(today.getDate() - daysBack);
  $("#filter-start").value = formatDateISO(monday);
  $("#filter-end").value = formatDateISO(today);

  setupTabs();
  setupFilters();
  setupKeyboard();
  loadEmployeeList();
  loadZones(); // preload zones for geo icons
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

      $$(".tab-content").forEach((c) => {
        c.classList.add("hidden");
        c.classList.remove("active-tab");
      });
      const target = $(`#tab-${currentTab}`);
      target.classList.remove("hidden");
      // Trigger transition after removing hidden
      requestAnimationFrame(() => target.classList.add("active-tab"));

      // Auto-load on tab switch
      if (currentTab === "shifts") loadShifts();
      if (currentTab === "map") initMap();
    });
  });
}

// --- Keyboard ---
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#confirm-modal").classList.contains("hidden")) {
        closeConfirmModal();
      } else if (!$("#edit-modal").classList.contains("hidden")) {
        closeEditModal();
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (!$("#confirm-modal").classList.contains("hidden")) {
        e.preventDefault();
        $("#confirm-ok").click();
      } else if (!$("#edit-modal").classList.contains("hidden")) {
        if (!$("#edit-save").disabled) {
          e.preventDefault();
          $("#edit-save").click();
        }
      }
    }
  });
}

// --- Live Status ---
async function loadStatus() {
  const loading = $("#status-loading");
  const table = $("#status-table");
  loading.classList.remove("hidden");
  table.style.opacity = "0.4";

  const { data, error } = await supabase.rpc("tt_get_user_statuses");

  loading.classList.add("hidden");
  table.style.opacity = "1";

  if (error) {
    console.error("Status error:", error);
    return;
  }

  const now = new Date();
  const working = data.filter((u) => u.action === "Clock In");
  const offline = data.filter((u) => u.action !== "Clock In");
  const sorted = [...working, ...offline];

  // Update working names for filter
  workingNames = working.map((u) => u.user_name);

  // Update badge
  const badge = $("#working-badge");
  if (working.length > 0) {
    badge.textContent = working.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

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

      let duration = "—";
      let durationClass = "";
      if (isWorking) {
        duration = calcDuration(u.client_time, now);
        const diffMin = Math.floor((now - new Date(u.client_time)) / 60000);
        const diffHours = diffMin / 60;
        if (diffHours > 10) durationClass = "duration-red";
        else if (diffHours >= 8) durationClass = "duration-yellow";
        else durationClass = "duration-green";
      }

      return `<tr class="${statusClass}">
        <td>${u.user_name}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td class="${durationClass}">${duration}</td>
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

  let query = supabase
    .from("tt_shifts")
    .select("id, user_name, clock_in, clock_out, duration_minutes, type, comment")
    .gte("clock_in", `${start}T00:00:00`)
    .lte("clock_in", `${end}T23:59:59`)
    .order("clock_in", { ascending: false })
    .limit(5000);

  if (employee === "__working__") {
    // Filter to only currently working employees
    if (workingNames.length > 0) {
      query = query.in("user_name", workingNames);
    } else {
      // No one working — show empty
      shiftsData = [];
      loading.classList.add("hidden");
      table.style.opacity = "1";
      cards.style.opacity = "1";
      renderShifts();
      return;
    }
  } else if (employee) {
    query = query.eq("user_name", employee);
  }

  const { data, error } = await query;

  loading.classList.add("hidden");
  table.style.opacity = "1";
  cards.style.opacity = "1";

  if (error) {
    console.error("Shifts error:", error);
    return;
  }

  shiftsData = data || [];
  currentPage = 0;

  // Load edit history + geo data for these shifts
  editsMap = {};
  geoMap = {};
  if (shiftsData.length > 0) {
    const shiftIds = shiftsData.map((s) => s.id);

    // Fetch edits and geo in parallel
    const [editsResult, logsResult] = await Promise.all([
      supabase
        .from("tt_edits")
        .select("shift_id, field_changed, old_value, new_value, edited_by_name, reason, created_at")
        .in("shift_id", shiftIds)
        .order("created_at", { ascending: true }),
      supabase
        .from("tt_logs")
        .select("user_name, client_time, lat, lng")
        .eq("action", "Clock In")
        .gte("client_time", `${start}T00:00:00`)
        .lte("client_time", `${end}T23:59:59`)
        .not("lat", "is", null),
    ]);

    if (editsResult.data) {
      editsResult.data.forEach((e) => {
        if (!editsMap[e.shift_id]) editsMap[e.shift_id] = [];
        editsMap[e.shift_id].push(e);
      });
    }

    // Match logs to shifts by user_name + closest time
    if (logsResult.data) {
      shiftsData.forEach((s) => {
        if (!s.clock_in) return;
        const shiftTime = new Date(s.clock_in).getTime();
        const match = logsResult.data.find((log) => {
          if (log.user_name !== s.user_name) return false;
          const logTime = new Date(log.client_time).getTime();
          return Math.abs(logTime - shiftTime) < 120000; // within 2 min
        });
        if (match) {
          geoMap[s.id] = { lat: match.lat, lng: match.lng };
        }
      });
    }
  }

  // Zone filter
  const zoneFilter = ($("#filter-zone") || {}).value;
  if (zoneFilter) {
    shiftsData = shiftsData.filter((s) => {
      const geo = geoMap[s.id];
      if (zoneFilter === "none") return !geo;
      if (!geo) return false;
      return getZoneColor(geo.lat, geo.lng) === zoneFilter;
    });
  }

  renderShifts();
}

function renderShifts() {
  const start = currentPage * PAGE_SIZE;
  const page = shiftsData.slice(start, start + PAGE_SIZE);
  const totalMinutes = shiftsData.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const maxPage = Math.max(0, Math.ceil(shiftsData.length / PAGE_SIZE) - 1);

  const shiftsWithDuration = shiftsData.filter((s) => s.duration_minutes > 0);
  const avgMinutes = shiftsWithDuration.length > 0
    ? Math.round(totalMinutes / shiftsWithDuration.length)
    : 0;

  $("#shifts-count").textContent = `${shiftsData.length} shifts`;
  $("#shifts-hours").textContent = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m total`;
  $("#shifts-avg").textContent = avgMinutes > 0
    ? `${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m avg`
    : "";
  $("#page-info").textContent = `Page ${currentPage + 1} of ${maxPage + 1}`;
  $("#prev-page").disabled = currentPage === 0;
  $("#next-page").disabled = currentPage >= maxPage;

  // Show/hide empty state
  const empty = $("#shifts-empty");
  const table = $("#shifts-table");
  const cards = $("#shifts-cards");
  const pagination = $(".pagination");

  if (shiftsData.length === 0) {
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

      return `<tr class="${s.type !== 'work' ? 'row-special' : ''}" data-id="${s.id}">
        <td>${date}</td>
        <td>${s.user_name}</td>
        <td>${inTime}</td>
        <td>${outTime}</td>
        <td>${hours}</td>
        <td>${typeLabel}</td>
        <td>${esc(s.comment)}</td>
        <td>
          ${geoIcon(s.id)}
          ${editsMap[s.id] ? `<span class="edit-indicator" data-id="${s.id}" title="Edited">✏️</span>` : ""}
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

      return `<div class="shift-card ${s.type !== 'work' ? 'card-special' : ''}" data-id="${s.id}">
        <div class="card-header">
          <span class="card-name">${s.user_name}</span>
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

// --- Employee list ---
async function loadEmployeeList() {
  // Get distinct employee names from profiles (lightweight query)
  let names = [];

  const { data: profiles } = await supabase
    .from("profiles")
    .select("name")
    .order("name");

  if (profiles && profiles.length > 0) {
    names = [...new Set(profiles.map((p) => p.name).filter(Boolean))];
  } else {
    // Fallback: get distinct names from shifts
    const { data } = await supabase
      .from("tt_shifts")
      .select("user_name")
      .limit(5000);

    if (!data) return;
    names = [...new Set(data.map((r) => r.user_name))].sort();
  }

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

// --- Haversine Distance (meters) ---
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getZoneColor(lat, lng) {
  if (!zonesData.length) return "none";
  let best = "red";
  for (const z of zonesData) {
    const dist = haversine(lat, lng, z.lat, z.lng);
    if (dist <= z.radius_green) return "green";
    if (dist <= z.radius_yellow && best === "red") best = "yellow";
  }
  return best;
}

function geoZoneLabel(shiftId) {
  const geo = geoMap[shiftId];
  if (!geo) return { color: "none", dist: null };
  const color = getZoneColor(geo.lat, geo.lng);
  // Distance to nearest zone center
  let dist = null;
  if (zonesData.length) {
    dist = Math.round(haversine(geo.lat, geo.lng, zonesData[0].lat, zonesData[0].lng));
  }
  return { color, dist };
}

// --- Helpers ---
function geoIcon(shiftId) {
  const geo = geoMap[shiftId];
  if (!geo) return `<span class="geo-icon geo-none" title="No GPS" data-zone="none">📍</span>`;
  const { color, dist } = geoZoneLabel(shiftId);
  const icons = { green: "🟢", yellow: "🟡", red: "🔴" };
  const icon = icons[color] || "📍";
  const distText = dist !== null ? `${dist}m from zone` : "";
  return `<span class="geo-icon geo-zone geo-${color}" data-zone="${color}" data-shift="${shiftId}" title="${distText}" style="cursor:pointer">${icon}</span>`;
}

// --- Map ---
async function initMap() {
  // Load zones if not loaded
  if (!zonesData.length) await loadZones();

  if (leafletMap) {
    leafletMap.invalidateSize();
    await loadEmployeesOnMap();
    return;
  }

  const center = zonesData.length ? [zonesData[0].lat, zonesData[0].lng] : [40.7228, -73.9060];

  leafletMap = L.map("map-container").setView(center, 15);

  // Tile layers
  const dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  });
  const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: '&copy; Esri',
    maxZoom: 19,
  });

  dark.addTo(leafletMap);
  L.control.layers({ "Dark": dark, "Street": street, "Satellite": satellite }).addTo(leafletMap);

  // Render zones
  renderZonesOnMap();

  // Load employees
  await loadEmployeesOnMap();

  // Click map to add zone
  leafletMap.on("click", (e) => {
    if (editingZone) return;
    openZonePanel({
      id: null,
      name: "New Zone",
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      radius_green: 200,
      radius_yellow: 1000,
    });
  });

  // Zone panel controls
  setupZonePanel();
}

async function loadZones() {
  const { data } = await supabase.from("tt_zones").select("*").order("id");
  zonesData = data || [];
}

function renderZonesOnMap() {
  zoneLayers.forEach((zl) => {
    leafletMap.removeLayer(zl.yellowCircle);
    leafletMap.removeLayer(zl.greenCircle);
    leafletMap.removeLayer(zl.marker);
  });
  zoneLayers = [];

  zonesData.forEach((z) => {
    const yellowCircle = L.circle([z.lat, z.lng], {
      radius: z.radius_yellow,
      color: "#f59e0b",
      fillColor: "#f59e0b",
      fillOpacity: 0.07,
      weight: 1,
      dashArray: "6 4",
    }).addTo(leafletMap);

    const greenCircle = L.circle([z.lat, z.lng], {
      radius: z.radius_green,
      color: "#22c55e",
      fillColor: "#22c55e",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(leafletMap);

    const marker = L.marker([z.lat, z.lng], {
      draggable: true,
      title: z.name,
    }).addTo(leafletMap)
      .bindPopup(`<b>${esc(z.name)}</b><br>🟢 ${z.radius_green}m &nbsp; 🟡 ${z.radius_yellow}m`);

    marker.on("click", () => openZonePanel(z));
    marker.on("dragend", (e) => {
      const pos = e.target.getLatLng();
      z.lat = pos.lat;
      z.lng = pos.lng;
      yellowCircle.setLatLng(pos);
      greenCircle.setLatLng(pos);
      if (editingZone && editingZone.id === z.id) {
        editingZone.lat = pos.lat;
        editingZone.lng = pos.lng;
      }
    });

    zoneLayers.push({ zone: z, yellowCircle, greenCircle, marker });
  });
}

async function loadEmployeesOnMap() {
  // Remove old
  employeeLayers.forEach((m) => leafletMap.removeLayer(m));
  employeeLayers = [];

  // Get live statuses
  const { data: statuses } = await supabase.rpc("tt_get_user_statuses");
  if (!statuses) return;

  const working = statuses.filter((s) => s.action === "Clock In");

  // Get latest Clock In logs with GPS for working employees
  for (const emp of working) {
    const { data: logs } = await supabase
      .from("tt_logs")
      .select("lat, lng, client_time")
      .eq("user_name", emp.user_name)
      .eq("action", "Clock In")
      .not("lat", "is", null)
      .order("client_time", { ascending: false })
      .limit(1);

    // If no GPS log, still show on map using zone center as fallback? No — skip
    if (!logs || !logs.length) continue;
    const log = logs[0];
    const color = getZoneColor(log.lat, log.lng);
    const colors = { green: "#22c55e", yellow: "#f59e0b", red: "#ef4444" };
    const since = new Date(emp.client_time);
    const dur = Math.floor((Date.now() - since.getTime()) / 60000);
    const hours = Math.floor(dur / 60);
    const mins = dur % 60;

    const pulseIcon = L.divIcon({
      className: "emp-marker",
      html: `<div class="emp-dot" style="background:${colors[color] || "#888"}"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const m = L.marker([log.lat, log.lng], { icon: pulseIcon })
      .addTo(leafletMap)
      .bindPopup(`<b>${esc(emp.user_name)}</b><br>
        Since ${since.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}<br>
        Duration: ${hours}h ${mins}m<br>
        Zone: <b style="color:${colors[color]}">${color.toUpperCase()}</b>`);

    employeeLayers.push(m);
  }
}

function setupZonePanel() {
  const greenSlider = $("#zone-green");
  const yellowSlider = $("#zone-yellow");
  const greenVal = $("#zone-green-val");
  const yellowVal = $("#zone-yellow-val");

  greenSlider.addEventListener("input", () => {
    greenVal.textContent = `${greenSlider.value}m`;
    if (editingZone) updateZonePreview();
  });
  yellowSlider.addEventListener("input", () => {
    yellowVal.textContent = `${yellowSlider.value}m`;
    if (editingZone) updateZonePreview();
  });

  $("#zone-save").addEventListener("click", saveZone);
  $("#zone-delete").addEventListener("click", deleteZone);
  $("#zone-cancel").addEventListener("click", closeZonePanel);
}

function openZonePanel(zone) {
  editingZone = { ...zone };
  const panel = $("#zone-panel");
  $("#zone-panel-title").textContent = zone.id ? "Edit Zone" : "New Zone";
  $("#zone-name").value = zone.name;
  $("#zone-green").value = zone.radius_green;
  $("#zone-green-val").textContent = `${zone.radius_green}m`;
  $("#zone-yellow").value = zone.radius_yellow;
  $("#zone-yellow-val").textContent = `${zone.radius_yellow}m`;
  $("#zone-delete").classList.toggle("hidden", !zone.id);
  panel.classList.remove("hidden");

  // Show preview circles if new zone
  if (!zone.id) {
    editingZone._previewYellow = L.circle([zone.lat, zone.lng], {
      radius: zone.radius_yellow, color: "#f59e0b", fillOpacity: 0.07, weight: 1, dashArray: "6 4",
    }).addTo(leafletMap);
    editingZone._previewGreen = L.circle([zone.lat, zone.lng], {
      radius: zone.radius_green, color: "#22c55e", fillOpacity: 0.12, weight: 2,
    }).addTo(leafletMap);
  }
}

function updateZonePreview() {
  const green = parseInt($("#zone-green").value);
  const yellow = parseInt($("#zone-yellow").value);

  if (editingZone.id) {
    const zl = zoneLayers.find((l) => l.zone.id === editingZone.id);
    if (zl) {
      zl.greenCircle.setRadius(green);
      zl.yellowCircle.setRadius(yellow);
    }
  } else {
    if (editingZone._previewGreen) editingZone._previewGreen.setRadius(green);
    if (editingZone._previewYellow) editingZone._previewYellow.setRadius(yellow);
  }
}

async function saveZone() {
  const name = $("#zone-name").value.trim();
  const green = parseInt($("#zone-green").value);
  const yellow = parseInt($("#zone-yellow").value);
  if (!name) return;

  const payload = {
    name,
    lat: editingZone.lat,
    lng: editingZone.lng,
    radius_green: green,
    radius_yellow: yellow,
  };

  if (editingZone.id) {
    await supabase.from("tt_zones").update(payload).eq("id", editingZone.id);
  } else {
    await supabase.from("tt_zones").insert(payload);
  }

  await loadZones();
  renderZonesOnMap();
  closeZonePanel();
  showToast("Zone saved");
}

async function deleteZone() {
  if (!editingZone || !editingZone.id) return;
  await supabase.from("tt_zones").delete().eq("id", editingZone.id);
  await loadZones();
  renderZonesOnMap();
  closeZonePanel();
  showToast("Zone deleted");
}

function closeZonePanel() {
  if (editingZone?._previewGreen) leafletMap.removeLayer(editingZone._previewGreen);
  if (editingZone?._previewYellow) leafletMap.removeLayer(editingZone._previewYellow);
  editingZone = null;
  $("#zone-panel").classList.add("hidden");
}

// --- Mini-map popup for shift log geo icons ---
function attachGeoPopups() {
  document.querySelectorAll(".geo-zone").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const shiftId = parseInt(el.dataset.shift);
      const geo = geoMap[shiftId];
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
      zonesData.forEach((z) => {
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

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDateISO(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// --- Edit Modal ---
function setupEditListeners() {
  document.addEventListener("click", (e) => {
    // Edit button
    if (e.target.classList.contains("btn-edit")) {
      const id = Number(e.target.dataset.id);
      const shift = shiftsData.find((s) => s.id === id);
      if (shift) openEditModal(shift);
      return;
    }
    // Edit history indicator
    if (e.target.classList.contains("edit-indicator")) {
      const id = Number(e.target.dataset.id);
      showEditHistory(id, e.target);
      return;
    }
    // Close popover on outside click
    const popover = document.querySelector(".edit-popover");
    if (popover && !popover.contains(e.target)) {
      popover.remove();
    }
  });

  $("#edit-cancel").addEventListener("click", closeEditModal);
  $("#edit-overlay").addEventListener("click", closeEditModal);
  $("#edit-save").addEventListener("click", confirmBeforeSave);

  // Track changes to highlight fields and enable/disable save
  const fields = ["#edit-clock-in", "#edit-clock-out", "#edit-type", "#edit-comment"];
  fields.forEach((sel) => {
    $(sel).addEventListener("input", trackEditChanges);
    $(sel).addEventListener("change", trackEditChanges);
  });

  // Confirm modal
  $("#confirm-cancel").addEventListener("click", closeConfirmModal);
  $("#confirm-overlay").addEventListener("click", closeConfirmModal);
  $("#confirm-ok").addEventListener("click", saveEdit);
}

function openEditModal(shift) {
  const modal = $("#edit-modal");
  modal.dataset.shiftId = shift.id;

  $("#edit-employee").textContent = shift.user_name;

  const clockInVal = toLocalDatetimeStr(shift.clock_in);
  const clockOutVal = shift.clock_out ? toLocalDatetimeStr(shift.clock_out) : "";

  $("#edit-clock-in").value = clockInVal;
  $("#edit-clock-out").value = clockOutVal;
  $("#edit-type").value = shift.type;
  $("#edit-comment").value = shift.comment || "";
  $("#edit-reason").value = "";

  // Store original values
  editOriginal = {
    clockIn: clockInVal,
    clockOut: clockOutVal,
    type: shift.type,
    comment: shift.comment || "",
  };

  // Reset field highlights
  $$(".modal-fields label").forEach((l) => l.classList.remove("field-changed"));
  $("#edit-save").disabled = true;

  modal.classList.remove("hidden");
  $("#edit-overlay").classList.remove("hidden");
}

function trackEditChanges() {
  const clockIn = $("#edit-clock-in");
  const clockOut = $("#edit-clock-out");
  const type = $("#edit-type");
  const comment = $("#edit-comment");

  const changes = {
    clockIn: clockIn.value !== editOriginal.clockIn,
    clockOut: clockOut.value !== editOriginal.clockOut,
    type: type.value !== editOriginal.type,
    comment: comment.value !== editOriginal.comment,
  };

  // Highlight changed fields
  clockIn.closest("label").classList.toggle("field-changed", changes.clockIn);
  clockOut.closest("label").classList.toggle("field-changed", changes.clockOut);
  type.closest("label").classList.toggle("field-changed", changes.type);
  comment.closest("label").classList.toggle("field-changed", changes.comment);

  const hasChanges = Object.values(changes).some(Boolean);
  $("#edit-save").disabled = !hasChanges;
}

function closeEditModal() {
  $("#edit-modal").classList.add("hidden");
  $("#edit-overlay").classList.add("hidden");
}

function confirmBeforeSave() {
  // Build change summary
  const changes = [];
  if ($("#edit-clock-in").value !== editOriginal.clockIn) {
    changes.push(`<strong>Clock In:</strong> ${editOriginal.clockIn || "(empty)"} → ${$("#edit-clock-in").value || "(empty)"}`);
  }
  if ($("#edit-clock-out").value !== editOriginal.clockOut) {
    changes.push(`<strong>Clock Out:</strong> ${editOriginal.clockOut || "(empty)"} → ${$("#edit-clock-out").value || "(empty)"}`);
  }
  if ($("#edit-type").value !== editOriginal.type) {
    changes.push(`<strong>Type:</strong> ${editOriginal.type} → ${$("#edit-type").value}`);
  }
  if ($("#edit-comment").value !== editOriginal.comment) {
    changes.push(`<strong>Comment:</strong> "${editOriginal.comment || "(empty)"}" → "${$("#edit-comment").value || "(empty)"}"`);
  }

  if (changes.length === 0) return;

  const reason = $("#edit-reason").value.trim();
  if (reason) {
    changes.push(`<strong>Reason:</strong> ${esc(reason)}`);
  }

  $("#confirm-changes").innerHTML = changes.map((c) => `<div class="confirm-line">${c}</div>`).join("");
  $("#confirm-modal").classList.remove("hidden");
  $("#confirm-overlay").classList.remove("hidden");
}

function closeConfirmModal() {
  $("#confirm-modal").classList.add("hidden");
  $("#confirm-overlay").classList.add("hidden");
}

async function saveEdit() {
  closeConfirmModal();

  const shiftId = Number($("#edit-modal").dataset.shiftId);
  const shift = shiftsData.find((s) => s.id === shiftId);
  if (!shift) return;

  const changes = {};
  const rawIn = $("#edit-clock-in").value;
  const rawOut = $("#edit-clock-out").value;

  if (rawIn && isNaN(new Date(rawIn).getTime())) {
    showToast("Invalid Clock In date");
    return;
  }
  if (rawOut && isNaN(new Date(rawOut).getTime())) {
    showToast("Invalid Clock Out date");
    return;
  }

  const newClockIn = rawIn ? new Date(rawIn).toISOString() : null;
  const newClockOut = rawOut ? new Date(rawOut).toISOString() : null;
  const newType = $("#edit-type").value;
  const newComment = $("#edit-comment").value.trim();
  const reason = $("#edit-reason").value.trim();

  // Compare by epoch ms to avoid ISO string format mismatches
  const oldInMs = shift.clock_in ? new Date(shift.clock_in).getTime() : 0;
  const oldOutMs = shift.clock_out ? new Date(shift.clock_out).getTime() : 0;
  const newInMs = new Date(newClockIn).getTime();
  const newOutMs = newClockOut ? new Date(newClockOut).getTime() : 0;

  if (newInMs !== oldInMs) changes.clock_in = newClockIn;
  if (newOutMs !== oldOutMs) changes.clock_out = newClockOut;
  if (newType !== shift.type) changes.type = newType;
  if (newComment !== (shift.comment || "")) changes.comment = newComment || null;

  if (Object.keys(changes).length === 0) {
    closeEditModal();
    return;
  }

  $("#edit-save").disabled = true;
  $("#edit-save").textContent = "Saving...";

  try {
    const res = await fetch("/api/edit-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ shiftId, changes, reason }),
    });

    const result = await res.json();

    if (!res.ok) {
      showToast(result.error || "Error saving");
      return;
    }

    showToast(`Updated ${result.edits} field(s)`);
    closeEditModal();
    loadShifts(); // Reload to show updated data
  } catch (err) {
    showToast("Network error");
    console.error(err);
  } finally {
    $("#edit-save").disabled = false;
    $("#edit-save").textContent = "Save";
  }
}

function toLocalDatetimeStr(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

// --- Edit History Popover ---
function showEditHistory(shiftId, anchor) {
  // Remove existing popover
  document.querySelectorAll(".edit-popover").forEach((p) => p.remove());

  const edits = editsMap[shiftId];
  if (!edits || edits.length === 0) return;

  const popover = document.createElement("div");
  popover.className = "edit-popover";

  const rows = edits.map((e) => {
    const time = new Date(e.created_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const isAdmin = e.edited_by_name !== shiftsData.find((s) => s.id === shiftId)?.user_name;
    const badge = isAdmin ? "supervisor" : "employee";
    return `<div class="edit-entry">
      <div class="edit-meta">
        <span class="edit-badge edit-badge-${badge}">${esc(e.edited_by_name)}</span>
        <span class="edit-time">${time}</span>
      </div>
      <div class="edit-detail">${esc(e.field_changed)}: ${esc(e.old_value) || "—"} → ${esc(e.new_value) || "—"}</div>
      ${e.reason ? `<div class="edit-reason">${esc(e.reason)}</div>` : ""}
    </div>`;
  }).join("");

  popover.innerHTML = `<div class="popover-title">Edit History</div>${rows}`;

  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`;

  document.body.appendChild(popover);
}

// --- Start ---
setupEditListeners();
init();
