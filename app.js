// app.js — shared code for every PocketVault page
// Each page script calls initPage("home" | "bills" | "investments" | "holidays").

import { app, auth, userReady, signOutUser } from "./auth-guard.js";
import { lockSupported, lockEnabled, enableLock, disableLock, lockAfterMs, setLockAfter, unlocked } from "./lock.js";
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

// ---------- Hide amounts (eye button); first applied in shell.js ----------
const HIDE_KEY = "pv-hide-amounts";

// ---------- Firestore ----------
// Keeps an offline copy so ticks made without signal sync later.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// All PocketVault data lives under pocketvault/{uid}/...
let currentUser = null;
export const ready = userReady.then((user) => { currentUser = user; return user; });

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

export function confirmDialog(message, okText, cancelText) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "pv-dialog";
    dlg.innerHTML = `
      <p></p>
      <div class="pv-dialog-actions">
        <button type="button" class="btn-ghost pv-dialog-cancel"></button>
        <button type="button" class="btn pv-dialog-ok"></button>
      </div>`;
    dlg.querySelector("p").textContent = message;
    dlg.querySelector(".pv-dialog-cancel").textContent = cancelText;
    dlg.querySelector(".pv-dialog-ok").textContent = okText;
    const finish = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector(".pv-dialog-ok").addEventListener("click", () => finish(true));
    dlg.querySelector(".pv-dialog-cancel").addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); }); // phone back button
    document.body.appendChild(dlg);
    dlg.showModal();
  });
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
  location.reload();
}

// "Use password instead" on the lock screen
document.addEventListener("pv-use-password", () => secureSignOut({ skipCheck: true }));

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

// ---------- Icons: ONE set, defined in shell.js ----------
export function icon(name, strokeWidth) {
  return window.PV ? window.PV.icon(name, strokeWidth) : "";
}

// ---------- Navigation ----------
// Tabs keep one level above home, so the phone's back button always
// returns to the vault and then leaves the app.
const PAGES = { home: "./", bills: "bills.html", investments: "investments.html", holidays: "holidays.html" };
const HOME_BELOW = "pv-home-below";
const ss = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }
};

export function goHome() {
  if (ss.get(HOME_BELOW) === "1") history.back();
  else location.replace(new URL("./", location.href).href);
}

function goTo(current, target) {
  if (target === current) return;
  if (target === "home") return goHome();
  if (current === "home") { ss.set(HOME_BELOW, "1"); location.href = PAGES[target]; }
  else location.replace(PAGES[target]);
}


function wireTabbar(current) {
  const nav = document.querySelector(".tabbar");
  if (!nav) return;
  nav.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    goTo(current, a.dataset.go);
  }));
  nav.querySelector("#account-tab").addEventListener("click", openAccount);
  ready.then((u) => {
    nav.querySelector("#account-initial").textContent = ((u.email || "R")[0]).toUpperCase();
  });
}

// ---------- Eye button ----------
function wireEye() {
  const btn = document.getElementById("eye-btn");
  if (!btn) return;
  const paint = () => {
    const hidden = document.documentElement.classList.contains("pv-hide");
    btn.innerHTML = icon(hidden ? "eyeOff" : "eye");
    btn.setAttribute("aria-pressed", String(hidden));
    btn.setAttribute("aria-label", hidden ? "Show amounts" : "Hide amounts");
  };
  paint();
  btn.addEventListener("click", () => {
    const hidden = !document.documentElement.classList.contains("pv-hide");
    document.documentElement.classList.toggle("pv-hide", hidden);
    try { localStorage.setItem(HIDE_KEY, hidden ? "1" : "0"); } catch {}
    paint();
  });
}

// ---------- Account sheet ----------
let sheet = null;
async function openAccount() {
  if (!sheet) sheet = await buildSheet();
  refreshSheet();
  sheet.showModal();
}

const LOCK_OPTIONS = [[0, "Immediately"], [60000, "1 min"], [300000, "5 min"]];

async function buildSheet() {
  const supported = await lockSupported();
  const d = document.createElement("dialog");
  d.className = "sheet";
  d.setAttribute("aria-label", "Account");
  d.innerHTML = `
    <div class="sheet-grip"></div>
    <h2>Account</h2>
    <p class="email" id="acc-email"></p>
    <div class="sheet-row">
      <div class="txt">
        <strong>Fingerprint lock</strong>
        <small id="lock-note">${supported ? "Ask for your fingerprint when opening PocketVault" : "Not available on this device"}</small>
      </div>
      <label class="switch">
        <input type="checkbox" id="lock-toggle" aria-label="Fingerprint lock"${supported ? "" : " disabled"}>
        <span class="track"></span>
      </label>
    </div>
    <div class="lock-after">
      <small>Lock again after the app has been in the background for</small>
      <div class="segmented" id="lock-after" role="group" aria-label="Lock after">
        ${LOCK_OPTIONS.map(([ms, label]) => `<button type="button" data-ms="${ms}">${label}</button>`).join("")}
      </div>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn-ghost" id="acc-signout">Sign out</button>
      <button type="button" class="btn-ghost" id="acc-close">Close</button>
    </div>`;
  document.body.appendChild(d);

  d.querySelector("#acc-close").addEventListener("click", () => d.close());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // tap outside
  d.querySelector("#acc-signout").addEventListener("click", () => { d.close(); secureSignOut(); });

  const toggle = d.querySelector("#lock-toggle");
  const note = d.querySelector("#lock-note");
  toggle.addEventListener("change", async () => {
    if (toggle.checked) {
      toggle.disabled = true;
      note.textContent = "Touch the fingerprint sensor…";
      try {
        await enableLock(currentUser && currentUser.email);
        note.textContent = "On. PocketVault will ask for your fingerprint.";
      } catch (e) {
        toggle.checked = false;
        note.textContent = "Not turned on — the fingerprint check was cancelled.";
      }
      toggle.disabled = false;
    } else {
      disableLock();
      note.textContent = "Off.";
    }
    refreshSheet();
  });

  d.querySelectorAll("#lock-after button").forEach((b) => b.addEventListener("click", () => {
    setLockAfter(Number(b.dataset.ms));
    refreshSheet();
  }));
  return d;
}

function refreshSheet() {
  if (!sheet) return;
  sheet.querySelector("#acc-email").textContent = (currentUser && currentUser.email) || "";
  const on = lockEnabled();
  sheet.querySelector("#lock-toggle").checked = on;
  const seg = sheet.querySelector("#lock-after");
  seg.setAttribute("aria-disabled", String(!on));
  const current = lockAfterMs();
  seg.querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.ms) === current)));
}

// ---------- Service worker (lets Chrome install the app) ----------
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("./sw.js", import.meta.url)).catch(() => {});
  }
}

// ---------- Page set-up ----------
export function initPage(current) {
  wireTabbar(current);
  wireEye();

  const back = document.getElementById("back-btn");
  if (back) back.addEventListener("click", (e) => { e.preventDefault(); goHome(); });

  if (current === "home") {
    window.addEventListener("pageshow", () => ss.set(HOME_BELOW, "0"));
    ss.set(HOME_BELOW, "0");
    document.querySelectorAll("main a[data-go]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      goTo("home", a.dataset.go);
    }));
  }
  registerSW();
}

// Resolves once signed in AND past the fingerprint lock.
export const open = Promise.all([ready, unlocked]).then(([u]) => u);

export { auth, icon as iconSvg };
