// api/send-email.js
// Vercel Serverless Function — CommonJS format (most reliable on Vercel)

module.exports = async function handler(req, res) {

  // ── CORS headers ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, email, service, message } = req.body || {};

  // ── Validation ──
  if (!name || !email || !message) {
    return res.status(400).json({ error: "Name, email, and message are required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (message.trim().length < 10) {
    return res.status(400).json({ error: "Message is too short" });
  }

  // ── Read env variables ──
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;

  // Log missing vars to Vercel Function logs for easy debugging
  if (!serviceId || !templateId || !publicKey) {
    console.error("Missing env vars:", { serviceId: !!serviceId, templateId: !!templateId, publicKey: !!publicKey });
    return res.status(500).json({ error: "Server configuration error." });
  }

  // ── Call EmailJS REST API ──
  try {
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:  serviceId,
        template_id: templateId,
        user_id:     publicKey,
        template_params: {
          from_name:  name.trim(),
          from_email: email.trim(),
          phone:      phone ? phone.trim() : '',
          service:    service || '',
          message:    message.trim(),
          reply_to:   email.trim()
        }
      })
    });

    const responseText = await response.text();
    console.log("EmailJS status:", response.status, "| body:", responseText);

    if (response.ok) {
      return res.status(200).json({ success: true });
    } else {
      return res.status(500).json({ error: "EmailJS error: " + responseText });
    }

  } catch (err) {
    console.error("Fetch error:", err.message);
    return res.status(500).json({ error: "Internal server error: " + err.message });
  }
};