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
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // Handle browser preflight request (OPTIONS)
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
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
    const { name, action, timestamp, localTime } = req.body;

    const { data, error } = await supabase.from("logs").insert([
      {
        user_name: name,
        action: action,
        client_time: timestamp,
        local_string: localTime,
        payload: req.body,
      },
    ]);

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
