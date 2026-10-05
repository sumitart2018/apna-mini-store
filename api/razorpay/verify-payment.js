import crypto from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

const RAZORPAY_PAYMENTS_ENABLED = false;

function getAdminDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    serviceAccount.private_key = serviceAccount.private_key?.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST method required" });
  if (!RAZORPAY_PAYMENTS_ENABLED) return sendJson(res, 503, { error: "Razorpay payment abhi temporarily disabled hai" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, storeId, orderId } = getBody(req);
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !storeId || !orderId) {
    return sendJson(res, 400, { error: "Payment verification data incomplete hai" });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return sendJson(res, 503, { error: "Razorpay secret Vercel environment mein set nahi hai" });
  const expected = crypto.createHmac("sha256", secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(String(razorpay_signature), "utf8");
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return sendJson(res, 400, { error: "Payment signature invalid hai" });
  }

  if (!/^[A-Za-z0-9_-]+$/.test(storeId) || !/^[A-Za-z0-9_-]+$/.test(orderId)) {
    return sendJson(res, 400, { error: "Order reference invalid hai" });
  }

  try {
    const db = getAdminDb();
    const orderRef = db.doc(`stores/${storeId}/orders/${orderId}`);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists) throw new Error("Order nahi mila");
      const order = snapshot.data();
      if (order.razorpayOrderId !== razorpay_order_id) throw new Error("Order reference match nahi hua");
      if (order.paymentStatus !== "paid") {
        transaction.update(orderRef, {
          paymentStatus: "paid",
          razorpayPaymentId: String(razorpay_payment_id),
          paidAt: new Date().toISOString(),
        });
      }
    });
    return sendJson(res, 200, { verified: true });
  } catch (error) {
    console.error("Razorpay verification persistence failed", error);
    return sendJson(res, 503, { error: "Payment verify hua, lekin order status save nahi ho paya" });
  }
}
