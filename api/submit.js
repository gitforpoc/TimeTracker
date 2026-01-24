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

  // Get the URL
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

  // If no URL is found - return a clear error
  if (!GOOGLE_SCRIPT_URL) {
    return res.status(500).json({
      error: "Configuration Error",
      message: "Variable GOOGLE_SCRIPT_URL not found in Vercel Settings.",
    });
  }

  try {
    // Try to send data
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    // If Google responds with an error (4xx or 5xx)
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    // In case of any failure - return the error text, not just 500
    console.error("Vercel Logic Error:", error);
    return res.status(200).json({
      result: "error",
      message: error.message || error.toString(),
    });
  }
}
