import { createClient } from "@supabase/supabase-js";

// Diagnostics intake. DELIBERATELY UNAUTHENTICATED.
//
// The whole point of this endpoint is to receive a device/sync report even when
// the user's session is broken — which is the most common thing we're trying to
// diagnose. If it required a valid Bearer token it would fail in exactly the
// cases that matter. So: no auth required to POST. If a token IS present we
// verify it (best-effort) and record whether it's currently valid — that single
// bit answers the "is this a 401 problem?" question.
//
// Abuse is bounded by: a required app marker, a body-size cap, and the fact the
// endpoint only ever inserts into a tiny append-only table. It is not linked
// from any public surface. Add a shared key later if it ever gets hit.

const MAX_BODY_BYTES = 32 * 1024; // 32 KB — a report is ~1-3 KB
const DIAG_RETENTION_DAYS = 30;   // throwaway debug data — auto-pruned on each insert

// Best-effort per-IP rate limit. The endpoint is unauthenticated by design, so
// this is the cheap backstop against a flood bloating tt_diagnostics.
const RATE_WINDOW_MS = 60 * 1000; // 1-minute sliding window
const RATE_MAX_PER_WINDOW = 10;   // generous — diagnostics are rare manual taps
const ipHits = new Map();         // ip -> number[] of recent hit timestamps

// Extract the client IP from proxy headers (Vercel sets x-forwarded-for).
export function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

// Sliding-window rate limit. Pure except for the `hits` map it's handed, so it
// unit-tests with a fresh Map. Returns true if `ip` is OVER the limit (reject).
// A null/empty ip is never limited.
//
// NOTE: in serverless this map lives only for a warm lambda instance and resets
// on cold start. That's acceptable — a flood keeps the instance warm (so it's
// caught), while legitimate infrequent diagnostics never accumulate. This is a
// backstop, not a hard guarantee; the app marker + 32KB cap + tiny append-only
// table bound the worst case regardless.
export function checkRateLimit(hits, ip, nowMs, windowMs = RATE_WINDOW_MS, max = RATE_MAX_PER_WINDOW) {
  if (!ip) return false;
  const recent = (hits.get(ip) || []).filter((t) => nowMs - t < windowMs);
  recent.push(nowMs);
  hits.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded on a long-lived instance.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => nowMs - t < windowMs)) hits.delete(k);
    }
  }
  return recent.length > max;
}

/**
 * Compute device-vs-server clock skew in seconds from the client's snapshot
 * time and the server's receive time. Positive = device clock AHEAD of server.
 *
 * The client-side connectivity block (RTT/status/skew) is null in the stored
 * report because those are only known AFTER the POST body was already sent.
 * Deriving skew here is robust and catches the wrong-device-clock cases that
 * trip the /api/submit hygiene guard. Includes sub-second upload latency —
 * negligible vs the minute/hour skews we care about. Returns null if unparseable.
 */
export function serverClockSkewSec(clientTimeIso, serverNowMs) {
  const clientMs = clientTimeIso ? new Date(clientTimeIso).getTime() : NaN;
  if (!Number.isFinite(clientMs) || !Number.isFinite(serverNowMs)) return null;
  return Math.round((clientMs - serverNowMs) / 1000);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Accept, Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = clientIp(req);
  if (checkRateLimit(ipHits, ip, Date.now())) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || typeof body.report !== "object") {
    return res.status(400).json({ error: "Invalid diagnostics payload" });
  }
  // Cheap anti-junk marker + size cap.
  if (body.report.app !== "timetracker") {
    return res.status(400).json({ error: "Unknown app" });
  }
  try {
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Report too large" });
    }
  } catch {
    return res.status(400).json({ error: "Unserializable payload" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Storage backend not configured" });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Best-effort token check (does NOT gate the insert).
  let tokenValid = null; // null = no token was sent
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    try {
      const { data, error } = await supabase.auth.getUser(token);
      tokenValid = !error && !!data?.user;
    } catch {
      tokenValid = false;
    }
  }

  const report = body.report;
  const userName =
    typeof report.userName === "string" ? report.userName.trim().slice(0, 120) : null;
  const userAgent =
    typeof report.device?.ua === "string" ? report.device.ua.slice(0, 500) : null;
  const online =
    typeof report.device?.online === "boolean" ? report.device.online : null;

  // Stamp the server-resolved truth so the client can't lie about these.
  const serverNowMs = Date.now();
  report.tokenValidServer = tokenValid;
  report.serverReceivedAt = new Date(serverNowMs).toISOString();
  report.serverClientIp = ip; // forensics: which device/network sent this
  // Persist clock skew server-side (the client's connectivity block never makes
  // it into the stored body — see serverClockSkewSec docs).
  const skew = serverClockSkewSec(report.clientTime, serverNowMs);
  if (skew !== null) {
    report.connectivity =
      report.connectivity && typeof report.connectivity === "object"
        ? report.connectivity
        : {};
    report.connectivity.serverClockSkewSec = skew;
    report.connectivity.diagPostStatus = 200; // it reached us, by definition
  }

  const { error: insertErr } = await supabase.from("tt_diagnostics").insert([
    {
      user_name: userName,
      token_valid: tokenValid,
      user_agent: userAgent,
      online,
      report,
    },
  ]);

  if (insertErr) {
    console.error("Diagnostics insert failed:", insertErr.message);
    return res.status(500).json({ ok: false, error: "Could not store report" });
  }

  // Opportunistic retention: prune reports older than the TTL. Diagnostics are
  // throwaway debug data (no legal retention like tt_logs/tt_shifts). Best-effort
  // and self-maintaining — no cron needed; a prune failure must not fail the
  // submit (the report we just stored is what matters).
  try {
    const cutoff = new Date(
      serverNowMs - DIAG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await supabase.from("tt_diagnostics").delete().lt("created_at", cutoff);
  } catch (e) {
    console.error("Diagnostics prune failed (non-fatal):", e?.message || e);
  }

  // serverTime lets the client compute device clock skew (accounting for RTT).
  return res.status(200).json({
    ok: true,
    serverTime: Date.now(),
    tokenValid,
  });
}
