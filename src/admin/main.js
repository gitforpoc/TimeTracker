import "./admin.css";
import { checkAdminAuth, getSupabaseClient } from "../auth.js";
import { state } from "./state.js";
import { $, $$, formatDateISO } from "./helpers.js";
import { loadStatus } from "./status.js";
import { setupFilters, loadShifts, loadEmployeeList } from "./shifts.js";
import { setupEditListeners, closeEditModal, closeConfirmModal } from "./editModal.js";
import { initMap } from "./map.js";
import { loadZones } from "./map.js";
import { setupDashboardNav, initDashPeriod, loadDashboard } from "./dashboard.js";
import { loadEmployeesTab } from "./employees.js";

// --- Init ---
async function init() {
  const auth = await checkAdminAuth();

  if (!auth) {
    $("#auth-gate").classList.add("hidden");
    $("#access-denied").classList.remove("hidden");
    return;
  }

  state.supabase = getSupabaseClient();
  const { data: { session } } = await state.supabase.auth.getSession();
  state.authToken = session?.access_token;
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
  setupDashboardNav();
  loadEmployeeList();
  loadZones(); // preload zones for geo icons
  loadStatus();
  initDashPeriod();
  loadDashboard();

  // Auto-refresh status every 60s
  state.statusInterval = setInterval(() => {
    if (state.currentTab === "status") loadStatus();
  }, 60000);
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
