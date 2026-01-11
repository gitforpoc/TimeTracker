export default async function handler(req, res) {
  // Разрешаем CORS, чтобы работать с любого домена (на всякий случай)
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

  // Обработка предварительного запроса браузера (OPTIONS)
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Получаем ссылку
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

  // Если ссылки нет — пишем понятную ошибку
  if (!GOOGLE_SCRIPT_URL) {
    return res.status(500).json({
      error: "Configuration Error",
      message: "Variable GOOGLE_SCRIPT_URL not found in Vercel Settings.",
    });
  }

  try {
    // Пытаемся отправить
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    // Если Гугл ответил ошибкой (4xx или 5xx)
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    // В случае любого сбоя — возвращаем текст ошибки, а не просто 500
    console.error("Vercel Logic Error:", error);
    return res.status(200).json({
      result: "error",
      message: error.message || error.toString(),
    });
  }
}
