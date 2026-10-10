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
//   stores/{uid}/reviews/{reviewId}   — customer reviews, moderated by owner
//
// Every product/order document also stores a `storeId` field so that
// collectionGroup queries (used to build the platform-wide product/order
// counts on the homepage) can tell which store they belong to.

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
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
  increment,
  serverTimestamp,
  query,
  orderBy as fsOrderBy,
  limit as fsLimit,
  where as fsWhere,
  runTransaction,
  writeBatch,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { auth, db, storage, googleProvider } from "./firebase";

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

export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
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
export async function setStoreApproval(uid, approvalStatus, note = "") {
  await updateDoc(doc(db, "stores", uid), {
    approvalStatus,
    approvalNote: note,
    approvalUpdatedAt: serverTimestamp(),
  });
}
export async function setPaymentVerification(uid, paymentProofStatus, note = "") {
  await updateDoc(doc(db, "stores", uid), {
    paymentProofStatus,
    paymentVerificationNote: note,
    paymentVerifiedAt: serverTimestamp(),
  });
}
export async function writeAdminAuditLog(action, adminEmail, storeId = "", details = {}) {
  await addDoc(collection(db, "auditLogs"), {
    action,
    adminEmail,
    storeId,
    details,
    createdAt: serverTimestamp(),
  });
}
export async function createAnnouncement({ title, message, kind = "info" }, adminEmail) {
  await addDoc(collection(db, "announcements"), {
    title,
    message,
    kind,
    audience: "all-sellers",
    adminEmail,
    createdAt: serverTimestamp(),
  });
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

// Orders are private to one seller. Keep this listener scoped to that seller
// instead of querying the entire collection group and relying on rules to
// filter it — Firestore security rules are not query filters.
export function watchOrdersForStore(storeId, onChange, onError) {
  return onSnapshot(
    query(collection(db, "stores", storeId, "orders"), fsOrderBy("date", "desc")),
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (err) => { console.error("watchOrdersForStore failed:", err); if (onError) onError(err); }
  );
}

// Super Admin-only collection-group listener used by the platform analytics
// view. Firestore rules restrict this query to the configured admin account.
export function watchAllOrders(onChange, onError) {
  return onSnapshot(
    collectionGroup(db, "orders"),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("watchAllOrders failed:", err); if (onError) onError(err); }
  );
}

// Each store's public engagement summary lives at stores/{uid}/analytics/
// summary. The Super Admin sees these summaries through a collection-group
// query, while sellers continue to see only their own summary.
export function watchAllStoreAnalytics(onChange, onError) {
  return onSnapshot(
    collectionGroup(db, "analytics"),
    (snap) => {
      const byStore = {};
      snap.docs.forEach((d) => {
        if (d.id !== "summary") return;
        const storeRef = d.ref.parent.parent;
        if (!storeRef) return;
        byStore[storeRef.id] = d.data();
      });
      onChange(byStore);
    },
    (err) => { console.error("watchAllStoreAnalytics failed:", err); if (onError) onError(err); }
  );
}

export function watchAdminAuditLogs(onChange, onError) {
  return onSnapshot(
    query(collection(db, "auditLogs"), fsOrderBy("createdAt", "desc"), fsLimit(100)),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("watchAdminAuditLogs failed:", err); if (onError) onError(err); }
  );
}

export function watchAnnouncements(onChange, onError) {
  return onSnapshot(
    query(collection(db, "announcements"), fsOrderBy("createdAt", "desc"), fsLimit(20)),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("watchAnnouncements failed:", err); if (onError) onError(err); }
  );
}

// The public SaaS homepage keeps one lightweight counter. It is intentionally
// a page-session count (the UI deduplicates refreshes in the same session),
// not a promise of unique people or a full marketing analytics system.
export function watchPlatformAnalytics(onChange, onError) {
  return onSnapshot(
    doc(db, "analytics", "platform"),
    (snap) => onChange(snap.exists() ? snap.data() : {}),
    (err) => { console.error("watchPlatformAnalytics failed:", err); if (onError) onError(err); }
  );
}

export async function trackPlatformVisit() {
  await setDoc(doc(db, "analytics", "platform"), { visitorCount: increment(1) }, { merge: true });
}

export async function trackStoreVisit(storeId) {
  await updateDoc(doc(db, "stores", storeId), { visitorCount: increment(1) });
}

// Store analytics keeps public, approximate engagement counters separate from
// the seller's private orders. Public visitors can only increase these values
// by one; the dashboard reads the summary as the store owner.
export function watchStoreAnalytics(storeId, onChange, onError) {
  return onSnapshot(
    doc(db, "stores", storeId, "analytics", "summary"),
    (snap) => onChange(snap.exists() ? snap.data() : {}),
    (err) => { console.error("watchStoreAnalytics failed:", err); if (onError) onError(err); }
  );
}

