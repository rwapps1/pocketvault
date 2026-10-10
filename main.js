// main.js — runs PocketVault: switching between mini apps, the back button,
// the menu bar, the eye button, the Account sheet and the opening animation.
//
// Each mini app is two files:  bills.html (its layout) + bills.js (its code).
// bills.js exports  mount(root, ctx)  which sets the app up inside `root`
// and may return a function that tidies up (stops live updates etc.) when
// you leave. ctx = { open, navigate }  — open resolves once you're signed in
// and past the fingerprint lock.

import { open, getUser, secureSignOut, VERSION } from "./app.js";
import { lockSupported, lockEnabled, enableLock, disableLock, lockAfterMs, setLockAfter } from "./lock.js";

const VIEWS = ["vault", "bills", "investments", "holidays", "earnings", "credentials"]; // earnings, credentials: vault box only, not in the menu bar
const TITLES = { vault: "PocketVault", bills: "Bills", investments: "Investments", holidays: "Holidays", earnings: "Earnings", credentials: "Credentials" };
const viewport = document.getElementById("viewport");
const tabbar = document.querySelector(".tabbar");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let current = null;          // name of the view on screen
let currentEl = null;        // its <section>
let currentCleanup = null;   // its tidy-up function
let navToken = 0;            // latest navigation wins if you tap quickly
let running = [];            // slide animations in progress

// ---------- Loading a mini app's files ----------
const htmlCache = new Map();
function getHtml(name) {
  if (!htmlCache.has(name)) {
    htmlCache.set(name, fetch(`${name}.html`).then((r) => {
      if (!r.ok) throw new Error(`${name}.html: ${r.status}`);
      return r.text();
    }).catch((e) => { htmlCache.delete(name); throw e; }));
  }
  return htmlCache.get(name);
}
function toFragment(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("script").forEach((s) => s.remove()); // only for direct visits
  return t.content;
}
function errorView(name, err) {
  const el = document.createElement("div");
  el.className = "plate empty-state";
  el.innerHTML = `<span class="box-glyph" data-icon="alert"></span><h2>Something went wrong</h2>
    <p></p><p class="err-detail"></p>`;
  el.querySelector("p").textContent = `${TITLES[name]} couldn't load. The rest of PocketVault still works — try again in a moment.`;
  el.querySelector(".err-detail").textContent = String(err && err.message || err || "");
  window.PV.fillIcons(el);
  return el;
}

// Fetch the other mini apps quietly once we're in, so switching is instant.
open.then(() => setTimeout(() => {
  VIEWS.forEach((v) => { getHtml(v).catch(() => {}); import(`./${v}.js`).catch(() => {}); });
}, 800));

// ---------- Showing a view ----------
function finishSlides() { running.slice().forEach((a) => { try { a.finish(); } catch {} }); }

async function show(name, direction) {
  const token = ++navToken;
  finishSlides();

  let frag, mod, loadErr = null;
  try {
    const [html, m] = await Promise.all([getHtml(name), import(`./${name}.js`)]);
    frag = toFragment(html); mod = m;
  } catch (e) { loadErr = e; }
  if (token !== navToken) return; // a newer tap took over

  // Tidy up the view we're leaving
  if (currentCleanup) { try { currentCleanup(); } catch (e) { console.warn(e); } }
  currentCleanup = null;

  const el = document.createElement("section");
  el.className = "view page";
  el.dataset.view = name;
  if (loadErr) el.appendChild(errorView(name, loadErr));
  else { el.appendChild(frag); window.PV.fillIcons(el); }
  paintEyes(el);

  const old = currentEl;
  window.scrollTo(0, 0);
  viewport.appendChild(el);
  current = name; currentEl = el;
  document.title = name === "vault" ? "PocketVault" : `${TITLES[name]} · PocketVault`;
  updateTabs(name);

  // Start the mini app — a mistake inside it stays inside it
  if (mod && typeof mod.mount === "function") {
    try {
      const result = mod.mount(el, { open, navigate });
      Promise.resolve(result).then((fn) => {
        if (typeof fn !== "function") return;
        if (currentEl === el) currentCleanup = fn; else { try { fn(); } catch {} }
      }).catch((e) => { el.replaceChildren(errorView(name, e)); });
    } catch (e) {
      el.replaceChildren(errorView(name, e));
    }
  }

  slide(old, el, direction);
}

