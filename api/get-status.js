import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // CORS Headers (Standard)
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Get latest log per user via RPC (1 row per user, not thousands)
    const { data: logs, error } = await supabase.rpc("tt_get_user_statuses");

    if (error) throw error;

    // 2. Calculate the status for each employee
    const userStatus = {}; // Container for final results

    logs.forEach((log) => {
      const name = log.user_name;

      // If we already found the status for this person, skip (since we are moving newest to oldest)
      if (userStatus[name]) return;

      if (log.action === "Clock In") {
        // User is currently working
        userStatus[name] = {
          status: "🟢 Working",
          since: log.local_string, // Start time (e.g., "08:00 AM")
          timestamp: log.client_time, // Used for calculating duration later
        };
      } else if (log.action === "Clock Out") {
        // User is offline
        userStatus[name] = {
          status: "⚪️ Offline",
          since: log.local_string,
        };
      } else if (log.action === "Paid Off") {
        userStatus[name] = {
          status: "🏖️ Paid Off",
          since: log.local_string,
        };
      } else if (log.action === "Day Off") {
        userStatus[name] = {
          status: "📅 Day Off",
          since: log.local_string,
        };
      }
    });

    // 3. Transform the object into a clean list/array
    const result = Object.keys(userStatus).map((name) => ({
      name: name,
      ...userStatus[name],
    }));

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
