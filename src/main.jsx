import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

// If something in App.jsx (most commonly: missing/incorrect Firebase env
// vars) throws while the app is starting up, the person would otherwise see
// a completely blank white page with zero explanation — a very common and
// very confusing failure mode. This wraps startup so a real, readable
// message shows on screen instead, telling them exactly what to check.
function showFatalError(err) {
  console.error("App failed to start:", err);
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 60px auto; padding: 24px; color: #1F2937; line-height: 1.6;">
      <h2 style="color: #DC2626; margin-bottom: 8px;">App couldn't start</h2>
      <p style="margin-bottom: 12px;">This almost always means the Firebase configuration values aren't set.</p>
      <ul style="margin-bottom: 12px; padding-left: 20px;">
        <li>Running locally? Copy <code>.env.example</code> to <code>.env</code> and fill in your Firebase project's values.</li>
        <li>Deployed on Vercel (or similar)? Add the same 6 <code>VITE_FIREBASE_*</code> values under
          Project Settings → Environment Variables, then redeploy — Vercel does not read your local <code>.env</code> file.</li>
      </ul>
      <p style="font-size: 13px; color: #6B7280;">Open the browser console (F12 → Console tab) for the exact technical error. See README.md for full setup steps.</p>
    </div>
  `;
}

(async () => {
  try {
    const { default: App } = await import("./App.jsx");
    ReactDOM.createRoot(document.getElementById("root")).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (err) {
    showFatalError(err);
  }
})();

window.addEventListener("error", (e) => {
  if (!document.getElementById("root")?.hasChildNodes()) showFatalError(e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  if (!document.getElementById("root")?.hasChildNodes()) showFatalError(e.reason);
});
