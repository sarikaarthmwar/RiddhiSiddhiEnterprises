// api/send-email.js
// Vercel Serverless Function — CommonJS format (most reliable on Vercel)

module.exports = async function handler(req, res) {

  // ── CORS headers ──
  const origin = req.headers.origin || '*';
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, email, service, message } = req.body || {};

  // ── Validation ──
  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone are required" });
  }

  const hasEmail = typeof email === 'string' && email.trim().length > 0;
  const userEmail = hasEmail ? email.trim() : '';
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(userEmail)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (trimmedMessage && trimmedMessage.length < 10) {
    return res.status(400).json({ error: "Message is too short" });
  }

  const finalMessage = trimmedMessage || `Quick enquiry received.\nService: ${service || 'Not specified'}\nPhone: ${phone.trim()}`;

  // ── Read env variables ──
  const serviceId  = process.env.service_rqakl8n;
  const templateId = process.env.template_enewu0u;
  const publicKey  = process.env.Ooi_F5tDgCopDUeMt;

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
          from_email: userEmail || 'noreply@riddhi-siddhi-enterprises.vercel.app',
          phone:      phone ? phone.trim() : '',
          service:    service || '',
          message:    finalMessage,
          reply_to:   userEmail || 'noreply@riddhi-siddhi-enterprises.vercel.app'
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
