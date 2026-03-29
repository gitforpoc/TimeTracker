import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EDITABLE_FIELDS = ["clock_in", "clock_out", "type", "comment"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
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

    // 2. Check timetracker admin/supervisor role
    const { data: access } = await supabase
      .from("user_access")
      .select("role")
      .eq("user_id", user.id)
      .eq("app_id", "timetracker")
      .single();

    if (!access || !["admin", "supervisor"].includes(access.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // 3. Parse request
    const { shiftId, changes, reason } = req.body;
    if (!shiftId || !changes || typeof changes !== "object") {
      return res.status(400).json({ error: "shiftId and changes required" });
    }

    // 4. Get current shift
    const { data: shift, error: shiftError } = await supabase
      .from("tt_shifts")
      .select("*")
      .eq("id", shiftId)
      .single();

    if (shiftError || !shift) {
      return res.status(404).json({ error: "Shift not found" });
    }

    // 5. Get editor name from profiles
    const { data: profile } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .single();

    const editorName = profile?.name || user.email;

    // 6. Build update and audit records
    const update = {};
    const edits = [];

    for (const field of EDITABLE_FIELDS) {
      if (changes[field] !== undefined && changes[field] !== shift[field]) {
        const oldVal = shift[field] != null ? String(shift[field]) : null;
        const newVal = changes[field] != null ? String(changes[field]) : null;

        edits.push({
          shift_id: shiftId,
          field_changed: field,
          old_value: oldVal,
          new_value: newVal,
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

    // Recalculate duration if clock times changed
    const newClockIn = update.clock_in || shift.clock_in;
    const newClockOut = update.clock_out || shift.clock_out;
    if ((update.clock_in || update.clock_out) && newClockIn && newClockOut) {
      update.duration_minutes = Math.round(
        (new Date(newClockOut) - new Date(newClockIn)) / 60000
      );
    }

    // 7. Apply update
    const { error: updateError } = await supabase
      .from("tt_shifts")
      .update(update)
      .eq("id", shiftId);

    if (updateError) {
      console.error("Update error:", updateError);
      return res.status(500).json({ error: "Failed to update shift" });
    }

    // 8. Insert audit records
    const { error: auditError } = await supabase
      .from("tt_edits")
      .insert(edits);

    if (auditError) {
      console.error("Audit error:", auditError);
      // Don't fail — shift is already updated, audit is secondary
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
