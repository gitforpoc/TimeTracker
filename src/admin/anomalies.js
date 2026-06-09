// Data-integrity anomaly detectors for shift data. Pure (no DOM/Supabase) so they're unit-tested
// and reusable by the dashboard's "Right Now" alerts and any future scheduled integrity check.
//
// Why this exists: a late-syncing real Clock In/Out tap colliding with a manual backfill
// (Add Shift / direct SQL) produced DUPLICATE shifts that got silently summed into payroll at OT
// rates (Jairo inflated ~100h → ~149h). The dashboard said "all good" because it only checked
// OT/cap/open-shifts, never duplicates. These detectors make that visible.

function toMs(v) {
  return new Date(v).getTime();
}

// Overlapping work-shift pairs per employee, using half-open [clock_in, clock_out) intervals so
// back-to-back shifts that merely touch are NOT flagged. Only closed work shifts are considered
// (open shifts have no end; they're surfaced by a separate open-shift alert).
// Returns { count, names } — count = number of overlapping pairs, names = distinct employees.
export function findOverlappingShifts(shifts) {
  const byEmp = {};
  for (const s of shifts) {
    if (s.type !== "work" || !s.clock_in || !s.clock_out) continue;
    (byEmp[s.user_name] ||= []).push(s);
  }
  const names = new Set();
  let count = 0;
  for (const list of Object.values(byEmp)) {
    list.sort((a, b) => toMs(a.clock_in) - toMs(b.clock_in));
    for (let i = 0; i < list.length; i++) {
      const aIn = toMs(list[i].clock_in);
      const aOut = toMs(list[i].clock_out);
      for (let j = i + 1; j < list.length; j++) {
        const bIn = toMs(list[j].clock_in);
        if (bIn >= aOut) break; // sorted by clock_in — no later shift can overlap this one
        const bOut = toMs(list[j].clock_out);
        if (aIn < bOut && bIn < aOut) {
          count++;
          names.add(list[i].user_name);
        }
      }
    }
  }
  return { count, names: [...names] };
}

// Zero-minute micro-shifts: a closed work shift with 0 duration (accidental double Clock In→Out).
// Returns { count, names }.
export function findMicroShifts(shifts) {
  const micro = shifts.filter(
    (s) => s.type === "work" && s.clock_out && (s.duration_minutes || 0) === 0
  );
  return { count: micro.length, names: [...new Set(micro.map((s) => s.user_name))] };
}
