export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  // Получаем секретную ссылку из настроек Vercel (см. Шаг 3)
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

  if (!GOOGLE_SCRIPT_URL) {
    return res.status(500).json({ message: "Server Configuration Error" });
  }

  try {
    // Пересылаем данные из телефона в Google
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error sending to Google:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
