import crypto from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const SUPER_ADMIN_EMAIL = "sumitart2018@gmail.com";
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

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
  return { db: getFirestore(), auth: getAuth() };
}

function getBearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function getSupportToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Support ") ? value.slice(8).trim() : "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function base32Decode(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!normalized) return Buffer.alloc(0);
  let bits = "";
  for (const char of normalized) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpForCounter(secret, counter) {
  const key = base32Decode(secret);
  if (!key.length) return "";
  const message = Buffer.alloc(8);
  message.writeBigInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTotp(code, secret) {
  if (!/^\d{6}$/.test(String(code || "")) || !secret) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  return [-1, 0, 1].some((offset) => safeEqual(code, totpForCounter(secret, counter + offset)));
}

async function verifySuperAdmin(req, admin) {
  const idToken = getBearerToken(req);
  if (!idToken) throw Object.assign(new Error("Admin login required"), { status: 401 });
  const decoded = await admin.auth.verifyIdToken(idToken);
  if (String(decoded.email || "").toLowerCase() !== SUPER_ADMIN_EMAIL) {
    throw Object.assign(new Error("Super Admin access required"), { status: 403 });
  }
  return decoded;
}

async function checkAttemptLimit(db, uid) {
  const ref = db.doc(`supportRateLimits/${uid}`);
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : {};
    const startedAt = Number(current.windowStartedAt) || now;
    const count = now - startedAt > ATTEMPT_WINDOW_MS ? 0 : Number(current.count) || 0;
    if (count >= MAX_ATTEMPTS) return false;
    transaction.set(ref, { windowStartedAt: count === 0 ? now : startedAt, count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

async function revokeSession(req, res, db) {
  const token = getSupportToken(req);
  if (!token) return sendJson(res, 401, { error: "Support session missing hai" });
  const ref = db.doc(`supportSessions/${hashToken(token)}`);
  await ref.set({ revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  return sendJson(res, 200, { revoked: true });
}

export default async function handler(req, res) {
  if (!["POST", "DELETE"].includes(req.method)) return sendJson(res, 405, { error: "POST ya DELETE method required hai" });
  try {
    const admin = getAdmin();
    if (req.method === "DELETE") return revokeSession(req, res, admin.db);

    const decoded = await verifySuperAdmin(req, admin);
    const body = getBody(req);
    const storeId = String(body.storeId || "").trim();
    const code = String(body.totpCode || "").trim();
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(storeId)) return sendJson(res, 400, { error: "Store reference invalid hai" });
    if (!process.env.ADMIN_SUPPORT_TOTP_SECRET) return sendJson(res, 503, { error: "Admin Authenticator secret Vercel mein configure nahi hai" });

    const allowed = await checkAttemptLimit(admin.db, decoded.uid);
    if (!allowed) return sendJson(res, 429, { error: "Bahut attempts ho gaye. 10 minute baad try karo." });
    if (!verifyTotp(code, process.env.ADMIN_SUPPORT_TOTP_SECRET)) return sendJson(res, 401, { error: "Authenticator code galat ya expire ho gaya" });

    const storeSnapshot = await admin.db.doc(`stores/${storeId}`).get();
    if (!storeSnapshot.exists) return sendJson(res, 404, { error: "Store nahi mila" });

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await admin.db.doc(`supportSessions/${tokenHash}`).set({
      adminUid: decoded.uid,
      adminEmail: SUPER_ADMIN_EMAIL,
      storeId,
      scopes: ["profile", "products", "orders", "reviews"],
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(expiresAt),
      revoked: false,
    });
    await admin.db.collection("auditLogs").add({
      action: "support_session_opened",
      adminEmail: SUPER_ADMIN_EMAIL,
      storeId,
      details: { expiresInMinutes: SESSION_TTL_MS / 60000, scopes: ["profile", "products", "orders", "reviews"] },
      createdAt: FieldValue.serverTimestamp(),
    });
    return sendJson(res, 200, { token: rawToken, storeId, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    console.error("Support session error", error);
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Secure support session create nahi ho paya" });
  }
}
