import { createClient } from "@supabase/supabase-js";
import { validateAddShiftBody, findOverlap } from "./addShiftGuard.js";

// Supervisor-initiated "Add Shift" endpoint. Creates a complete past shift in
// tt_shifts (clock_in + clock_out + type) when an employee forgot both
// punches. Bypasses the tt_process_log_entry trigger intentionally — that
// trigger has a "skip if user has an open shift" guard that would block this
// flow when the admin is backfilling a past day while the employee is
// currently clocked in for today.
//
// Audit row in tt_edits uses sentinel `field_changed="created"` and a reason
// prefix of "Manually added: ..." so the client-side classifier can recognize
// it (does not consume employee per-field edit quota, does not appear as a
// diff-style row in the inline 📝 expander).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Verify SSO token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Invalid session" });
    }

    // 2. Check permissions — admin/supervisor only
    const [{ data: access }, { data: profile }] = await Promise.all([
      supabase
        .from("user_access")
        .select("role")
        .eq("user_id", user.id)
        .eq("app_id", "timetracker")
        .single(),
      supabase
        .from("profiles")
        .select("name")
        .eq("id", user.id)
        .single(),
    ]);

    const isAdmin = access && ["admin", "supervisor"].includes(access.role);
    if (!isAdmin) {
      return res.status(403).json({ error: "Admin or supervisor role required" });
    }
    const editorName = profile?.name || user.email;

    // 3. Validate body shape + time fields
    const validation = validateAddShiftBody(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const { clockInMs, clockOutMs, durationMin } = validation;
    const { user_name, clock_in, clock_out, type, comment, reason } = req.body;

    // 4. Validate user_name exists in tt_employee_settings AND is active
    const { data: emp, error: empError } = await supabase
      .from("tt_employee_settings")
      .select("user_name, active")
      .eq("user_name", user_name)
      .maybeSingle();

    if (empError) {
      console.error("Employee lookup error:", empError);
      return res.status(500).json({ error: "Failed to verify employee" });
    }
    if (!emp) {
      return res.status(400).json({ error: "Unknown employee" });
    }
    if (emp.active === false) {
      return res.status(400).json({ error: "Cannot add shift for inactive employee" });
    }

    // 5. Overlap check — query a generous date window around the new shift
    // so we can re-use the pure findOverlap helper. ±1 day covers overnights.
    const windowStartISO = new Date(clockInMs - 24 * 60 * 60 * 1000).toISOString();
    const windowEndISO = new Date(clockOutMs + 24 * 60 * 60 * 1000).toISOString();

    const { data: nearbyShifts, error: nearbyError } = await supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, type")
      .eq("user_name", user_name)
      .gte("clock_in", windowStartISO)
      .lte("clock_in", windowEndISO);

    if (nearbyError) {
      console.error("Overlap query error:", nearbyError);
      return res.status(500).json({ error: "Failed to check for overlaps" });
    }

    // Also check the user's current open shift if it started before our window
    // (a long-running open shift from days ago wouldn't be caught by the date
    // window otherwise).
    const { data: openShifts } = await supabase
      .from("tt_shifts")
      .select("id, clock_in, clock_out, type")
      .eq("user_name", user_name)
      .is("clock_out", null);

    const candidatePool = [...(nearbyShifts || []), ...(openShifts || [])];
    // De-dup by id (open shift can also be in nearbyShifts).
    const seen = new Set();
    const dedupedPool = candidatePool.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    const overlap = findOverlap(dedupedPool, clockInMs, clockOutMs);
    if (overlap.overlaps) {
      const c = overlap.conflict;
      const desc = c.clock_out
        ? `${new Date(c.clock_in).toISOString()} → ${new Date(c.clock_out).toISOString()}`
        : `${new Date(c.clock_in).toISOString()} (open shift)`;
      return res.status(409).json({
        error: `Shift overlaps existing shift for ${user_name}: ${desc}`,
      });
    }

    // 6. INSERT into tt_shifts directly (bypass trigger — see file header)
    const insertPayload = {
      user_name,
      clock_in: new Date(clockInMs).toISOString(),
      clock_out: new Date(clockOutMs).toISOString(),
      duration_minutes: durationMin,
      type,
      comment: comment && typeof comment === "string" && comment.trim() ? comment.trim() : null,
    };

    const { data: insertedShift, error: insertError } = await supabase
      .from("tt_shifts")
      .insert(insertPayload)
      .select("id")
      .single();

    if (insertError || !insertedShift) {
      console.error("Insert error:", insertError);
      return res.status(500).json({ error: "Failed to create shift" });
    }

    // 7. INSERT audit row. Sentinel field_changed="created"; reason starts with
    // "Manually added: " so the client classifier recognizes it.
    const auditSnapshot = JSON.stringify({
      clock_in: insertPayload.clock_in,
      clock_out: insertPayload.clock_out,
      type: insertPayload.type,
      comment: insertPayload.comment,
    });

    const { error: auditError } = await supabase.from("tt_edits").insert({
      shift_id: insertedShift.id,
      field_changed: "created",
      old_value: null,
      new_value: auditSnapshot,
      edited_by: user.id,
      edited_by_name: editorName,
      reason: `Manually added: ${reason.trim()}`,
    });

    if (auditError) {
      // Audit failure is logged but not fatal — the shift has been created.
      // Surfacing 500 here would leave the admin uncertain about state.
      console.error("Audit error:", auditError);
    }

    return res.status(200).json({ success: true, shift_id: insertedShift.id });
  } catch (err) {
    console.error("add-shift error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
