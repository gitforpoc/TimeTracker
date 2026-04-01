import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // 1. CORS headers (So Google Sheets can connect)
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-Api-Key"
  );

  // Handle browser preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --- Auth: Bearer token OR API key ---
  const apiKey = req.headers["x-api-key"] || req.query.key;
  const authHeader = req.headers.authorization;
  const REPORT_API_KEY = process.env.REPORT_API_KEY;

  let authorized = false;
  if (apiKey && REPORT_API_KEY && apiKey === REPORT_API_KEY) {
    authorized = true;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user } } = await authClient.auth.getUser(token);
    if (user) authorized = true;
  }

  if (!authorized) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    // 2. Supabase Initialization
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error("Missing Supabase configuration in Vercel.");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // 3. Get parameters from the query string (?start=...&end=...)
    const { start, end, name } = req.query;

    if (!start || !end) {
      return res
        .status(400)
        .json({ error: "Missing start or end date parameters." });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(start) || !dateRegex.test(end)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    // 4. Enforce max date range (90 days) to prevent accidental huge queries
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: "Invalid date values." });
    }
    const diffDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 90) {
      return res
        .status(400)
        .json({ error: "Date range cannot exceed 90 days." });
    }

    // 5. Building the database query — only select needed columns
    let query = supabase
      .from("tt_shifts")
      .select("user_name, clock_in, clock_out, duration_minutes, type, comment")
      .gte("clock_in", `${start}T00:00:00`)
      .lte("clock_in", `${end}T23:59:59`)
      .order("clock_in", { ascending: true })
      .limit(5000);

    if (name) {
      const cleanName = name.trim();
      query = query.ilike("user_name", `%${cleanName}%`);
    }

    // 6. Execute the query
    const { data, error } = await query;

    if (error) {
      throw error;
    }

    // 6. Return the result
    return res.status(200).json(data);
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
}