function slide(oldEl, newEl, direction) {
  if (!oldEl) return;
  if (!direction || reduceMotion.matches || !newEl.animate) { oldEl.remove(); return; }
  viewport.style.height = Math.max(oldEl.offsetHeight, newEl.offsetHeight) + "px";
  oldEl.classList.add("sliding"); newEl.classList.add("sliding");
  const fwd = direction === "forward";
  const opts = { duration: 320, easing: "cubic-bezier(.3,.7,.2,1)" };
  const a1 = oldEl.animate([{ transform: "translateX(0)" }, { transform: `translateX(${fwd ? "-100%" : "100%"})` }], opts);
  const a2 = newEl.animate([{ transform: `translateX(${fwd ? "100%" : "-100%"})` }, { transform: "translateX(0)" }], opts);
  running.push(a1, a2);
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    running = running.filter((a) => a !== a1 && a !== a2);
    oldEl.remove();
    newEl.classList.remove("sliding");
    viewport.style.height = "";
  };
  a2.finished.then(finish, finish);
}

function updateTabs(name) {
  tabbar.querySelectorAll("[data-go]").forEach((a) => {
    if (a.dataset.go === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  // Views without a menu-bar tab (Earnings) hide the gold marker
  const tabIndex = [...tabbar.querySelectorAll("[data-go]")].findIndex((a) => a.dataset.go === name);
  tabbar.classList.toggle("no-tab", tabIndex < 0);
  if (tabIndex >= 0) tabbar.style.setProperty("--tab", tabIndex);
}

// ---------- Navigation & the back button ----------
// The vault is the base. Opening a mini app from the vault adds ONE history
// step (only ever on a tap). Switching between mini apps replaces that step,
// so the phone's back button always goes: mini app → vault → out of the app.
// When back is pressed we only redraw — we never add history in response.
const routeFromHash = () => {
  const h = location.hash.slice(1);
  return VIEWS.includes(h) ? h : "vault";
};
const dirFor = (from, to) => (VIEWS.indexOf(to) > VIEWS.indexOf(from) ? "forward" : "backward");
let backPending = false;

export function navigate(target) {
  if (!VIEWS.includes(target) || target === current || backPending) return;
  const dir = dirFor(current, target);
  const depth = (history.state && history.state.depth) || 0;
  if (target === "vault") {
    if (depth === 1) {
      backPending = true;
      setTimeout(() => { backPending = false; }, 1000);
      history.back(); // the redraw happens in popstate
      return;
    }
    history.replaceState({ pv: 1, depth: 0 }, "", "./");
  } else if (current === "vault") {
    history.pushState({ pv: 1, depth: 1 }, "", `#${target}`);
  } else {
    history.replaceState({ pv: 1, depth }, "", `#${target}`);
  }
  show(target, dir);
}

window.addEventListener("popstate", () => {
  backPending = false;
  const target = routeFromHash();
  if (target !== current) show(target, dirFor(current, target));
});

// Taps anywhere: [data-go] opens a view, [data-back] returns to the vault,
// [data-eye] toggles hidden amounts.
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { e.preventDefault(); navigate(go.dataset.go); return; }
  const back = e.target.closest("[data-back]");
  if (back) { e.preventDefault(); navigate("vault"); return; }
  const eye = e.target.closest("[data-eye]");
  if (eye) { toggleHidden(); return; }
});

// ---------- Eye button (hide amounts) ----------
function paintEyes(root = document) {
  const hidden = document.documentElement.classList.contains("pv-hide");
  root.querySelectorAll("[data-eye]").forEach((btn) => {
    btn.innerHTML = window.PV.icon(hidden ? "eyeOff" : "eye");
    btn.setAttribute("aria-pressed", String(hidden));
    btn.setAttribute("aria-label", hidden ? "Show amounts" : "Hide amounts");
  });
}
function toggleHidden() {
  const hidden = !document.documentElement.classList.contains("pv-hide");
  document.documentElement.classList.toggle("pv-hide", hidden);
  try { localStorage.setItem("pv-hide-amounts", hidden ? "1" : "0"); } catch {}
  paintEyes();
}

// ---------- Account sheet ----------
let sheet = null;
document.getElementById("account-tab").addEventListener("click", async () => {
  if (!sheet) sheet = await buildSheet();
  refreshSheet();
  sheet.showModal(); // the phone's back button closes it
});
open.then((u) => {
  document.getElementById("account-initial").textContent = ((u.email || "R")[0]).toUpperCase();
});

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
    </div>
    <p class="version">PocketVault version ${VERSION}</p>`;
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
        const u = getUser();
        await enableLock(u && u.email);
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
  const u = getUser();
  sheet.querySelector("#acc-email").textContent = (u && u.email) || "";
  const on = lockEnabled();
  sheet.querySelector("#lock-toggle").checked = on;
  const seg = sheet.querySelector("#lock-after");
  seg.setAttribute("aria-disabled", String(!on));
  const ms = lockAfterMs();
  seg.querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.ms) === ms)));
}

// ---------- Opening animation: once per app session ----------
let introDone = false;
try { introDone = sessionStorage.getItem("pv-intro-done") === "1"; } catch {}
let splash = null;
if (!introDone && !reduceMotion.matches) {
  splash = document.createElement("div");
  splash.id = "pv-splash";
  splash.setAttribute("aria-hidden", "true");
  splash.innerHTML = `
    <svg viewBox="0 0 512 512">
      <rect width="512" height="512" rx="112" fill="#1E2329"/>
      <path d="M128 150 H384 V296 Q384 388 256 424 Q128 388 128 296 Z" fill="#C9CED4"/>
      <path d="M150 174 H362" stroke="#1E2329" stroke-width="7" stroke-dasharray="14 12" stroke-linecap="round" fill="none"/>
      <g class="dial">
        <circle cx="256" cy="298" r="78" fill="#2B323A" stroke="#C9A04E" stroke-width="10"/>
        <path d="M256 238 L256 228 M286 246 L291 237.4 M308 268 L316.6 263 M316 298 L326 298 M308 328 L316.6 333 M286 350 L291 358.6 M256 358 L256 368 M226 350 L221 358.6 M204 328 L195.4 333 M196 298 L186 298 M204 268 L195.4 263 M226 246 L221 237.4" stroke="#C9A04E" stroke-width="6" stroke-linecap="round"/>
        <circle cx="256" cy="298" r="34" fill="#C9A04E"/>
        <path d="M256 298 L256 270" stroke="#1E2329" stroke-width="8" stroke-linecap="round"/>
      </g>
      <path d="M246 196 L266 196 L256 210 Z" fill="#C9A04E"/>
    </svg>`;
  document.body.appendChild(splash);
}
open.then(() => {
  if (!splash) return;
  splash.classList.add("go");
  setTimeout(() => {
    const boxes = currentEl && currentEl.querySelector(".boxes");
    if (boxes) boxes.classList.add("intro");
  }, 600);
  const remove = () => { if (splash) { splash.remove(); splash = null; } };
  splash.addEventListener("animationend", (e) => { if (e.target === splash) remove(); });
  setTimeout(remove, 2000); // safety net
  try { sessionStorage.setItem("pv-intro-done", "1"); } catch {}
});

// ---------- Start ----------
if (!history.state || !history.state.pv) {
  history.replaceState({ pv: 1, depth: 0 }, "", location.href);
}
show(routeFromHash(), null);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
