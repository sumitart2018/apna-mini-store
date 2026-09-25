# Apna Mini Store — Mini Store SaaS Platform

A multi-tenant WhatsApp mini-store platform: sellers sign up, build a
catalogue, and take orders directly on WhatsApp. Built with React + Vite,
backed by **Firebase** (Authentication + Firestore — completely free, no
card required; Storage is optional, see note below).

## 🔥 1. Create your Firebase project (free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → give it a name (e.g. `apna-mini-store`) → create it.
2. **Authentication**: Build → Authentication → Get Started → enable **Email/Password**.
3. **Firestore**: Build → Firestore Database → Create Database → start in **production mode** (the rules below lock it down properly) → pick a region close to your users.
4. **Storage — optional, skip this for now**: Firebase Storage requires the
   paid "Blaze" plan (a linked card — though usage stays free within
   generous limits). This app doesn't need it: photos are compressed and
   stored directly inside Firestore instead, which is completely free.
   Only come back to this if you later upgrade to Blaze and want real file
   storage — see the note near the bottom of this README.
5. **Web app config**: Project Settings (gear icon) → General → "Your apps" → Add app → Web (`</>`) → register it → copy the `firebaseConfig` values.

## 🔑 2. Create the Super Admin account

Firebase Auth doesn't let anyone (including this app) set a password for
someone else, so create your own Super Admin login once, manually:

1. Authentication → Users → **Add user**
2. Email: `sumitart2018@gmail.com` (or whichever email you want as Super Admin)
3. Set a password you'll remember — this is the *only* place you'll ever type it.
4. That's it — the app checks `request.auth.token.email` against this email
   to grant Super Admin access (see `firestore.rules`). If you ever want to
   use a different Super Admin email, update it in **two** places:
   `src/App.jsx` (`SUPER_ADMIN_EMAIL` constant) and `firestore.rules`.

## ⚙️ 3. Configure the project

```bash
cp .env.example .env
```

Open `.env` and paste in the `firebaseConfig` values from step 1.5. Then:

```bash
npm install
npm run dev
```

Open the printed URL (usually `http://localhost:5173`) — you should see the
homepage. Try signing up a test store to confirm Firestore is connected.

## 🔒 4. Deploy the security rules (important — do this before going live)

Without this step, your database defaults to locked (nobody can read/write)
or — if you picked "test mode" instead of "production mode" — wide open
(anyone can read/write everything). Deploy the rules in this project instead:

```bash
npm install -g firebase-tools   # one-time
firebase login
firebase use --add              # pick your Firebase project
firebase deploy --only firestore:rules
```

(`storage.rules` is included too, for whenever you upgrade to Blaze and
start using Firebase Storage — deploy it then with
`firebase deploy --only storage:rules`.)

This pushes `firestore.rules` and `storage.rules` — they're written so that:
- Anyone can **read** store profiles/products (needed for the public
  storefronts and directory — customers aren't logged in).
- Only a store's own owner can **write** to their own store/products.
- Customers can **create a validated order** without logging in (checkout stays
  anonymous), but only the store owner can read it or change its status.
- Products support optional **size, color, and weight variants**; customers
  choose the variant before adding an item to the cart and the selection is
  included in the WhatsApp message and seller order dashboard.
- The landing page includes a professional template chooser with category
  filters, live storefront previews, desktop/mobile preview modes, and
  one-click template selection during store signup.
- The seller product form includes a no-cost offline **Free AI Assistant**
  that drafts a description, tags, and WhatsApp marketing copy without an
  API key or recurring AI charge.
- The public Live Stores directory stays compact with a featured horizontal
  carousel, active-store filtering, search/category/sort controls, responsive
  mobile layout, and incremental **Load More Stores** pagination.
- Visitor analytics now shows session-based homepage visitors on the SaaS
  platform and separate visitor totals in each seller dashboard. It stores no
  IP address, name, or other visitor identity; publish the updated
  `firestore.rules` after deployment.
- The Super Admin (matched by email) can update any store — that's how
  plan activation / blocking / trial extension works.

## 🚀 5. Deploy to Vercel (free)

1. Push this project to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import the repo.
3. Framework preset: **Vite** (auto-detected).
4. Add your `.env` values under **Environment Variables** (same 6 keys as `.env.example`) — Vercel won't read your local `.env` file, you have to add them here too.
5. Deploy — you'll get a free `yourproject.vercel.app` URL. Add a custom
   domain later under Project Settings → Domains if you want one.

That's the whole path from zero to a live, working, multi-device SaaS
platform — no localStorage tricks, no per-browser data, real accounts that
work from any phone or computer.

## 📁 Project structure

```
├── index.html
├── package.json
├── vite.config.js
├── firebase.json          Firebase CLI config (which rules files to deploy)
├── firestore.rules        Firestore security rules
├── storage.rules          Storage security rules
├── .env.example            copy to .env and fill in your Firebase config
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx            mounts the app
    ├── App.jsx             the entire application (all components)
    ├── index.css           minimal CSS reset (fonts load dynamically)
    ├── firebase.js         Firebase app/Auth/Firestore/Storage initialization
    └── firestoreApi.js     every read/write to Firebase lives here
```

## Data model (Firestore)

```
stores/{uid}                       one doc per seller — doc id = their Firebase Auth uid
stores/{uid}/products/{productId}  subcollection (not an array field — keeps a seller
                                    with 100 product photos from ever bloating one document)
stores/{uid}/orders/{orderId}      subcollection
analytics/platform                 session-based visits to the main SaaS homepage
```

Product/logo/banner photos are compressed client-side and stored as a field
directly on their own document (each product is its own document, so this
stays well under Firestore's 1MB-per-document limit) — no Firebase Storage
needed, no card required. If you later upgrade to Blaze and want real file
storage instead, `firestoreApi.js` already has an `uploadStoreImage()`
function ready to go — swap `handleImageUpload()` in `App.jsx` to call it
instead of `compressImage()`.

## Admin access

- **Seller login**: sellers sign up from the homepage. Sessions persist
  automatically (Firebase Auth) — no need to log in again after closing the
  browser.
- **Super Admin login**: hidden link at the bottom of the homepage footer.
  Uses the account you created in step 2 above. From the Super Admin panel,
  "Password Reset Email Bhejo" sends a seller a real email to reset their
  own password — nobody, including Super Admin, can ever see a seller's
  actual password (that's real security, working as intended).

## What's genuinely different from the old single-file version

- Real accounts that work from **any device**, not just the browser they
  were created in.
- Passwords are handled entirely by Firebase Auth — never stored or
  compared by this app's own code.
- Product/logo/banner images are compressed and stored per-document in
  Firestore — completely free (Spark plan, no card), and safe from the old
  bug class since every store/product has its own document.
- Data updates live (Firestore real-time listeners) — e.g. the Super Admin
  panel and the public directory reflect changes immediately, no refresh
  needed.
