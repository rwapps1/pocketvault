// lock.js — fingerprint lock for PocketVault
// -----------------------------------------------------------------------
// Uses the phone's built-in fingerprint check (WebAuthn "platform
// authenticator"). If the fingerprint isn't read, Android offers the phone's
// PIN/pattern instead. This is a lock screen on the app, not encryption:
// your data is still protected by your password and the Firestore rules.
//
// When it asks:
//   - when the app is opened fresh (a new session)
//   - when you come back after it has been in the background longer than
//     the chosen time (Immediately / 1 min / 5 min)
// Moving between PocketVault pages never asks again.
// Signing in with your password counts as unlocking.
// -----------------------------------------------------------------------

import { userReady, freshSignIn } from "./auth-guard.js";

const K_ENABLED = "pv-lock-enabled";
const K_CRED = "pv-lock-cred";
const K_AFTER = "pv-lock-after";
const S_UNLOCKED = "pv-unlocked";
const S_LAST = "pv-last-active";
const GRACE_MS = 3000; // covers page-to-page navigation

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
  sget: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
};

// ---------- helpers ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function lockEnabled() {
  return store.get(K_ENABLED) === "1" && !!store.get(K_CRED);
}
export function lockAfterMs() {
  const v = Number(store.get(K_AFTER));
  return Number.isFinite(v) && store.get(K_AFTER) !== null ? v : 60000;
}
export function setLockAfter(ms) { store.set(K_AFTER, String(ms)); }

export async function lockSupported() {
  try {
    return !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

// Register a fingerprint credential for this app on this phone.
export async function enableLock(email) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: "PocketVault" },
      user: { id: randomBytes(16), name: email || "PocketVault", displayName: "PocketVault" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "discouraged"
      },
      timeout: 60000,
      attestation: "none"
    }
  });
  store.set(K_CRED, b64u(cred.rawId));
  store.set(K_ENABLED, "1");
  markUnlocked();
}

export function disableLock() {
  store.del(K_ENABLED);
  store.del(K_CRED);
}

async function verifyFingerprint() {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: unb64u(store.get(K_CRED)), transports: ["internal"] }],
      userVerification: "required",
      timeout: 60000
    }
  });
  // Flags byte (index 32): bit 0x04 = the user was verified (fingerprint/PIN)
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  if (!(flags & 0x04)) throw new Error("not-verified");
}

function markUnlocked() {
  store.sset(S_UNLOCKED, "1");
  store.sset(S_LAST, String(Date.now()));
}

function tooLongAway(since) {
  return Date.now() - since > Math.max(lockAfterMs(), GRACE_MS);
}

function needsLockOnLoad() {
  if (!lockEnabled()) return false;
  if (store.sget(S_UNLOCKED) !== "1") return true;
  return tooLongAway(Number(store.sget(S_LAST) || 0));
}

// ---------- lock screen ----------
let overlay = null;
let resolveUnlocked;
export const unlocked = new Promise((r) => { resolveUnlocked = r; });

const FINGERPRINT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 5.5A8 8 0 0 1 20 11.5v1"/><path d="M4 9a8 8 0 0 0-.5 3v1.5"/><path d="M8 12a4 4 0 0 1 8 0v1a12 12 0 0 1-1 5"/><path d="M12 12v1.5a16 16 0 0 1-2 7.5"/><path d="M6.5 14.5a13 13 0 0 1-.5 4"/><path d="M17.5 18.5c.3-.9.5-1.9.5-3"/></svg>`;

function mountLock() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.id = "pv-lock";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "PocketVault is locked");
  overlay.innerHTML = `
    <img src="icon.svg" alt="">
    <h2>Locked</h2>
    <p>Use your fingerprint to open PocketVault</p>
    <button type="button" class="btn" id="pv-unlock-btn">${FINGERPRINT_SVG}<span>Unlock</span></button>
    <p class="err" id="pv-lock-err" role="status"></p>
    <button type="button" class="link" id="pv-lock-password">Use password instead</button>`;
  document.body.appendChild(overlay);
  document.documentElement.style.overflow = "hidden";
  overlay.querySelector("#pv-unlock-btn").addEventListener("click", tryUnlock);
  overlay.querySelector("#pv-lock-password").addEventListener("click", () => {
    // Turns the lock off and signs out; sign in with your password, then
    // turn the lock back on from Account if you want it.
    disableLock();
    document.dispatchEvent(new CustomEvent("pv-use-password"));
  });
}

function unmountLock() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.documentElement.style.overflow = "";
}

let busy = false;
async function tryUnlock() {
  if (busy || !overlay) return;
  busy = true;
  const err = overlay.querySelector("#pv-lock-err");
  err.textContent = "";
  try {
    await verifyFingerprint();
    markUnlocked();
    unmountLock();
    resolveUnlocked();
  } catch (e) {
    if (overlay) {
      err.textContent = e && e.name === "NotAllowedError"
        ? "Tap Unlock to try again."
        : "Couldn't check your fingerprint. Try again, or use your password.";
    }
  } finally {
    busy = false;
  }
}

// ---------- start-up ----------
if (needsLockOnLoad()) {
  mountLock(); // covers the page straight away, underneath the sign-in box
  userReady.then(() => {
    if (freshSignIn) {             // just typed the password: that's enough
      markUnlocked(); unmountLock(); resolveUnlocked();
    } else {
      tryUnlock();                 // prompt straight away
    }
  });
} else {
  if (lockEnabled()) markUnlocked();
  resolveUnlocked();
}

// Track time away, and re-lock when coming back after too long.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    if (!overlay) store.sset(S_LAST, String(hiddenAt));
  } else if (lockEnabled() && !overlay && hiddenAt && tooLongAway(hiddenAt)) {
    mountLock();
    tryUnlock();
  }
});
window.addEventListener("pagehide", () => {
  if (!overlay) store.sset(S_LAST, String(Date.now()));
});
