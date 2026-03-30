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
  employeeSettings: [], // from tt_employee_settings
};
