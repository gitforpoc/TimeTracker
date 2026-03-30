import { state } from "./state.js";

// --- Haversine Distance (meters) ---
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getZoneColor(lat, lng) {
  if (!state.zonesData.length) return "none";
  let best = "red";
  for (const z of state.zonesData) {
    const dist = haversine(lat, lng, z.lat, z.lng);
    if (dist <= z.radius_green) return "green";
    if (dist <= z.radius_yellow && best === "red") best = "yellow";
  }
  return best;
}

export function geoZoneLabel(shiftId) {
  const geo = state.geoMap[shiftId];
  if (!geo) return { color: "none", dist: null };
  const color = getZoneColor(geo.lat, geo.lng);
  // Distance to nearest zone center
  let dist = null;
  if (state.zonesData.length) {
    dist = Math.round(haversine(geo.lat, geo.lng, state.zonesData[0].lat, state.zonesData[0].lng));
  }
  return { color, dist };
}

// --- Helpers ---
export function geoIcon(shiftId) {
  const geo = state.geoMap[shiftId];
  if (!geo) return `<span class="geo-icon geo-none" title="No GPS" data-zone="none">📍</span>`;
  const { color, dist } = geoZoneLabel(shiftId);
  const icons = { green: "🟢", yellow: "🟡", red: "🔴" };
  const icon = icons[color] || "📍";
  const distText = dist !== null ? `${dist}m from zone` : "";
  return `<span class="geo-icon geo-zone geo-${color}" data-zone="${color}" data-shift="${shiftId}" title="${distText}" style="cursor:pointer">${icon}</span>`;
}
