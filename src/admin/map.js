import { state } from "./state.js";
import { $, esc, showToast } from "./helpers.js";
import { getZoneColor } from "./geo.js";

// --- Map ---
export async function initMap() {
  // Load zones if not loaded
  if (!state.zonesData.length) await loadZones();

  if (state.leafletMap) {
    state.leafletMap.invalidateSize();
    await loadEmployeesOnMap();
    return;
  }

  const center = state.zonesData.length ? [state.zonesData[0].lat, state.zonesData[0].lng] : [40.7228, -73.9060];

  state.leafletMap = L.map("map-container").setView(center, 15);

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

  dark.addTo(state.leafletMap);
  L.control.layers({ "Dark": dark, "Street": street, "Satellite": satellite }).addTo(state.leafletMap);

  // Render zones
  renderZonesOnMap();

  // Load employees
  await loadEmployeesOnMap();

  // Click map to add zone
  state.leafletMap.on("click", (e) => {
    if (state.editingZone) return;
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

export async function loadZones() {
  const { data } = await state.supabase.from("tt_zones").select("*").order("id");
  state.zonesData = data || [];
}

export function renderZonesOnMap() {
  state.zoneLayers.forEach((zl) => {
    state.leafletMap.removeLayer(zl.yellowCircle);
    state.leafletMap.removeLayer(zl.greenCircle);
    state.leafletMap.removeLayer(zl.marker);
  });
  state.zoneLayers = [];

  state.zonesData.forEach((z) => {
    const yellowCircle = L.circle([z.lat, z.lng], {
      radius: z.radius_yellow,
      color: "#f59e0b",
      fillColor: "#f59e0b",
      fillOpacity: 0.07,
      weight: 1,
      dashArray: "6 4",
    }).addTo(state.leafletMap);

    const greenCircle = L.circle([z.lat, z.lng], {
      radius: z.radius_green,
      color: "#22c55e",
      fillColor: "#22c55e",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(state.leafletMap);

    const marker = L.marker([z.lat, z.lng], {
      draggable: true,
      title: z.name,
    }).addTo(state.leafletMap)
      .bindPopup(`<b>${esc(z.name)}</b><br>🟢 ${z.radius_green}m &nbsp; 🟡 ${z.radius_yellow}m`);

    marker.on("click", () => openZonePanel(z));
    marker.on("dragend", (e) => {
      const pos = e.target.getLatLng();
      z.lat = pos.lat;
      z.lng = pos.lng;
      yellowCircle.setLatLng(pos);
      greenCircle.setLatLng(pos);
      if (state.editingZone && state.editingZone.id === z.id) {
        state.editingZone.lat = pos.lat;
        state.editingZone.lng = pos.lng;
      }
    });

    state.zoneLayers.push({ zone: z, yellowCircle, greenCircle, marker });
  });
}

async function loadEmployeesOnMap() {
  // Remove old
  state.employeeLayers.forEach((m) => state.leafletMap.removeLayer(m));
  state.employeeLayers = [];

  // Get live statuses
  const { data: statuses } = await state.supabase.rpc("tt_get_user_statuses");
  if (!statuses) return;

  const working = statuses.filter((s) => s.action === "Clock In");

  // Get latest Clock In logs with GPS for working employees
  for (const emp of working) {
    const { data: logs } = await state.supabase
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

    const popupHtml = `<div class="emp-popup">
        <b>${esc(emp.user_name)}</b><br>
        Since ${since.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}<br>
        Duration: ${hours}h ${mins}m<br>
        Zone: <b style="color:${colors[color]}">${color.toUpperCase()}</b>
        <div style="margin-top:8px">
          <button class="shock-btn" data-name="${esc(emp.user_name)}">⚡ Activate Shock Collar</button>
        </div>
      </div>`;

    const m = L.marker([log.lat, log.lng], { icon: pulseIcon })
      .addTo(state.leafletMap)
      .bindPopup(popupHtml)
      .on("popupopen", () => {
        const btn = document.querySelector(`.shock-btn[data-name="${emp.user_name}"]`);
        if (btn) btn.addEventListener("click", () => openShockModal(emp.user_name));
      });

    state.employeeLayers.push(m);
  }
}

function setupZonePanel() {
  const greenSlider = $("#zone-green");
  const yellowSlider = $("#zone-yellow");
  const greenVal = $("#zone-green-val");
  const yellowVal = $("#zone-yellow-val");

  greenSlider.addEventListener("input", () => {
    greenVal.textContent = `${greenSlider.value}m`;
    if (state.editingZone) updateZonePreview();
  });
  yellowSlider.addEventListener("input", () => {
    yellowVal.textContent = `${yellowSlider.value}m`;
    if (state.editingZone) updateZonePreview();
  });

  $("#zone-save").addEventListener("click", saveZone);
  $("#zone-delete").addEventListener("click", deleteZone);
  $("#zone-cancel").addEventListener("click", closeZonePanel);
}

function openZonePanel(zone) {
  state.editingZone = { ...zone };
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
    state.editingZone._previewYellow = L.circle([zone.lat, zone.lng], {
      radius: zone.radius_yellow, color: "#f59e0b", fillOpacity: 0.07, weight: 1, dashArray: "6 4",
    }).addTo(state.leafletMap);
    state.editingZone._previewGreen = L.circle([zone.lat, zone.lng], {
      radius: zone.radius_green, color: "#22c55e", fillOpacity: 0.12, weight: 2,
    }).addTo(state.leafletMap);
  }
}

function updateZonePreview() {
  const green = parseInt($("#zone-green").value);
  const yellow = parseInt($("#zone-yellow").value);

  if (state.editingZone.id) {
    const zl = state.zoneLayers.find((l) => l.zone.id === state.editingZone.id);
    if (zl) {
      zl.greenCircle.setRadius(green);
      zl.yellowCircle.setRadius(yellow);
    }
  } else {
    if (state.editingZone._previewGreen) state.editingZone._previewGreen.setRadius(green);
    if (state.editingZone._previewYellow) state.editingZone._previewYellow.setRadius(yellow);
  }
}

async function saveZone() {
  const name = $("#zone-name").value.trim();
  const green = parseInt($("#zone-green").value);
  const yellow = parseInt($("#zone-yellow").value);
  if (!name) return;

  const payload = {
    name,
    lat: state.editingZone.lat,
    lng: state.editingZone.lng,
    radius_green: green,
    radius_yellow: yellow,
  };

  if (state.editingZone.id) {
    await state.supabase.from("tt_zones").update(payload).eq("id", state.editingZone.id);
  } else {
    await state.supabase.from("tt_zones").insert(payload);
  }

  await loadZones();
  renderZonesOnMap();
  closeZonePanel();
  showToast("Zone saved");
}

async function deleteZone() {
  if (!state.editingZone || !state.editingZone.id) return;
  await state.supabase.from("tt_zones").delete().eq("id", state.editingZone.id);
  await loadZones();
  renderZonesOnMap();
  closeZonePanel();
  showToast("Zone deleted");
}

function closeZonePanel() {
  if (state.editingZone?._previewGreen) state.leafletMap.removeLayer(state.editingZone._previewGreen);
  if (state.editingZone?._previewYellow) state.leafletMap.removeLayer(state.editingZone._previewYellow);
  state.editingZone = null;
  $("#zone-panel").classList.add("hidden");
}

// --- Shock Collar (Easter Egg) ---
const SHOCK_LEVELS = [
  { emoji: "😊", label: "Gentle Reminder", volt: "50V", effect: "A warm tingle" },
  { emoji: "😬", label: "Wake Up Call", volt: "500V", effect: "That got attention" },
  { emoji: "🤯", label: "Attitude Adjustment", volt: "5,000V", effect: "Hair standing up" },
  { emoji: "💀", label: "You're Fired", volt: "50,000V", effect: "Terminated" },
];

function openShockModal(name) {
  // Remove existing
  document.querySelectorAll(".shock-modal-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "shock-modal-overlay";
  const levelsHtml = SHOCK_LEVELS.map((l, i) => `
    <button class="shock-level" data-level="${i}">
      <span class="shock-emoji">${l.emoji}</span>
      <span class="shock-label">${l.label}</span>
      <span class="shock-volt">${l.volt}</span>
    </button>
  `).join("");

  overlay.innerHTML = `
    <div class="shock-modal">
      <h3>⚡ Shock Collar — ${esc(name)}</h3>
      <p class="shock-subtitle">Select intensity level:</p>
      <div class="shock-levels">${levelsHtml}</div>
      <button class="shock-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector(".shock-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll(".shock-level").forEach((btn) => {
    btn.addEventListener("click", () => {
      const level = SHOCK_LEVELS[btn.dataset.level];
      overlay.querySelector(".shock-modal").innerHTML = `
        <div class="shock-animation">
          <div class="shock-zap">⚡</div>
          <div class="shock-target">${level.emoji}</div>
          <h3>${esc(name)}</h3>
          <p class="shock-effect">${level.effect}</p>
          <p class="shock-volt-big">${level.volt}</p>
        </div>
      `;
      overlay.querySelector(".shock-modal").classList.add("shocking");
      setTimeout(() => overlay.remove(), 2500);
    });
  });
}
