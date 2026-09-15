// firestoreApi.js — every read/write to Firebase lives here. App.jsx calls
// these functions instead of talking to Firestore/Auth directly, so the UI
// layer never needs to know how the data is actually stored.
//
// DATA MODEL
//   stores/{uid}                      — one doc per seller, doc id = their Firebase Auth uid
//   stores/{uid}/products/{productId} — subcollection (NOT an array field — this is what
//                                        keeps a seller with 100 product photos from ever
//                                        blowing up a single document again)
//   stores/{uid}/orders/{orderId}     — subcollection
//
// Every product/order document also stores a `storeId` field so that
// collectionGroup queries (used to build the platform-wide product/order
// counts on the homepage) can tell which store they belong to.

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection,
  collectionGroup,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
  query,
  orderBy as fsOrderBy,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { auth, db, storage } from "./firebase";

// ---------- Auth ----------

// Friendly Hindi messages for the Firebase Auth error codes we're actually
// likely to hit, so the person never sees a raw "Firebase: Error
// (auth/xyz)." string.
function friendlyAuthError(err) {
  const code = err && err.code;
  const map = {
    "auth/email-already-in-use": "Ye email pehle se registered hai — Login try karo",
    "auth/invalid-email": "Email sahi format mein daalo",
    "auth/weak-password": "Password kam se kam 6 characters ka hona chahiye",
    "auth/user-not-found": "Email ya password galat hai",
    "auth/wrong-password": "Email ya password galat hai",
    "auth/invalid-credential": "Email ya password galat hai",
    "auth/too-many-requests": "Bahut baar galat try hua — thodi der baad try karo",
    "auth/network-request-failed": "Internet connection check karo",
  };
  return map[code] || "Kuch galat ho gaya, dobara try karo";
}

// Creates a real Firebase Auth account for a new seller, then creates their
// store profile document (same uid as the doc id, so we never need to
// separately look up "which store does this login belong to").
export async function signUpSeller(email, password, profileFields) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const uid = cred.user.uid;
  await setDoc(doc(db, "stores", uid), {
    ...profileFields,
    ownerId: uid,
    email: email.trim().toLowerCase(),
    createdAt: serverTimestamp(),
  });
  return uid;
}

export async function signInSeller(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user.uid;
}

export async function signOutUser() {
  await firebaseSignOut(auth);
}

// The real, secure replacement for "show me the password" — Firebase Auth
// never lets anyone (including us) read a password back in plain text, by
// design. Instead, this sends the seller a real email with a link to set a
// new password themselves. This is what the Super Admin's "help, I forgot
// my password" button should trigger.
export async function resetSellerPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

// Fires immediately with the current user (or null) and again on every
// login/logout — this is how App.jsx knows whether someone is signed in
// without us having to manage that state by hand. Firebase also persists
// the session in the browser automatically, so sellers stay logged in
// across page reloads (a real upgrade over the old setup).
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export { friendlyAuthError };

// ---------- Store profile ----------

export async function updateStoreProfile(uid, patch) {
  await updateDoc(doc(db, "stores", uid), patch);
}

export async function addStoreCategory(uid, category) {
  await updateDoc(doc(db, "stores", uid), { categories: arrayUnion(category) });
}

export async function removeStoreCategory(uid, category) {
  await updateDoc(doc(db, "stores", uid), { categories: arrayRemove(category) });
}

// Super Admin actions
export async function setStorePlan(uid, planType, expiresAt) {
  await updateDoc(doc(db, "stores", uid), { plan: planType, planExpiresAt: expiresAt, blocked: false });
}
export async function setStoreBlocked(uid, blocked) {
  await updateDoc(doc(db, "stores", uid), { blocked });
}
export async function setTrialStartedAt(uid, trialStartedAt) {
  await updateDoc(doc(db, "stores", uid), { trialStartedAt });
}

// ---------- Real-time listeners ----------
// Each returns an unsubscribe function — call it in a useEffect cleanup.
// Each also takes an optional onError callback — without it, a permission
// error or misconfigured project would fail SILENTLY (the success callback
// just never fires), leaving the app stuck on a loading screen forever with
// no visible clue why. With it, App.jsx can show the real error on screen.

export function watchAllStores(onChange, onError) {
  return onSnapshot(
    collection(db, "stores"),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("watchAllStores failed:", err); if (onError) onError(err); }
  );
}

// One listener for every product across every store, tagged with storeId —
// far cheaper than one listener per store, and gives every store's owner
// dashboard / public storefront / homepage counters live data for free.
export function watchAllProducts(onChange, onError) {
  return onSnapshot(
    collectionGroup(db, "products"),
    (snap) => {
      const byStore = {};
      snap.docs.forEach((d) => {
        const data = { id: d.id, ...d.data() };
        const sid = data.storeId;
        if (!byStore[sid]) byStore[sid] = [];
        byStore[sid].push(data);
      });
      onChange(byStore);
    },
    (err) => { console.error("watchAllProducts failed:", err); if (onError) onError(err); }
  );
}

export function watchAllOrders(onChange, onError) {
  return onSnapshot(
    collectionGroup(db, "orders"),
    (snap) => {
      const byStore = {};
      snap.docs.forEach((d) => {
        const data = { id: d.id, ...d.data() };
        const sid = data.storeId;
        if (!byStore[sid]) byStore[sid] = [];
        byStore[sid].push(data);
      });
      // newest first, matching the old array-prepend behaviour
      Object.values(byStore).forEach((list) => list.sort((a, b) => new Date(b.date) - new Date(a.date)));
      onChange(byStore);
    },
    (err) => { console.error("watchAllOrders failed:", err); if (onError) onError(err); }
  );
}

// ---------- Products ----------

export async function createProduct(uid, product) {
  const docRef = await addDoc(collection(db, "stores", uid, "products"), {
    ...product,
    storeId: uid,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}
export async function editProduct(uid, productId, patch) {
  await updateDoc(doc(db, "stores", uid, "products", productId), patch);
}
export async function removeProduct(uid, productId, imgUrl) {
  await deleteDoc(doc(db, "stores", uid, "products", productId));
  if (imgUrl) {
    // Best-effort — a stale image left in Storage isn't worth failing the delete over.
    try { await deleteObject(ref(storage, imgUrl)); } catch { /* ignore */ }
  }
}

// ---------- Orders ----------

// No auth required — customers checking out are anonymous visitors, matching
// the original no-login WhatsApp checkout flow. See firestore.rules for the
// matching security rule (create-only, no read/update/delete for the public).
export async function createOrder(storeId, order) {
  await addDoc(collection(db, "stores", storeId, "orders"), { ...order, storeId });
}
export async function setOrderStatus(uid, orderId, status) {
  await updateDoc(doc(db, "stores", uid, "orders", orderId), { status });
}

// ---------- Image upload ----------

// Uploads an already-compressed image blob to Firebase Storage under a
// per-store folder and returns its public download URL.
export async function uploadStoreImage(uid, blob, kind) {
  const path = `${uid}/${kind}-${Date.now()}.jpg`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, { contentType: "image/jpeg" });
  return getDownloadURL(storageRef);
}
