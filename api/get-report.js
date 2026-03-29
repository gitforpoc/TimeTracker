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
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // Handle browser preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
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

    // 4. Enforce max date range (90 days) to prevent accidental huge queries
    const startDate = new Date(start);
    const endDate = new Date(end);
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
