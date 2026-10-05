function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

const RAZORPAY_PAYMENTS_ENABLED = false;

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST method required" });
  if (!RAZORPAY_PAYMENTS_ENABLED) return sendJson(res, 503, { error: "Razorpay payment abhi temporarily disabled hai" });

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return sendJson(res, 503, { error: "Razorpay keys Vercel environment mein set nahi hain" });
  }

  const { amount, receipt, notes = {} } = getBody(req);
  if (!Number.isInteger(amount) || amount < 100 || amount > 10000000) {
    return sendJson(res, 400, { error: "Payment amount ₹1 se ₹1,00,000 ke beech hona chahiye" });
  }

  try {
    const razorpayResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "INR",
        receipt: String(receipt || `order-${Date.now()}`).slice(0, 40),
        notes: typeof notes === "object" && notes ? notes : {},
      }),
    });
    const data = await razorpayResponse.json().catch(() => ({}));
    if (!razorpayResponse.ok || !data.id) {
      console.error("Razorpay create order failed", razorpayResponse.status, data);
      return sendJson(res, 502, { error: "Razorpay order create nahi hua" });
    }
    // Secret key is deliberately never returned to the browser.
    return sendJson(res, 200, { id: data.id, amount: data.amount, currency: data.currency, keyId });
  } catch (error) {
    console.error("Razorpay create order error", error);
    return sendJson(res, 502, { error: "Razorpay service se connection nahi ho paya" });
  }
}
