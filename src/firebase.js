// firebase.js — initializes the Firebase app, Auth, Firestore, and Storage.
//
// Fill in your own project's config below (or via a .env file — see
// .env.example and the README for the Vite env-var version). You get these
// values from the Firebase Console: Project Settings → General → "Your apps"
// → SDK setup and configuration.

import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Fails loudly and early if someone forgets to set up their .env file —
// much easier to debug than a cryptic Firebase error three files deep.
const missing = Object.entries(firebaseConfig).filter(([, v]) => !v);
if (missing.length) {
  throw new Error(
    `Firebase config is missing: ${missing.map(([k]) => k).join(", ")}. ` +
      "Copy .env.example to .env and fill in your Firebase project's values (see README.md). " +
      "On Vercel, add these under Project Settings → Environment Variables and redeploy."
  );
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);
