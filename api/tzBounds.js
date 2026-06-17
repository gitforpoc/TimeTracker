// Pay-period date boundaries in America/New_York, as UTC instants.
//
// Why this exists: tt_shifts.clock_in is a timestamptz. Filtering it against bare
// 'YYYY-MM-DDT00:00:00' strings makes Postgres interpret those strings as UTC, so
// an evening shift clocked in after ~8pm NY (which rolls into the NEXT UTC day) is
// bucketed into the WRONG pay period — e.g. a shift started 10pm on the 15th lands
// in the 16th-30th report instead of 1st-15th. We bucket by the NY-LOCAL clock_in
// date, which is what the worker app already does (it buckets in browser-local time).
//
// NOTE: an identical copy of nyDayStartUtc/nyOffsetMinutes lives in
// src/admin/helpers.js for the browser admin bundle (the api/ and src/ trees can't
// cleanly share a module across the Vercel build boundary). Keep them in sync —
// src/__tests__/tzBounds.test.js asserts the two copies agree.

// Minutes that America/New_York is ahead of UTC at the given instant.
// Negative because NY is behind UTC: -240 in EDT (summer), -300 in EST (winter).
export function nyOffsetMinutes(instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(instant).map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - instant.getTime()) / 60000;
}

// Given a 'YYYY-MM-DD' calendar date interpreted in America/New_York, return the
// UTC ISO instant of that day's 00:00 NY-local time. DST-aware. `addDays` lets a
// caller get an exclusive upper bound (next-day NY midnight): use it with `.lt()`.
export function nyDayStartUtc(dateStr, addDays = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d + addDays, 0, 0, 0));
  const offsetMin = nyOffsetMinutes(guess);
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}
