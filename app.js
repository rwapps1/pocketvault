// app.js — shared toolkit for PocketVault and its mini apps
// A mini app imports what it needs, e.g.
//   import { col, doc, formatGBP, confirmDialog } from "./app.js";
// Nothing here draws the screen; main.js runs the app.

import { app, auth, userReady, signOutUser } from "./auth-guard.js";
import { unlocked } from "./lock.js";
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
export const VERSION = "14"; // shown in Account — bump with each upload

// ---------- Firestore ----------
// Keeps an offline copy so ticks made without signal sync later.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// All PocketVault data lives under pocketvault/{uid}/...
let currentUser = null;
export const ready = userReady.then((user) => { currentUser = user; return user; });
export const getUser = () => currentUser;

// Resolves once signed in AND past the fingerprint lock.
export const open = Promise.all([ready, unlocked]).then(([u]) => u);

export function col(name, ...more) {
  return collection(db, "pocketvault", currentUser.uid, name, ...more);
}
export function doc(name, ...more) {
  return fsDoc(db, "pocketvault", currentUser.uid, name, ...more);
}

// ---------- Offline copy: wiped whenever you're signed out ----------
let wiped = false;
async function wipeLocalCopy() {
  if (wiped) return;
  wiped = true;
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (e) {
    console.warn("PocketVault: couldn't clear offline copy", e);
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    if (wiped) location.reload(); // signed back in after a wipe: start fresh
  } else {
    wipeLocalCopy();
  }
});

function allSynced(timeoutMs = 1500) {
  return Promise.race([
    waitForPendingWrites(db).then(() => true),
    new Promise((res) => setTimeout(() => res(false), timeoutMs))
  ]);
}

export async function secureSignOut({ skipCheck = false } = {}) {
  if (!skipCheck && !(await allSynced())) {
    const go = await confirmDialog(
      "You have changes that haven't synced yet. Signing out now will lose them.",
      "Sign out anyway",
      "Stay signed in"
    );
    if (!go) return;
  }
  await wipeLocalCopy();
  await signOutUser();
  location.replace(new URL("./", location.href).href);
}

// "Use password instead" on the lock screen
document.addEventListener("pv-use-password", () => secureSignOut({ skipCheck: true }));

// ---------- Dialogs ----------
// Uses <dialog>, which the phone's back button closes by itself (it counts
// as "Cancel") without leaving the screen underneath.
export function confirmDialog(message, okText, cancelText, title) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "pv-dialog";
    dlg.innerHTML = `
      ${title ? "<h2></h2>" : ""}
      <p></p>
      <div class="pv-dialog-actions">
        ${cancelText ? `<button type="button" class="btn-ghost pv-dialog-cancel"></button>` : ""}
        <button type="button" class="btn pv-dialog-ok"></button>
      </div>`;
    if (title) dlg.querySelector("h2").textContent = title;
    dlg.querySelector("p").textContent = message;
    if (cancelText) dlg.querySelector(".pv-dialog-cancel").textContent = cancelText;
    dlg.querySelector(".pv-dialog-ok").textContent = okText;
    const finish = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector(".pv-dialog-ok").addEventListener("click", () => finish(true));
    if (cancelText) dlg.querySelector(".pv-dialog-cancel").addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

// ---------- Icons (one set, defined in shell.js) ----------
export function icon(name, strokeWidth) {
  return window.PV ? window.PV.icon(name, strokeWidth) : "";
}

// ---------- Formatting ----------
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const formatGBP = (n, whole = false) => (whole ? gbp0 : gbp).format(Number(n) || 0);
export function formatPct(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export { auth };
