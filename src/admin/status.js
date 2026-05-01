import { state } from "./state.js";
import { $, esc, calcDuration, formatDateISO } from "./helpers.js";
import { getWorkWeekStart } from "../payPeriods.js";

// --- Live Status ---
export async function loadStatus() {
  const loading = $("#status-loading");
  const table = $("#status-table");
  loading.classList.remove("hidden");
  table.style.opacity = "0.4";

  const now = new Date();
  const weekStart = getWorkWeekStart(now);
  const weekStartISO = formatDateISO(weekStart);

  const [statusResult, weekShiftsResult, settingsResult] = await Promise.all([
    state.supabase.rpc("tt_get_user_statuses"),
    state.supabase
      .from("tt_shifts")
      .select("user_name, clock_in, clock_out, duration_minutes, type")
      .eq("type", "work")
      .gte("clock_in", `${weekStartISO}T00:00:00`)
      .limit(2000),
    state.employeeSettings && state.employeeSettings.length > 0
      ? Promise.resolve({ data: state.employeeSettings })
      : state.supabase.from("tt_employee_settings").select("*"),
  ]);

  loading.classList.add("hidden");
  table.style.opacity = "1";

  if (statusResult.error) {
    console.error("Status error:", statusResult.error);
    return;
  }

  const data = statusResult.data;
  const weekShifts = weekShiftsResult.data || [];
  const settings = settingsResult.data || [];
  state.employeeSettings = settings;

  // Sum week hours per employee. Open shifts (no clock_out): count time elapsed since clock_in.
  const weekMinByName = {};
  weekShifts.forEach((s) => {
    if (!weekMinByName[s.user_name]) weekMinByName[s.user_name] = 0;
    if (s.clock_out) {
      weekMinByName[s.user_name] += s.duration_minutes || 0;
    } else {
      // Open shift — count elapsed minutes from clock_in to now
      const elapsed = Math.max(0, (now - new Date(s.clock_in)) / 60000);
      weekMinByName[s.user_name] += elapsed;
    }
  });

  const settingsByName = {};
  settings.forEach((s) => { settingsByName[s.user_name] = s; });

  // Filter out soft-deleted (inactive) employees from the live view
  const active = data.filter((u) => settingsByName[u.user_name]?.active !== false);
  const working = active.filter((u) => u.action === "Clock In");
  const offline = active.filter((u) => u.action !== "Clock In");
  const sorted = [...working, ...offline];

  // Update working names for filter
  state.workingNames = working.map((u) => u.user_name);

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

      // Week-so-far cell
      const empSettings = settingsByName[u.user_name];
      const empType = empSettings?.employment_type;
      const typeBadge = empType ? `<span class="status-type-badge type-${empType.toLowerCase()}">${esc(empType)}</span>` : "";
      const weekMin = weekMinByName[u.user_name] || 0;
      const weekH = Math.round(weekMin / 60 * 10) / 10;
      const threshold = empSettings?.overtime_threshold || 40;
      let weekCell;
      if (empType === "W2") {
        const pct = Math.min(150, Math.round((weekH / threshold) * 100));
        const barClass = weekH > threshold ? "over" : weekH >= threshold - 5 ? "near" : "";
        weekCell = `<div class="week-progress">
          <div class="week-progress-bar"><div class="week-progress-fill ${barClass}" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="week-progress-text">${weekH}h / ${threshold}h</span>
        </div>`;
      } else if (weekMin > 0) {
        weekCell = `<span class="week-simple">${weekH}h</span>`;
      } else {
        weekCell = "—";
      }

      return `<tr class="${statusClass}">
        <td>${esc(u.user_name)}${typeBadge}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td class="${durationClass}">${duration}</td>
        <td>${weekCell}</td>
      </tr>`;
    })
    .join("");

  $("#refresh-status").onclick = loadStatus;
}
