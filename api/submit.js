import { createClient } from "@supabase/supabase-js";

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

  // --- Auth: require Bearer token ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = authHeader.replace("Bearer ", "");
  const authSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const { data: { user }, error: authError } = await authSupabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
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
    const { name, action, timestamp, localTime, type, targetId, comment, id, timezone, lat, lng } =
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
