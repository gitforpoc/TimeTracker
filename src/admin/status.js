import { state } from "./state.js";
import { $, esc, calcDuration } from "./helpers.js";

// --- Live Status ---
export async function loadStatus() {
  const loading = $("#status-loading");
  const table = $("#status-table");
  loading.classList.remove("hidden");
  table.style.opacity = "0.4";

  const { data, error } = await state.supabase.rpc("tt_get_user_statuses");

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

      return `<tr class="${statusClass}">
        <td>${esc(u.user_name)}</td>
        <td><span class="dot ${statusClass}"></span> ${statusText}</td>
        <td>${u.local_string || "—"}</td>
        <td class="${durationClass}">${duration}</td>
      </tr>`;
    })
    .join("");

  $("#refresh-status").onclick = loadStatus;
}
