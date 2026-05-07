export const QUOTES = [
  "Precision in every move.",
  "Calm is a superpower.",
  "Be the solution.",
  "Make it look easy.",
  "Quality over speed.",
  "Safety first, speed second.",
  "Focus on the details.",
  "Stay professional.",
];

export const COMPLIANCE_MODE =
  import.meta.env.VITE_COMPLIANCE_MODE === "true";

export const STORAGE_KEYS = {
  DATA: "tt_data",
  STATUS: "tt_status",
  SHIFT_ID: "tt_shiftId",
  USER: "tt_user",
  AUTO_SHARE: "tt_autoShare",
  GEO_ENABLED: "tt_geoEnabled",
  SYNC_QUEUE: "tt_syncQueue",
  GPS_CONSENT: "tt_gpsConsent",
  DISCLAIMER_SEEN: "tt_disclaimerSeen",
};

export const PAY_PERIOD_TYPES = {
  SEMI_MONTHLY: "semi_monthly",
  BI_WEEKLY: "bi_weekly",
  WEEKLY: "weekly",
};

export const PAY_PERIOD_LABELS = {
  semi_monthly: "Semi-monthly (1-15 / 16-end)",
  bi_weekly: "Bi-weekly (Thu → Wed)",
  weekly: "Weekly (Thu → Wed)",
};

// Anchor for bi-weekly cycle: Thursday 2026-04-30 (period 1 first day).
// Period: Thu → Wed, 14 days. Mathematically equivalent to any Thursday offset by a multiple of 14 days.
export const BI_WEEKLY_ANCHOR = "2026-04-30";

// Workweek for FLSA OT calculation. FLSA allows ANY 7-consecutive-day window — employer chooses.
// We align with the bi-weekly pay period (Thursday) so pay period and workweek match.
// Day numbering: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
// To switch to traditional Mon-Sun, change to 1.
export const WORKWEEK_START_DAY = 4; // Thursday

// Overtime threshold — hours per PAY PERIOD (not per workweek), matching this company's actual payroll.
// Bi-weekly period of 80h = anything over → 1.5× rate. Soft cap (warning only) at 120h.
// Boss-confirmed 2026-05-05: company runs OT per pay period, not per FLSA workweek.
export const DEFAULT_OVERTIME_THRESHOLD = 80;
export const SOFT_CAP_HOURS = 120;

// Forecast heuristics — used when the schedule CSV doesn't have an entry for a remaining day.
// Numbers come from analyzing 279 historical shifts (excl. heaviest workers + tests, Jan-Apr 2026):
// median shift = 8.4h, avg = 8.9h. Heat-day boost = 10h (boss confirmed: end-of-month moving spike,
// no day off taken). 6/7 work ratio reflects "typically 1 day off per week" rule of thumb.
export const FORECAST_DEFAULT_SHIFT_MIN = 504;   // 8.4h
export const FORECAST_HEAT_DAY_SHIFT_MIN = 600;  // 10h
export const FORECAST_WORK_DAY_RATIO = 6 / 7;    // ≈0.857
