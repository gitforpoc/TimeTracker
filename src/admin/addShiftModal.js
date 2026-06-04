import { state } from "./state.js";
import { $, esc, showToast, formatDateISO } from "./helpers.js";
import { loadShifts } from "./shifts.js";

// --- Add Shift Modal ---
// Supervisor-initiated path for creating a fully-formed past shift when an
// employee forgot to clock in/out. POSTs to /api/add-shift, which writes
// directly to tt_shifts (bypassing tt_process_log_entry trigger) and inserts
// an audit row with sentinel field_changed="created".

export function setupAddShiftListeners() {
  const btn = $("#add-shift-btn");
  if (btn) btn.addEventListener("click", openAddShiftModal);

  $("#add-shift-cancel")?.addEventListener("click", closeAddShiftModal);
  $("#add-shift-overlay")?.addEventListener("click", closeAddShiftModal);
  $("#add-shift-save")?.addEventListener("click", saveAddShift);

  // Reveal/hide the free-text textarea when "Other" is chosen.
  $("#add-shift-reason-preset")?.addEventListener("change", (e) => {
    const wrap = $("#add-shift-reason-other-wrap");
    if (!wrap) return;
    if (e.target.value === "__other__") wrap.classList.remove("hidden");
    else wrap.classList.add("hidden");
  });
}

function openAddShiftModal() {
  // Populate employee dropdown from active employees only
  const empSelect = $("#add-shift-employee");
  while (empSelect.options.length > 1) empSelect.remove(1);
  const active = (state.employeeSettings || []).filter((e) => e.active !== false);
  active
    .map((e) => e.user_name)
    .filter(Boolean)
    .sort()
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      empSelect.appendChild(opt);
    });

  // Default date = yesterday (most common "forgot to clock in/out" case)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  $("#add-shift-date").value = formatDateISO(yesterday);
  // Cap the date input at today so the picker UI gently discourages future dates.
  $("#add-shift-date").max = formatDateISO(new Date());

  // Clear other fields
  $("#add-shift-employee").value = "";
  $("#add-shift-in").value = "";
  $("#add-shift-out").value = "";
  $("#add-shift-type").value = "work";
  $("#add-shift-comment").value = "";
  $("#add-shift-reason-preset").value = "Employee forgot to clock in";
  $("#add-shift-reason-other").value = "";
  $("#add-shift-reason-other-wrap").classList.add("hidden");
  clearError();

  $("#add-shift-modal").classList.remove("hidden");
  $("#add-shift-overlay").classList.remove("hidden");
}

function closeAddShiftModal() {
  $("#add-shift-modal").classList.add("hidden");
  $("#add-shift-overlay").classList.add("hidden");
  clearError();
}

function showError(msg) {
  const el = $("#add-shift-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function clearError() {
  const el = $("#add-shift-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

/**
 * Compose an ISO timestamp from "YYYY-MM-DD" + "HH:MM" treating it as local
 * (browser) wall-clock time. The admin is in NY tz in practice; the browser's
 * local tz is the correct interpretation (same approach as editModal.js
 * `toLocalDatetimeStr` round-trip).
 */
function composeLocalISO(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  // `new Date("YYYY-MM-DDTHH:MM")` parses as local. Then toISOString() to UTC.
  const d = new Date(`${dateStr}T${timeStr}`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function saveAddShift() {
  clearError();

  const userName = $("#add-shift-employee").value;
  const dateStr = $("#add-shift-date").value;
  const inStr = $("#add-shift-in").value;
  const outStr = $("#add-shift-out").value;
  const type = $("#add-shift-type").value;
  const comment = $("#add-shift-comment").value.trim();
  const preset = $("#add-shift-reason-preset").value;
  const otherReason = $("#add-shift-reason-other").value.trim();

  // Client-side validation (mirrored on server)
  if (!userName) return showError("Please select an employee.");
  if (!dateStr) return showError("Please pick a date.");
  if (!inStr) return showError("Please enter a Clock In time.");
  if (!outStr) return showError("Please enter a Clock Out time.");

  const clockInISO = composeLocalISO(dateStr, inStr);
  const clockOutISO = composeLocalISO(dateStr, outStr);
  if (!clockInISO || !clockOutISO) {
    return showError("Invalid date or time.");
  }

  // If clock out time <= clock in time on the same day, assume same-day-only
  // (no overnight support from this UI) → reject. Admins can use Edit Shift
  // for overnight corrections.
  if (new Date(clockOutISO).getTime() <= new Date(clockInISO).getTime()) {
    return showError("Clock Out must be after Clock In on the same day.");
  }

  // Date not in the future (compare date strings to avoid tz off-by-one)
  if (dateStr > formatDateISO(new Date())) {
    return showError("Date cannot be in the future.");
  }

  const reason = preset === "__other__" ? otherReason : preset;
  if (!reason) return showError("Please provide a reason.");

  const btn = $("#add-shift-save");
  btn.disabled = true;
  btn.textContent = "Adding…";

  try {
    const res = await fetch("/api/add-shift", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.authToken}`,
      },
      body: JSON.stringify({
        user_name: userName,
        clock_in: clockInISO,
        clock_out: clockOutISO,
        type,
        comment: comment || null,
        reason,
      }),
    });

    const result = await res.json().catch(() => ({}));

    if (res.status === 409) {
      // Overlap — keep the modal open with the error inline so admin can adjust
      showError(result.error || "Shift overlaps an existing shift.");
      return;
    }
    if (!res.ok) {
      showError(result.error || `Error ${res.status}`);
      return;
    }

    showToast("Shift added");
    closeAddShiftModal();
    // Re-render the Shift Log so the new row appears.
    loadShifts();
  } catch (err) {
    console.error("add-shift network error:", err);
    showError("Network error. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Shift";
  }
}
