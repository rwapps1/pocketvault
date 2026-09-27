// auth-guard.js — PocketVault edition
// -----------------------------------------------------------------------
// Same Firebase project and sign-in as the tools-personal auth-guard.js
// (rwapps1-hub, email + password), restyled for PocketVault, and it also
// EXPORTS the Firebase app/auth so each page can use Firestore.
//
// Every page includes it with a RELATIVE path (GitHub Pages project sites
// live under /PocketVault/, so "/auth-guard.js" would point at the wrong repo):
//
//   <script type="module" src="./auth-guard.js"></script>
//
// Because all repos on rwapps1.github.io share one origin, signing in here
// also signs you in to your other gated tools, and vice versa.
// -----------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAYf97LVA839hP-jUpbwQJ7JgftMvdwKLQ",
  authDomain: "rwapps1-hub.firebaseapp.com",
  projectId: "rwapps1-hub",
  storageBucket: "rwapps1-hub.firebasestorage.app",
  messagingSenderId: "605178772138",
  appId: "1:605178772138:web:0508b89695ce7588936ed3"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Resolves with the signed-in user the first time sign-in is confirmed.
let resolveReady;
export const userReady = new Promise((res) => { resolveReady = res; });

export function signOutUser() {
  return signOut(auth);
}

// Hide the real page immediately so nothing flashes before we know.
document.documentElement.style.visibility = "hidden";

const overlay = document.createElement("div");
overlay.id = "auth-guard-overlay";
overlay.innerHTML = `
  <style>
    #auth-guard-overlay {
      --ag-bg: #EEF0F2; --ag-card: #FFFFFF; --ag-text: #1A1F24; --ag-muted: #56606A;
      --ag-border: #D9DDE2; --ag-field: #F5F6F8; --ag-accent: #8C6A1F;
      --ag-btn: #1E2329; --ag-btn-text: #E4C77F; --ag-err: #A4422F; --ag-ok: #2F6B52;
      position: fixed; inset: 0; z-index: 999999;
      background: var(--ag-bg); color: var(--ag-text);
      display: flex; align-items: center; justify-content: center;
      font-family: "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 20px; box-sizing: border-box;
    }
    @media (prefers-color-scheme: dark) {
      #auth-guard-overlay {
        --ag-bg: #0F1215; --ag-card: #1A1F24; --ag-text: #ECEFF2; --ag-muted: #9AA4AE;
        --ag-border: #2A3139; --ag-field: #12161A; --ag-accent: #D8B25E;
        --ag-btn: #C9A04E; --ag-btn-text: #15191D; --ag-err: #E58B78; --ag-ok: #8CCBAE;
      }
    }
    #auth-guard-overlay .box {
      background: var(--ag-card); border: 1px solid var(--ag-border);
      padding: 32px 24px 24px; border-radius: 24px;
      width: 100%; max-width: 320px; text-align: center; box-sizing: border-box;
    }
    #auth-guard-overlay .logo { width: 64px; height: 64px; display: block; margin: 0 auto 14px; }
    #auth-guard-overlay h2 {
      font-family: Fraunces, Georgia, serif; font-weight: 600;
      margin: 0 0 4px; font-size: 1.6rem; letter-spacing: -0.01em;
    }
    #auth-guard-overlay h2 span { color: var(--ag-accent); }
    #auth-guard-overlay p { margin: 0 0 22px; color: var(--ag-muted); font-size: 0.9rem; }
    #auth-guard-overlay label {
      display: block; text-align: left; font-size: 0.8rem; font-weight: 600;
      color: var(--ag-muted); margin: 0 0 6px;
    }
    #auth-guard-overlay input {
      width: 100%; padding: 12px 14px; margin-bottom: 14px; border-radius: 12px;
      border: 1px solid var(--ag-border); background: var(--ag-field); color: var(--ag-text);
      font-size: 1rem; font-family: inherit; box-sizing: border-box;
    }
    #auth-guard-overlay input:focus { outline: 2px solid var(--ag-accent); outline-offset: 1px; }
    #auth-guard-overlay button {
      width: 100%; min-height: 48px; border-radius: 12px; border: none;
      background: var(--ag-btn); color: var(--ag-btn-text);
      font-size: 1rem; font-weight: 700; font-family: inherit; cursor: pointer; margin-top: 4px;
    }
    #auth-guard-overlay button:disabled { opacity: 0.6; }
    #auth-guard-overlay .err { color: var(--ag-err); font-size: 0.85rem; margin-top: 12px; min-height: 1em; }
    #auth-guard-overlay .msg { color: var(--ag-ok); font-size: 0.85rem; margin-top: 4px; min-height: 1em; }
    #auth-guard-overlay .forgot {
      display: inline-block; margin-top: 10px; padding: 8px; font-size: 0.85rem;
      color: var(--ag-muted); background: none; border: none; width: auto; min-height: 0;
      font-weight: 500; text-decoration: underline;
    }
  </style>
  <div class="box">
    <img class="logo" src="icon.svg" alt="" />
    <h2>Pocket<span>Vault</span></h2>
    <p>Sign in to open your vault</p>
    <label for="auth-guard-email">Email</label>
    <input type="email" id="auth-guard-email" autocomplete="username" inputmode="email" />
    <label for="auth-guard-pass">Password</label>
    <input type="password" id="auth-guard-pass" autocomplete="current-password" />
    <button id="auth-guard-btn" type="button">Sign in</button>
    <div class="err" id="auth-guard-err" role="alert"></div>
    <div class="msg" id="auth-guard-msg" role="status"></div>
    <button class="forgot" id="auth-guard-forgot" type="button">Forgot password?</button>
  </div>
`;

let overlayWired = false;

function showOverlay() {
  if (!document.body.contains(overlay)) document.body.appendChild(overlay);
  document.documentElement.style.visibility = "visible";
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  if (overlayWired) return;
  overlayWired = true;

  const emailInput = document.getElementById("auth-guard-email");
  const passInput  = document.getElementById("auth-guard-pass");
  const btn        = document.getElementById("auth-guard-btn");
  const err        = document.getElementById("auth-guard-err");
  const msg        = document.getElementById("auth-guard-msg");
  const forgot     = document.getElementById("auth-guard-forgot");

  function attemptSignIn() {
    err.textContent = ""; msg.textContent = "";
    btn.disabled = true;
    signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value)
      .catch(() => { err.textContent = "Wrong email or password."; })
      .finally(() => { btn.disabled = false; });
  }

  function attemptReset() {
    err.textContent = ""; msg.textContent = "";
    const email = emailInput.value.trim();
    if (!email) { err.textContent = "Enter your email above first, then tap this link."; return; }
    sendPasswordResetEmail(auth, email)
      .then(() => { msg.textContent = "Reset email sent — check your inbox."; })
      .catch(() => { err.textContent = "Couldn't send reset email. Check the address."; });
  }

  btn.addEventListener("click", attemptSignIn);
  forgot.addEventListener("click", attemptReset);
  emailInput.addEventListener("keydown", (e) => { if (e.key === "Enter") passInput.focus(); });
  passInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptSignIn(); });
}

function hideOverlay() {
  if (document.body.contains(overlay)) overlay.remove();
  document.documentElement.style.visibility = "visible";
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    hideOverlay();
    resolveReady(user);
  } else {
    showOverlay();
  }
});
