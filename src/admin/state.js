// Shared mutable state for admin modules
export const state = {
  supabase: null,
  authToken: null,
  currentTab: "dashboard",
  shiftsData: [],
  editsMap: {},
  geoMap: {},
  currentPage: 0,
  PAGE_SIZE: 50,
  statusInterval: null,
  workingNames: [], // names of currently working employees
  editOriginal: {}, // original values when edit modal opens
  zonesData: [], // from tt_zones
  leafletMap: null,
  zoneLayers: [], // { zone, greenCircle, yellowCircle, marker }
  employeeLayers: [], // employee markers on map
  editingZone: null, // zone being edited
  dashPeriod: null, // { start: Date, end: Date, label: string }
  payPeriodType: "bi_weekly", // company-wide period type for admin views: semi_monthly | bi_weekly | weekly | custom
  customPeriod: null, // { start: Date, end: Date } when payPeriodType === "custom"
  employeeSettings: [], // from tt_employee_settings
  adminRole: null, // 'admin' or 'supervisor' — admin sees pay rates, supervisor doesn't
  loadToken: 0, // monotonic counter to ignore stale async results after rapid period changes
  scheduleMap: null, // Map<dateISO, Map<userName, {planMinutes,...}>> — lazy-loaded from /schedule.csv
};

// Helper: only admins should see/edit pay rates and $ amounts. Supervisors see hours only.
export function isAdmin() {
  return state.adminRole === "admin";
}
