import { state } from "./state.js";
import { $, esc, calcDuration, formatDateISO } from "./helpers.js";
import { getBiWeeklyPeriod, effectiveShiftMinutes } from "../payPeriods.js";
import { SOFT_CAP_HOURS } from "../constants.js";

// --- Live Status ---
export async function loadStatus() {
  const loading = $("#status-loading");
  const table = $("#status-table");
  loading.classList.remove("hidden");
  table.style.opacity = "0.4";

  const now = new Date();
  const period = getBiWeeklyPeriod(now);
  const periodStartISO = formatDateISO(period.start);
  const periodEndISO = formatDateISO(period.end);

  const [statusResult, periodShiftsResult, settingsResult] = await Promise.all([
    state.supabase.rpc("tt_get_user_statuses"),
    state.supabase
      .from("tt_shifts")
      .select("user_name, clock_in, clock_out, duration_minutes, type")
      .eq("type", "work")
      .gte("clock_in", `${periodStartISO}T00:00:00`)
      .lte("clock_in", `${periodEndISO}T23:59:59`)
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
  const periodShifts = periodShiftsResult.data || [];
  const settings = settingsResult.data || [];
  state.employeeSettings = settings;

  // Sum pay-period hours per employee. effectiveShiftMinutes handles open shifts (counts elapsed
  // for active shifts, returns 0 for stale forgotten ones >16h old to avoid runaway totals).
  const periodMinByName = {};
  periodShifts.forEach((s) => {
    if (!periodMinByName[s.user_name]) periodMinByName[s.user_name] = 0;
    periodMinByName[s.user_name] += effectiveShiftMinutes(s, now);
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

      // Pay-period-so-far cell. Progress bar runs 0 → threshold (80h) → soft cap (120h).
      // Color escalates: green <60% of threshold, near (yellow) ≥75%, over (orange) past threshold,
      // cap (red) past soft cap.
      const empSettings = settingsByName[u.user_name];
      const empType = empSettings?.employment_type;
      const typeBadge = empType ? `<span class="status-type-badge type-${empType.toLowerCase()}">${esc(empType)}</span>` : "";
      const periodMin = periodMinByName[u.user_name] || 0;
      const periodH = Math.round(periodMin / 60 * 10) / 10;
      const threshold = empSettings?.overtime_threshold || 80;
      let periodCell;
      if (empType === "W2") {
        // Bar fills from 0 to soft cap (120h). At soft cap = 100% width.
        const pct = Math.min(100, Math.round((periodH / SOFT_CAP_HOURS) * 100));
        let barClass = "";
        if (periodH > SOFT_CAP_HOURS) barClass = "cap";
        else if (periodH > threshold) barClass = "over";
        else if (periodH >= threshold * 0.875) barClass = "near"; // ≥70h on 80h threshold
        periodCell = `<div class="week-progress">
          <div class="week-progress-bar"><div class="week-progress-fill ${barClass}" style="width:${pct}%"></div></div>
          <span class="week-progress-text">${periodH}h / ${threshold}h</span>
        </div>`;
      } else if (periodMin > 0) {
        periodCell = `<span class="week-simple">${periodH}h</span>`;
      } else {
        periodCell = "—";
      }

      return `<tr class="${statusClass}">
        <td>${esc(u.user_name)}${typeBadge}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td class="${durationClass}">${duration}</td>
        <td>${periodCell}</td>
      </tr>`;
    })
    .join("");

  $("#refresh-status").onclick = loadStatus;
}
