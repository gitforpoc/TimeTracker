import { createClient } from "@supabase/supabase-js";

const EDITABLE_FIELDS = ["clock_in", "clock_out", "type", "comment"];

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

    // 2. Check permissions
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
    const editorName = profile?.name || user.email;

    // 3. Parse and validate request
    const { shiftId, changes, reason } = req.body;
    if (!shiftId || !changes || typeof changes !== "object") {
      return res.status(400).json({ error: "shiftId and changes required" });
    }

    // 4. Get current shift — BEFORE permission check
    const { data: shift, error: shiftError } = await supabase
      .from("tt_shifts")
      .select("*")
      .eq("id", shiftId)
      .single();

    if (shiftError || !shift) {
      return res.status(404).json({ error: "Shift not found" });
    }

    // 5. Permission: admin edits any, user edits own only
    if (!isAdmin && shift.user_name !== editorName) {
      return res.status(403).json({ error: "You can only edit your own shifts" });
    }

    // 5b. Employee one-edit limit (admins bypass)
    if (!isAdmin) {
      const { data: priorEdits } = await supabase
        .from("tt_edits")
        .select("id")
        .eq("shift_id", shiftId)
        .eq("edited_by", user.id)
        .limit(1);

      if (priorEdits && priorEdits.length > 0) {
        return res.status(409).json({
          error: "You have already edited this shift. Contact your supervisor for further changes.",
        });
      }
    }

    // 6. Build update and audit records
    const update = {};
    const edits = [];

    for (const field of EDITABLE_FIELDS) {
      if (changes[field] !== undefined && String(changes[field] ?? "") !== String(shift[field] ?? "")) {
        edits.push({
          shift_id: shiftId,
          field_changed: field,
          old_value: shift[field] != null ? String(shift[field]) : null,
          new_value: changes[field] != null ? String(changes[field]) : null,
          edited_by: user.id,
          edited_by_name: editorName,
          reason: reason || null,
        });
        update[field] = changes[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(200).json({ message: "No changes detected" });
    }

    // 7. Recalculate duration if clock times changed
    const finalClockIn = update.clock_in ?? shift.clock_in;
    const finalClockOut = update.clock_out ?? shift.clock_out;
    if ((update.clock_in || update.clock_out) && finalClockIn && finalClockOut) {
      const duration = Math.round(
        (new Date(finalClockOut) - new Date(finalClockIn)) / 60000
      );
      if (duration < 0) {
        return res.status(400).json({ error: "Clock Out must be after Clock In" });
      }
      update.duration_minutes = duration;
    }

    // 8. Apply update
    const { error: updateError } = await supabase
      .from("tt_shifts")
      .update(update)
      .eq("id", shiftId);

    if (updateError) {
      console.error("Update error:", updateError);
      return res.status(500).json({ error: "Failed to update shift" });
    }

    // 9. Insert audit records
    const { error: auditError } = await supabase
      .from("tt_edits")
      .insert(edits);

    if (auditError) {
      console.error("Audit error:", auditError);
    }

    return res.status(200).json({
      message: `Updated ${edits.length} field(s)`,
      edits: edits.length,
    });
  } catch (err) {
    console.error("edit-shift error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
