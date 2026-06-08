import { createClient } from "@supabase/supabase-js";
import { checkClientTime } from "./submitGuard.js";

export default async function handler(req, res) {
  // Allow CORS to work from any domain (just in case)
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization"
  );

  // Handle browser preflight request (OPTIONS)
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // --- Auth: Bearer token required ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  const token = authHeader.replace("Bearer ", "");
  let authedUserId = null;
  try {
    const authSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: { user }, error: authError } = await authSupabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    authedUserId = user.id;
  } catch (e) {
    console.error("Auth check failed:", e);
    return res.status(503).json({ error: "Auth service unavailable" });
  }

  // --- Hygiene guard (Clock In / Clock Out only; Day Off / Paid Off target
  // arbitrary days). Bounds the DELIBERATE backdate (vs actual_tap_time, ≤12h)
  // and rejects only a clearly broken device clock (>35d past) or a future
  // time. It deliberately does NOT reject by sync delay — a real-time tap that
  // syncs hours/days late is correct data and must pass, otherwise it becomes a
  // permanently-rejected poison pill that blocks the queue. See submitGuard.js. ---
  const guard = checkClientTime(req.body, Date.now());
  if (!guard.ok) {
    return res.status(guard.status).json({ error: guard.error });
  }

  // Get URLs and Keys
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If neither is configured, return error
  if (!GOOGLE_SCRIPT_URL && (!SUPABASE_URL || !SUPABASE_KEY)) {
    return res.status(500).json({
      error: "Configuration Error",
      message: "No storage backend configured (Google Sheets or Supabase).",
    });
  }

  // 1. Google Sheets Task
  const taskGoogle = async () => {
    if (!GOOGLE_SCRIPT_URL) return { skipped: true };
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Error ${response.status}: ${text}`);
    }
    return await response.json();
  };

  // 2. Supabase Task
  const taskSupabase = async () => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return { skipped: true };
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { name, action, timestamp, localTime, type, targetId, comment, id, timezone, lat, lng, actual_tap_time } =
      req.body;

    // Sanitize name
    const cleanName = name ? name.trim() : "";
    let data, error;

    if (type === "comment") {
      // Update existing record
      ({ data, error } = await supabase
        .from("tt_logs")
        .update({ comment: comment })
        .eq("client_id", targetId));
    } else {
      // Dedup guard: check if this exact log already exists (syncQueue retries)
      const { data: existing } = await supabase
        .from("tt_logs")
        .select("id")
        .eq("client_id", id)
        .eq("action", action)
        .limit(1);

      if (existing && existing.length > 0) {
        return { success: true, deduplicated: true };
      }

      // Insert new record
      ({ data, error } = await supabase.from("tt_logs").insert([
        {
          user_name: cleanName,
          action: action,
          client_time: timestamp,
          local_string: localTime,
          client_id: id,
          payload: req.body,
          timezone: timezone || null,
          lat: lat != null ? lat : null,
          lng: lng != null ? lng : null,
        },
      ]));
    }

    if (error) throw new Error(`Supabase Error: ${error.message}`);

    // Best-effort: write a tt_edits "Backdated at..." audit row when the user
    // backdated. Eligible only for Clock In / Clock Out (Day Off / Paid Off
    // don't carry actual_tap_time). Failures are logged but don't break the
    // submit — the user's clock event already succeeded.
    if (
      actual_tap_time &&
      timestamp &&
      (action === "Clock In" || action === "Clock Out") &&
      Math.abs(new Date(actual_tap_time).getTime() - new Date(timestamp).getTime()) > 1000
    ) {
      try {
        await writeBackdateAudit(supabase, {
          userName: cleanName,
          action,
          chosenTimestamp: timestamp,
          actualTapTime: actual_tap_time,
          editorUserId: authedUserId,
          editorName: cleanName,
        });
      } catch (e) {
        console.error("Backdate audit write failed (non-fatal):", e?.message || e);
      }
    }

    return { success: true, data };
  };

  // Execute Dual Write
  const [googleResult, supabaseResult] = await Promise.allSettled([
    taskGoogle(),
    taskSupabase(),
  ]);

  // Check for complete failure
  if (
    googleResult.status === "rejected" &&
    supabaseResult.status === "rejected"
  ) {
    console.error(
      "All backends failed:",
      googleResult.reason,
      supabaseResult.reason
    );
    return res.status(500).json({
      result: "error",
      message: "Both Google Sheets and Supabase sync failed.",
      errors: {
        google: googleResult.reason?.toString(),
        supabase: supabaseResult.reason?.toString(),
      },
    });
  }

  // Return success if at least one worked
  return res.status(200).json({
    result: "success",
    google: googleResult.status === "fulfilled" ? "ok" : "failed",
    supabase: supabaseResult.status === "fulfilled" ? "ok" : "failed",
  });
}

/**
 * Insert a tt_edits "Backdated at clock-in"/"...clock-out" audit row.
 *
 * Strategy:
 *   - The tt_process_log_entry trigger has already updated/created the shift
 *     (clock_in = chosenTimestamp for Clock In, clock_out = chosenTimestamp
 *     for Clock Out). Look it up by user_name + that column.
 *   - reason starts with the literal "Backdated at" so the client filter in
 *     src/history.js can recognize this annotation and skip it for edit-quota
 *     purposes (initial entry, not a correction).
 *   - Errors are caller-handled (non-fatal — see taskSupabase try/catch).
 */
async function writeBackdateAudit(
  supabase,
  { userName, action, chosenTimestamp, actualTapTime, editorUserId, editorName }
) {
  const field = action === "Clock In" ? "clock_in" : "clock_out";
  const reason = action === "Clock In" ? "Backdated at clock-in" : "Backdated at clock-out";

  // Look up the shift just touched by the trigger. The trigger sets
  // clock_in (Clock In) or clock_out (Clock Out) = chosenTimestamp.
  let query = supabase
    .from("tt_shifts")
    .select("id")
    .eq("user_name", userName);

  if (action === "Clock In") {
    query = query.eq("clock_in", chosenTimestamp);
  } else {
    query = query.eq("clock_out", chosenTimestamp);
  }

  const { data: shifts, error: lookupErr } = await query
    .order("id", { ascending: false })
    .limit(1);

  if (lookupErr) {
    console.error("Backdate audit: shift lookup failed:", lookupErr.message);
    return;
  }
  if (!shifts || shifts.length === 0) {
    console.error(
      `Backdate audit: shift not found for ${userName} / ${field}=${chosenTimestamp}`
    );
    return;
  }

  const shiftId = shifts[0].id;
  const { error: insertErr } = await supabase.from("tt_edits").insert([
    {
      shift_id: shiftId,
      field_changed: field,
      old_value: actualTapTime,
      new_value: chosenTimestamp,
      edited_by: editorUserId,
      edited_by_name: editorName,
      reason,
    },
  ]);
  if (insertErr) {
    console.error("Backdate audit: insert failed:", insertErr.message);
  }
}
