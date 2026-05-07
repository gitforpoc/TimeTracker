// Forecast helper — predicts end-of-period hours per employee.
//
// Strategy: walk through every remaining calendar day in the period and add expected hours.
// For each day:
//   1. Schedule CSV has an entry for this user (incl. "0,0" = explicit day off) → use it.
//   2. No schedule entry, day is a heat day (25-EOM, 1-2 next month) → 10h flat.
//      Boss-confirmed pattern: moving company spike, no day off taken.
//   3. No schedule entry, regular day → 8.4h × 6/7 ≈ 7.2h to account for "typical 1 day off / week".
//
// The 8.4h baseline is the historical median shift (analyzed across 279 shifts excluding the
// 4 heaviest workers + test users). 10h is the observed avg on heat days.
//
// Returns { actualMin, scheduledRemainingMin, predictedMin, basis }
//   - basis: "schedule" (all remaining days had explicit entries)
//          | "heuristic" (no schedule data for any remaining day)
//          | "mixed"     (some days had schedule, others used heuristic)
//          | "actual_only" (period over or no remaining days)

import {
  FORECAST_DEFAULT_SHIFT_MIN,
  FORECAST_HEAT_DAY_SHIFT_MIN,
  FORECAST_WORK_DAY_RATIO,
} from "../constants.js";
import { isHeatDay } from "../payPeriods.js";

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function expectedMinutesForDay(date) {
  return isHeatDay(date)
    ? FORECAST_HEAT_DAY_SHIFT_MIN
    : FORECAST_DEFAULT_SHIFT_MIN * FORECAST_WORK_DAY_RATIO;
}

export function forecastEmployeeHours(opts) {
  const {
    userName,
    actualMinutes,
    periodStart,
    periodEnd,
    scheduleMap,
    now = new Date(),
  } = opts;

  // Period over → no forecast needed; today's hours are the final answer.
  if (now > periodEnd) {
    return { actualMin: actualMinutes, scheduledRemainingMin: 0, predictedMin: actualMinutes, basis: "actual_only" };
  }

  // Today is partially-done — its actual hours are already in actualMinutes, so we don't double
  // count by re-adding scheduled/heuristic hours for today. Start the walk from tomorrow.
  const cur = new Date(now);
  cur.setHours(0, 0, 0, 0);
  cur.setDate(cur.getDate() + 1);

  let estimatedMin = 0;
  let scheduleHits = 0;
  let heuristicHits = 0;

  while (cur <= periodEnd) {
    const iso = toISODate(cur);
    const entry = scheduleMap?.get(iso)?.get(userName);

    if (entry !== undefined) {
      // Explicit schedule entry (planMinutes=0 means day off — included as 0 contribution)
      estimatedMin += entry.planMinutes;
      scheduleHits++;
    } else {
      estimatedMin += expectedMinutesForDay(cur);
      heuristicHits++;
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (scheduleHits === 0 && heuristicHits === 0) {
    return { actualMin: actualMinutes, scheduledRemainingMin: 0, predictedMin: actualMinutes, basis: "actual_only" };
  }

  const basis = heuristicHits === 0 ? "schedule"
              : scheduleHits === 0 ? "heuristic"
              : "mixed";

  return {
    actualMin: actualMinutes,
    scheduledRemainingMin: Math.round(estimatedMin),
    predictedMin: Math.round(actualMinutes + estimatedMin),
    basis,
  };
}
