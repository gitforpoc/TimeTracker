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
  report.tokenValidServer = tokenValid;
  report.serverReceivedAt = new Date().toISOString();

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

  // serverTime lets the client compute device clock skew (accounting for RTT).
  return res.status(200).json({
    ok: true,
    serverTime: Date.now(),
    tokenValid,
  });
}
