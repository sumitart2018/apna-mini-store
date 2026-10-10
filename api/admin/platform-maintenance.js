import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const SUPER_ADMIN_EMAIL = "sumitart2018@gmail.com";
const DEFAULT_MESSAGE = "Platform maintenance chal raha hai. Kripya thodi der baad dobara aaiye.";

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");
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

async function verifySuperAdmin(req, admin) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) throw Object.assign(new Error("Admin login required"), { status: 401 });
  const decoded = await admin.auth.verifyIdToken(token);
  if (String(decoded.email || "").toLowerCase() !== SUPER_ADMIN_EMAIL) {
    throw Object.assign(new Error("Super Admin access required"), { status: 403 });
  }
}

export default async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return sendJson(res, 405, { error: "GET ya PUT method required hai" });
  try {
    const admin = getAdmin();
    const ref = admin.db.doc("platformSettings/maintenance");
    if (req.method === "GET") {
      const snapshot = await ref.get();
      const data = snapshot.exists ? snapshot.data() : {};
      return sendJson(res, 200, {
        enabled: Boolean(data.enabled),
        message: String(data.message || DEFAULT_MESSAGE),
      });
    }

    await verifySuperAdmin(req, admin);
    const body = getBody(req);
    const message = String(body.message || "").trim().slice(0, 240) || DEFAULT_MESSAGE;
    await ref.set({ enabled: Boolean(body.enabled), message, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return sendJson(res, 200, { enabled: Boolean(body.enabled), message });
  } catch (error) {
    console.error("Platform maintenance API failed", error);
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Platform maintenance setting unavailable hai" });
  }
}
