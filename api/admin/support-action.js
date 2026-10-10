import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const SUPER_ADMIN_EMAIL = "sumitart2018@gmail.com";
const PRODUCT_FIELDS = ["name", "price", "mrp", "category", "trackInventory", "stockQty", "lowStockThreshold", "inStock", "sizes", "colors", "weights", "img", "description", "tags"];
const PROFILE_FIELDS = ["name", "tagline", "whatsapp", "color", "theme", "minOrderValue", "freeShippingThreshold", "shippingFee", "gstPercent", "paymentMethod", "upiId", "categories", "ownerName", "altPhone", "address", "gstin", "about", "facebook", "instagram", "youtube", "bannerImg", "logoImg", "seoTitle", "seoDescription"];
const ORDER_STATUS = ["New", "Confirmed", "Shipped", "Delivered", "Cancelled"];
const PAYMENT_STATUS = ["unpaid", "pending", "paid", "failed", "refunded"];

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

function getAdmin() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    serviceAccount.private_key = serviceAccount.private_key?.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function getSupportToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Support ") ? value.slice(8).trim() : "";
}

async function getSession(req, db) {
  const token = getSupportToken(req);
  if (!token || token.length < 30) throw Object.assign(new Error("Support session missing hai"), { status: 401 });
  const tokenHash = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
  const ref = db.doc(`supportSessions/${tokenHash}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw Object.assign(new Error("Support session invalid hai"), { status: 401 });
  const session = snapshot.data();
  const expiresAt = session.expiresAt?.toMillis ? session.expiresAt.toMillis() : new Date(session.expiresAt || 0).getTime();
  if (session.revoked || !expiresAt || expiresAt <= Date.now()) throw Object.assign(new Error("Support session expire ho gaya"), { status: 401 });
  if (session.adminEmail !== SUPER_ADMIN_EMAIL || !session.storeId) throw Object.assign(new Error("Support session access denied"), { status: 403 });
  return { ref, tokenHash, ...session };
}

function cleanObject(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key)));
}

function validateProduct(product) {
  const clean = cleanObject(product, PRODUCT_FIELDS);
  if (typeof clean.name !== "string" || !clean.name.trim() || clean.name.length > 120) throw Object.assign(new Error("Product name invalid hai"), { status: 400 });
  if (!Number.isFinite(Number(clean.price)) || Number(clean.price) <= 0 || Number(clean.price) > 100000000) throw Object.assign(new Error("Product price invalid hai"), { status: 400 });
  clean.name = clean.name.trim();
  clean.price = Number(clean.price);
  if (clean.mrp !== undefined) clean.mrp = Number(clean.mrp) || 0;
  if (clean.trackInventory === true) {
    clean.stockQty = Math.max(0, Math.floor(Number(clean.stockQty) || 0));
    clean.lowStockThreshold = Math.max(0, Math.floor(Number(clean.lowStockThreshold) || 0));
    clean.inStock = clean.stockQty > 0;
  }
  return clean;
}

async function audit(db, session, action, details = {}) {
  await db.collection("auditLogs").add({ action: `support_${action}`, adminEmail: SUPER_ADMIN_EMAIL, storeId: session.storeId, details, createdAt: FieldValue.serverTimestamp() });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST method required hai" });
  try {
    const db = getAdmin();
    const session = await getSession(req, db);
    const body = getBody(req);
    const action = String(body.action || "");
    const storeRef = db.doc(`stores/${session.storeId}`);
    let result = {};

    if (action === "create_product") {
      const product = validateProduct(body.product);
      const ref = await storeRef.collection("products").add({ ...product, storeId: session.storeId, createdAt: FieldValue.serverTimestamp() });
      await audit(db, session, action, { productId: ref.id, name: product.name });
      result = { productId: ref.id };
    } else if (action === "update_product") {
      const productId = String(body.productId || "");
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(productId)) return sendJson(res, 400, { error: "Product reference invalid hai" });
      const patch = validateProduct(body.product);
      await storeRef.collection("products").doc(productId).update(patch);
      await audit(db, session, action, { productId, name: patch.name });
    } else if (action === "delete_product") {
      const productId = String(body.productId || "");
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(productId)) return sendJson(res, 400, { error: "Product reference invalid hai" });
      await storeRef.collection("products").doc(productId).delete();
      await audit(db, session, action, { productId });
    } else if (action === "update_profile") {
      const patch = cleanObject(body.patch, PROFILE_FIELDS);
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "Update ke liye valid fields nahi mile" });
      await storeRef.update(patch);
      await audit(db, session, action, { fields: Object.keys(patch) });
    } else if (action === "update_order") {
      const orderId = String(body.orderId || "");
      const patch = {};
      if (body.status !== undefined && ORDER_STATUS.includes(body.status)) patch.status = body.status;
      if (body.paymentStatus !== undefined && PAYMENT_STATUS.includes(body.paymentStatus)) patch.paymentStatus = body.paymentStatus;
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !Object.keys(patch).length) return sendJson(res, 400, { error: "Order update invalid hai" });
      await storeRef.collection("orders").doc(orderId).update(patch);
      await audit(db, session, action, { orderId, fields: Object.keys(patch) });
    } else if (action === "update_review") {
      const reviewId = String(body.reviewId || "");
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(reviewId) || !["pending", "approved", "hidden"].includes(body.status)) return sendJson(res, 400, { error: "Review update invalid hai" });
      await storeRef.collection("reviews").doc(reviewId).update({ status: body.status });
      await audit(db, session, action, { reviewId, status: body.status });
    } else if (action === "delete_review") {
      const reviewId = String(body.reviewId || "");
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(reviewId)) return sendJson(res, 400, { error: "Review reference invalid hai" });
      await storeRef.collection("reviews").doc(reviewId).delete();
      await audit(db, session, action, { reviewId });
    } else {
      return sendJson(res, 400, { error: "Support action allowed nahi hai" });
    }
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error("Support action failed", error);
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Support action complete nahi hua" });
  }
}