export async function trackStoreAnalytics(storeId, event, product) {
  const productField = event === "productView" ? "views" : "addToCart";
  const batch = writeBatch(db);
  const summaryRef = doc(db, "stores", storeId, "analytics", "summary");
  batch.set(summaryRef, {
    productViews: event === "productView" ? increment(1) : increment(0),
    addToCart: event === "addToCart" ? increment(1) : increment(0),
  }, { merge: true });

  if (product?.id) {
    const productRef = doc(db, "stores", storeId, "analytics", "products", product.id);
    batch.set(productRef, {
      productId: product.id,
      name: product.name || "Product",
      views: productField === "views" ? increment(1) : increment(0),
      addToCart: productField === "addToCart" ? increment(1) : increment(0),
    }, { merge: true });
  }
  await batch.commit();
}

// Reviews are public only after the store owner approves them. The public
// storefront uses the approved listener; the owner dashboard uses the full
// listener to moderate pending/hidden feedback.
function mapReviews(snap) {
  return snap.docs
    .map((reviewDoc) => ({ id: reviewDoc.id, ...reviewDoc.data() }))
    .sort((a, b) => {
      const time = (value) => value?.toMillis ? value.toMillis() : (value ? new Date(value).getTime() : 0);
      return time(b.createdAt) - time(a.createdAt);
    });
}

export function watchApprovedReviews(storeId, onChange, onError) {
  return onSnapshot(
    query(collection(db, "stores", storeId, "reviews"), fsWhere("status", "==", "approved")),
    (snap) => onChange(mapReviews(snap)),
    (err) => { console.error("watchApprovedReviews failed:", err); if (onError) onError(err); }
  );
}

export function watchReviewsForStore(storeId, onChange, onError) {
  return onSnapshot(
    collection(db, "stores", storeId, "reviews"),
    (snap) => onChange(mapReviews(snap)),
    (err) => { console.error("watchReviewsForStore failed:", err); if (onError) onError(err); }
  );
}

export async function createReview(storeId, review) {
  await addDoc(collection(db, "stores", storeId, "reviews"), {
    storeId,
    customerName: review.customerName.trim(),
    rating: Number(review.rating),
    comment: review.comment.trim(),
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

export async function setReviewStatus(storeId, reviewId, status) {
  await updateDoc(doc(db, "stores", storeId, "reviews", reviewId), { status });
}

export async function deleteReview(storeId, reviewId) {
  await deleteDoc(doc(db, "stores", storeId, "reviews", reviewId));
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
// the original no-login WhatsApp checkout flow. The order and tracked stock
// decrements are committed atomically so two customers cannot both buy the
// last unit. See firestore.rules for the matching security rule.
export async function createOrder(storeId, order) {
  const orderRef = doc(collection(db, "stores", storeId, "orders"));
  await runTransaction(db, async (transaction) => {
    const quantities = {};
    (order.items || []).forEach((item) => {
      if (!item.productId) return;
      quantities[item.productId] = (quantities[item.productId] || 0) + Number(item.qty || 0);
    });
    const productEntries = Object.entries(quantities);
    const productSnapshots = [];
    for (const [productId] of productEntries) {
      const productRef = doc(db, "stores", storeId, "products", productId);
      productSnapshots.push({ productId, productRef, snapshot: await transaction.get(productRef) });
    }

    const stockAdjustments = {};
    productSnapshots.forEach(({ productId, productRef, snapshot }) => {
      const product = snapshot.data() || {};
      if (product.trackInventory !== true) return;
      const requested = quantities[productId];
      const available = Math.max(0, Number(product.stockQty) || 0);
      if (!snapshot.exists() || available < requested) {
        const error = new Error(`Product ${product.name || "item"} ka stock kam hai`);
        error.code = "inventory/insufficient-stock";
        throw error;
      }
      const remaining = available - requested;
      stockAdjustments[productId] = requested;
      transaction.update(productRef, {
        stockQty: remaining,
        inStock: remaining > 0,
        lastStockOrderId: orderRef.id,
      });
    });

    transaction.set(orderRef, { ...order, storeId, stockAdjustments });
  });
  return orderRef.id;
}
export async function setOrderStatus(uid, orderId, status) {
  await updateDoc(doc(db, "stores", uid, "orders", orderId), { status });
}
export async function setOrderPaymentStatus(uid, orderId, paymentStatus) {
  await updateDoc(doc(db, "stores", uid, "orders", orderId), { paymentStatus });
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
