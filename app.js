// app.js — shared helpers for every PocketVault page
// Import from a page script:  import { ready, col, doc, formatGBP } from "./app.js";

import { app, auth, userReady, signOutUser } from "./auth-guard.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc as fsDoc,
  terminate,
  clearIndexedDbPersistence,
  waitForPendingWrites
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const OWNER_NAME = "Rob";

// Firestore with an offline cache, so ticks made without signal sync later.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// All PocketVault data lives under pocketvault/{uid}/...
let currentUser = null;
export const ready = userReady.then((user) => { currentUser = user; return user; });

// ---------- Offline copy: wiped whenever you're signed out ----------
// Firestore keeps a copy of your data on the device so the app works
// without signal. That copy is deleted:
//   1. when you tap Sign out here (after warning about unsynced changes), and
//   2. when a page opens and finds you signed out (e.g. you signed out in
//      another of your tools, or changed your password).
let wiped = false;
async function wipeLocalCopy() {
  if (wiped) return;
  wiped = true;
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (e) {
    // e.g. another PocketVault tab still open; it will be retried next time
    console.warn("PocketVault: couldn't clear offline copy", e);
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    // Signed back in after the copy was wiped on this page: start fresh.
    if (wiped) location.reload();
  } else {
    wipeLocalCopy();
  }
});

// True if everything has reached the server, false if changes are still waiting.
function allSynced(timeoutMs = 1500) {
  return Promise.race([
    waitForPendingWrites(db).then(() => true),
    new Promise((res) => setTimeout(() => res(false), timeoutMs))
  ]);
}

function confirmDialog(message, okText, cancelText) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "pv-dialog";
    dlg.innerHTML = `
      <p></p>
      <div class="pv-dialog-actions">
        <button type="button" class="pv-dialog-cancel"></button>
        <button type="button" class="btn pv-dialog-ok"></button>
      </div>`;
    dlg.querySelector("p").textContent = message;
    dlg.querySelector(".pv-dialog-cancel").textContent = cancelText;
    dlg.querySelector(".pv-dialog-ok").textContent = okText;
    const finish = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector(".pv-dialog-ok").addEventListener("click", () => finish(true));
    dlg.querySelector(".pv-dialog-cancel").addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); }); // phone back button / Esc
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export async function secureSignOut() {
  if (!(await allSynced())) {
    const go = await confirmDialog(
      "You have changes that haven't synced yet. Signing out now will lose them.",
      "Sign out anyway",
      "Stay signed in"
    );
    if (!go) return;
  }
  await wipeLocalCopy();
  await signOutUser();
  location.reload();
}

export function col(name, ...more) {
  return collection(db, "pocketvault", currentUser.uid, name, ...more);
}
export function doc(name, ...more) {
  return fsDoc(db, "pocketvault", currentUser.uid, name, ...more);
}

// ---------- Formatting ----------
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const formatGBP = (n, whole = false) => (whole ? gbp0 : gbp).format(Number(n) || 0);

export function formatPct(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// "2026-09" style key for the current (or given) month
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function longDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ---------- Account menu (the round initial button) ----------
export function wireAccountMenu() {
  const btn = document.getElementById("account-btn");
  const menu = document.getElementById("account-menu");
  if (!btn || !menu) return;

  ready.then((user) => {
    const email = user.email || "";
    btn.textContent = (email[0] || "R").toUpperCase();
    const emailEl = document.getElementById("account-email");
    if (emailEl) emailEl.textContent = email;
  });

  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) close(); });

  const out = document.getElementById("signout-btn");
  if (out) out.addEventListener("click", () => { close(); secureSignOut(); });
}

// ---------- Back button on mini-app pages ----------
// Each mini app is its own page, so the phone's back button already works
// through normal browser history. The on-screen back arrow does the same
// thing when we came from the home screen, otherwise it goes home directly
// (e.g. if the page was opened from a bookmark).
export function wireBackButton() {
  const back = document.getElementById("back-btn");
  if (!back) return;
  back.addEventListener("click", (e) => {
    e.preventDefault();
    const ref = document.referrer;
    const home = new URL("./", location.href).href;
    const cameFromHome = ref && (ref === home || ref === home + "index.html");
    if (cameFromHome && history.length > 1) history.back();
    else location.replace(home);
  });
}

// ---------- Service worker (lets Chrome install the app) ----------
export function registerSW() {
  if ("serviceWorker" in navigator) {
    const swUrl = new URL("./sw.js", import.meta.url);
    navigator.serviceWorker.register(swUrl).catch(() => {});
  }
}

export { auth };
