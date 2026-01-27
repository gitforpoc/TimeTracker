const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // Set CORS headers to allow access from Google Sheets or other origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { start, end, name } = req.query;

    // Validate required parameters
    if (!start || !end) {
      return res
        .status(400)
        .json({ error: "Missing start or end date parameters" });
    }

    // Build the query to fetch shifts
    let query = supabase
      .from("shifts")
      .select("*")
      .gte("clock_in", start)
      .lte("clock_in", end)
      .order("clock_in", { ascending: true });

    // Apply optional name filter if provided
    if (name) {
      query = query.eq("user_name", name);
    }

    // Execute the query
    const { data, error } = await query;

    if (error) throw error;

    // Return the filtered data
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching report:", error);
    return res.status(500).json({ error: error.message });
  }
};
