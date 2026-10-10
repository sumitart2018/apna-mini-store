import crypto from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const SUPER_ADMIN_EMAIL = "sumitart2018@gmail.com";
const DEFAULT_MESSAGE = "Platform maintenance chal raha hai. Kripya thodi der baad dobara aaiye.";
let firebaseCertCache = { expiresAt: 0, certs: {} };

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
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!getApps().length) {
    serviceAccount.private_key = serviceAccount.private_key?.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  return { db: getFirestore(), projectId: serviceAccount.project_id || process.env.VITE_FIREBASE_PROJECT_ID };
}

function decodeBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

async function getFirebaseCerts() {
  if (firebaseCertCache.expiresAt > Date.now() && Object.keys(firebaseCertCache.certs).length) return firebaseCertCache.certs;
  const response = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  if (!response.ok) throw new Error("Firebase signing certificates fetch nahi ho paye");
  const certs = await response.json();
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1]) || 3600;
  firebaseCertCache = { certs, expiresAt: Date.now() + Math.max(60, maxAge - 60) * 1000 };
  return certs;
}

async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken || !projectId) throw Object.assign(new Error("Firebase admin verification config missing"), { status: 500 });
  const parts = String(idToken).split(".");
  if (parts.length !== 3) throw Object.assign(new Error("Firebase token invalid hai"), { status: 401 });
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw Object.assign(new Error("Firebase token invalid hai"), { status: 401 });
  }
  if (header.alg !== "RS256" || !header.kid || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw Object.assign(new Error("Firebase token issuer invalid hai"), { status: 401 });
  }
  const certs = await getFirebaseCerts();
  const certificate = certs[header.kid];
  if (!certificate) throw Object.assign(new Error("Firebase token key rotate ho chuki hai"), { status: 401 });
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const signature = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!verifier.verify(certificate, signature)) throw Object.assign(new Error("Firebase token signature invalid hai"), { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.sub !== "string" || !payload.sub || Number(payload.exp) <= now || Number(payload.iat) > now + 60) {
    throw Object.assign(new Error("Firebase token expire ho gaya"), { status: 401 });
  }
  return payload;
}

async function verifySuperAdmin(req, admin) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) throw Object.assign(new Error("Admin login required"), { status: 401 });
  const decoded = await verifyFirebaseIdToken(token, admin.projectId);
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
