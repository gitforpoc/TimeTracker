import "./admin.css";
import { checkAdminAuth, getSupabaseClient } from "../auth.js";
import { state } from "./state.js";
import { $, $$, formatDateISO, saveSession, loadSession } from "./helpers.js";
import { loadStatus } from "./status.js";
import { setupFilters, loadShifts, loadEmployeeList } from "./shifts.js";
import { setupEditListeners, closeEditModal, closeConfirmModal } from "./editModal.js";
import { initMap } from "./map.js";
import { loadZones } from "./map.js";
import { setupDashboardNav, initDashPeriod, loadDashboard } from "./dashboard.js";
import { loadEmployeesTab } from "./employees.js";

// --- Session state ---
function persistState() {
  saveSession({
    tab: state.currentTab,
    filterStart: $("#filter-start")?.value,
    filterEnd: $("#filter-end")?.value,
    filterEmployee: $("#filter-employee")?.value,
    filterWarehouse: ($("#filter-warehouse") || {}).value,
    filterZone: ($("#filter-zone") || {}).value,
    empWarehouse: ($("#emp-warehouse-filter") || {}).value,
  });
}

// --- Login ---
function setupLogin() {
  const form = $("#login-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    const btn = form.querySelector(".login-btn");
    const errEl = $("#login-error");
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Signing in...";

    try {
      const { getSupabaseClient } = await import("../auth.js");
      const client = getSupabaseClient();
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        errEl.textContent = error.message;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Sign In";
        return;
      }
      // Reload to re-check auth
      location.reload();
    } catch {
      errEl.textContent = "Connection error. Try again.";
      errEl.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  });
}

// --- Init ---
async function init() {
  const auth = await checkAdminAuth();

  if (!auth) {
    $("#auth-gate").classList.add("hidden");
    // Check if user has a session but no admin role
    const client = getSupabaseClient();
    const { data: { session } } = await client.auth.getSession();
    if (session) {
      // Logged in but not admin/supervisor
      $("#access-denied").classList.remove("hidden");
    } else {
      // No session at all — show login form
      $("#login-screen").classList.remove("hidden");
      setupLogin();
    }
    return;
  }

  state.supabase = getSupabaseClient();
  const { data: { session } } = await state.supabase.auth.getSession();
  state.authToken = session?.access_token;
  $("#admin-name").textContent = auth.name;
  $("#auth-gate").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");

  const saved = loadSession();

  // Set default date range (current week, Mon-today) or restore
  if (saved?.filterStart) {
    $("#filter-start").value = saved.filterStart;
    $("#filter-end").value = saved.filterEnd;
  } else {
    const today = new Date();
    const monday = new Date(today);
    const dayOfWeek = today.getDay();
    const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    monday.setDate(today.getDate() - daysBack);
    $("#filter-start").value = formatDateISO(monday);
    $("#filter-end").value = formatDateISO(today);
  }

  setupTabs();
  setupFilters();
  setupKeyboard();
  setupDashboardNav();
  await loadEmployeeList();
  loadZones(); // preload zones for geo icons
  loadStatus();
  initDashPeriod();

  // Restore filters after employee list is loaded
  if (saved) {
    if (saved.filterWarehouse && $("#filter-warehouse")) $("#filter-warehouse").value = saved.filterWarehouse;
    if (saved.filterEmployee) $("#filter-employee").value = saved.filterEmployee;
    if (saved.filterZone && $("#filter-zone")) $("#filter-zone").value = saved.filterZone;
    if (saved.empWarehouse && $("#emp-warehouse-filter")) $("#emp-warehouse-filter").value = saved.empWarehouse;
  }

  // Restore active tab or default to dashboard
  const restoreTab = saved?.tab || "dashboard";
  if (restoreTab !== "dashboard") {
    const tabBtn = $(`.tab[data-tab="${restoreTab}"]`);
    if (tabBtn) tabBtn.click();
  } else {
    loadDashboard();
  }

  // Auto-refresh status every 60s
  state.statusInterval = setInterval(() => {
    if (state.currentTab === "status") loadStatus();
  }, 60000);

  // Persist state on page unload
  window.addEventListener("beforeunload", persistState);
}

// --- Tabs ---
function setupTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.currentTab = tab.dataset.tab;

      $$(".tab-content").forEach((c) => {
        c.classList.add("hidden");
        c.classList.remove("active-tab");
      });
      const target = $(`#tab-${state.currentTab}`);
      target.classList.remove("hidden");
      // Trigger transition after removing hidden
      requestAnimationFrame(() => target.classList.add("active-tab"));

      persistState();

      // Auto-load on tab switch
      if (state.currentTab === "dashboard") loadDashboard();
      if (state.currentTab === "employees") loadEmployeesTab();
      if (state.currentTab === "shifts") loadShifts();
      if (state.currentTab === "map") initMap();
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

// --- Start ---
setupEditListeners();
init();
