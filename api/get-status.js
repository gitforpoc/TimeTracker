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

    // 1. Request the last 1000 logs (enough to determine the status of all active users)
    // Sort from newest to oldest
    const { data: logs, error } = await supabase
      .from("logs")
      .select("user_name, action, client_time, local_string")
      .order("client_time", { ascending: false })
      .limit(1000);

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
        // User is on paid leave
        userStatus[name] = {
          status: "🏖️ Paid Off",
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
