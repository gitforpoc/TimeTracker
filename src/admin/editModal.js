import { state } from "./state.js";
import { $, $$, esc, showToast } from "./helpers.js";
import { loadShifts } from "./shifts.js";

// --- Edit Modal ---
export function setupEditListeners() {
  document.addEventListener("click", (e) => {
    // Edit button
    if (e.target.classList.contains("btn-edit")) {
      const id = Number(e.target.dataset.id);
      const shift = state.shiftsData.find((s) => s.id === id);
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
  state.editOriginal = {
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
    clockIn: clockIn.value !== state.editOriginal.clockIn,
    clockOut: clockOut.value !== state.editOriginal.clockOut,
    type: type.value !== state.editOriginal.type,
    comment: comment.value !== state.editOriginal.comment,
  };

  // Highlight changed fields
  clockIn.closest("label").classList.toggle("field-changed", changes.clockIn);
  clockOut.closest("label").classList.toggle("field-changed", changes.clockOut);
  type.closest("label").classList.toggle("field-changed", changes.type);
  comment.closest("label").classList.toggle("field-changed", changes.comment);

  const hasChanges = Object.values(changes).some(Boolean);
  $("#edit-save").disabled = !hasChanges;
}

export function closeEditModal() {
  $("#edit-modal").classList.add("hidden");
  $("#edit-overlay").classList.add("hidden");
}

function confirmBeforeSave() {
  // Build change summary
  const changes = [];
  if ($("#edit-clock-in").value !== state.editOriginal.clockIn) {
    changes.push(`<strong>Clock In:</strong> ${state.editOriginal.clockIn || "(empty)"} → ${$("#edit-clock-in").value || "(empty)"}`);
  }
  if ($("#edit-clock-out").value !== state.editOriginal.clockOut) {
    changes.push(`<strong>Clock Out:</strong> ${state.editOriginal.clockOut || "(empty)"} → ${$("#edit-clock-out").value || "(empty)"}`);
  }
  if ($("#edit-type").value !== state.editOriginal.type) {
    changes.push(`<strong>Type:</strong> ${state.editOriginal.type} → ${$("#edit-type").value}`);
  }
  if ($("#edit-comment").value !== state.editOriginal.comment) {
    changes.push(`<strong>Comment:</strong> "${state.editOriginal.comment || "(empty)"}" → "${$("#edit-comment").value || "(empty)"}"`);
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

export function closeConfirmModal() {
  $("#confirm-modal").classList.add("hidden");
  $("#confirm-overlay").classList.add("hidden");
}

async function saveEdit() {
  closeConfirmModal();

  const shiftId = Number($("#edit-modal").dataset.shiftId);
  const shift = state.shiftsData.find((s) => s.id === shiftId);
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
        Authorization: `Bearer ${state.authToken}`,
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

  const edits = state.editsMap[shiftId];
  if (!edits || edits.length === 0) return;

  const popover = document.createElement("div");
  popover.className = "edit-popover";

  const rows = edits.map((e) => {
    const time = new Date(e.created_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const isAdmin = e.edited_by_name !== state.shiftsData.find((s) => s.id === shiftId)?.user_name;
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
