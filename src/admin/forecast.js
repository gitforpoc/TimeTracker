// Forecast helper for predicting end-of-period hours per employee.
//
// Strategy (in order of preference):
//   1. Schedule-based: if the schedule CSV has planned hours for the remaining days, use those.
//      Most accurate — these are hours the supervisor actually planned.
//   2. Linear extrapolation: actual hours so far / days elapsed × total days in period.
//      Falls back to this when schedule has no data (e.g., past last sheet update or for new hires).
//
// Returns { actualMin, scheduledRemainingMin, predictedMin, basis }
//   - basis: "schedule" | "linear" | "actual_only" (when period is over / no remaining days)

import { sumScheduledMinutes } from "./schedule.js";

const MS_PER_DAY = 86400000;

function diffDaysFloor(a, b) {
  const aMid = new Date(a); aMid.setHours(0, 0, 0, 0);
  const bMid = new Date(b); bMid.setHours(0, 0, 0, 0);
  return Math.round((aMid.getTime() - bMid.getTime()) / MS_PER_DAY);
}

// `now` is the current time; defaults to "real now". Tests pass an explicit value.
export function forecastEmployeeHours(opts) {
  const {
    userName,
    actualMinutes,
    periodStart,
    periodEnd,
    scheduleMap,
    now = new Date(),
  } = opts;

  // Period is over → no forecast needed.
  if (now > periodEnd) {
    return { actualMin: actualMinutes, scheduledRemainingMin: 0, predictedMin: actualMinutes, basis: "actual_only" };
  }

  // Tomorrow is the first remaining day. (Today is partially done — we already include
  // its actual hours in actualMinutes, and we don't want to double-count its scheduled hours.)
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Try schedule-based remaining hours first.
  let scheduledRemaining = 0;
  if (scheduleMap && tomorrow <= periodEnd) {
    scheduledRemaining = sumScheduledMinutes(scheduleMap, userName, tomorrow, periodEnd);
  }

  if (scheduledRemaining > 0) {
    return {
      actualMin: actualMinutes,
      scheduledRemainingMin: scheduledRemaining,
      predictedMin: actualMinutes + scheduledRemaining,
      basis: "schedule",
    };
  }

  // Fall back to linear extrapolation. Anchor on whole calendar days, not hours, to avoid
  // wild swings early in the period (when partial day 1 would over-extrapolate).
  const daysElapsed = Math.max(1, diffDaysFloor(now, periodStart) + 1); // +1 because day 1 counts
  const daysTotal = diffDaysFloor(periodEnd, periodStart) + 1;
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  if (daysRemaining === 0 || actualMinutes === 0) {
    return { actualMin: actualMinutes, scheduledRemainingMin: 0, predictedMin: actualMinutes, basis: "actual_only" };
  }

  const ratePerDayMin = actualMinutes / daysElapsed;
  const projectedRemaining = ratePerDayMin * daysRemaining;
  return {
    actualMin: actualMinutes,
    scheduledRemainingMin: Math.round(projectedRemaining),
    predictedMin: Math.round(actualMinutes + projectedRemaining),
    basis: "linear",
  };
}
