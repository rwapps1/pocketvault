// credentials.js — the Credentials mini app: your logins, encrypted.
//
// Every account is scrambled on this phone (AES-256-GCM) before it's saved,
// so Firebase, the phone's offline copy and anyone with your login see only
// gibberish. The scrambling key is itself locked twice: once with your
// master passphrase and once with a recovery code shown when you set up.
// Neither the passphrase nor the code is stored anywhere.
//
// Once unlocked, the key stays in memory until PocketVault locks again
// (same timing as the fingerprint lock), you tap the lock button, or the
// app is closed.

import { col, doc, confirmDialog } from "./app.js";
import { lockEnabled, lockAfterMs } from "./lock.js";
import {
  onSnapshot, setDoc, deleteDoc, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

//   pocketvault/{you}/meta/credentials  { v, iter, saltP, wrapP {iv, ct}, saltR, wrapR {iv, ct}, hint }
//   pocketvault/{you}/credentials/{id}  { iv, ct, at }   (ct = encrypted account details)
const credMeta = () => doc("meta", "credentials");
const credCol = () => col("credentials");

const ITER = 600000;          // PBKDF2-SHA256 rounds
const FIELDS = [
  ["account", "Account"], ["email", "Email"], ["username", "Username"],
  ["password", "Password"], ["pin", "PIN"], ["memorable", "Memorable word"]
];

// ---------- Crypto (Web Crypto, built into the browser) ----------
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function deriveKey(secret, salt, iter = ITER) {
  const base = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(key, bytes) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct)));
}
const importDataKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
export const encryptEntry = async (key, obj) => seal(key, te.encode(JSON.stringify(obj)));
export const decryptEntry = async (key, box) => JSON.parse(td.decode(await unseal(key, box)));

// Recovery code: 24 characters (no 0/O/1/I/L), shown in groups of 4
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newRecoveryCode() {
  const r = rand(24);
  const s = [...r].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  return s.match(/.{4}/g).join("-");
}
export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Set up: a random data key, locked with the passphrase and with a recovery code
export async function createVault(passphrase, hint) {
  const raw = rand(32);
  const code = newRecoveryCode();
  const saltP = rand(16), saltR = rand(16);
  const meta = {
    v: 1, iter: ITER, hint: hint || "",
    saltP: b64(saltP), wrapP: await seal(await deriveKey(passphrase, saltP), raw),
    saltR: b64(saltR), wrapR: await seal(await deriveKey(normCode(code), saltR), raw)
  };
  return { meta, code, raw, key: await importDataKey(raw) };
}
// Unlock with the passphrase (or the recovery code). Throws if it's wrong.
export async function unlockVault(meta, secret, useCode = false) {
  const salt = unb64(useCode ? meta.saltR : meta.saltP);
  const wrap = useCode ? meta.wrapR : meta.wrapP;
  const raw = await unseal(await deriveKey(useCode ? normCode(secret) : secret, salt, meta.iter || ITER), wrap);
  return { raw, key: await importDataKey(raw) };
}
export async function rewrapPassphrase(meta, raw, passphrase, hint) {
  const saltP = rand(16);
  return { ...meta, hint: hint || "", saltP: b64(saltP), wrapP: await seal(await deriveKey(passphrase, saltP, meta.iter || ITER), raw) };
}
export async function rewrapCode(meta, raw) {
  const code = newRecoveryCode();
  const saltR = rand(16);
  return { meta: { ...meta, saltR: b64(saltR), wrapR: await seal(await deriveKey(normCode(code), saltR, meta.iter || ITER), raw) }, code };
}

// ---------- The unlocked key: kept in memory only, shared between visits ----------
let session = null;            // { key, raw }
const forget = () => { session = null; document.dispatchEvent(new CustomEvent("pv-cred-locked")); };
// Lock again on the same timing as PocketVault's fingerprint lock
// (or after 5 minutes away if the fingerprint lock is off).
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  const limit = lockEnabled() ? Math.max(lockAfterMs(), 500) : 5 * 60 * 1000;
  if (session && away > limit) forget();
});

export function mount(root, { open: ready }) {
  const $ = (sel) => root.querySelector(sel);
  const icon = (n) => window.PV.icon(n);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);
  const body = $("[data-body]");

  let meta = null, metaLoaded = false;
  let docs = [], docsLoaded = false;
  let entries = [];            // decrypted: { id, account, email, … }
  let query = "";
  let stops = [];
  const dialogs = new Set();
  const live = new Set();
  let decryptRun = 0;

  ready.then(() => {
    stops.push(onSnapshot(credMeta(), (snap) => {
      meta = snap.exists() ? snap.data() : null;
      metaLoaded = true; render();
    }, showError));
    stops.push(onSnapshot(credCol(), (snap) => {
      docs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.iv && d.ct);
      docsLoaded = true; decryptAll();
    }, showError));
  });
  function showError(e) { console.error(e); body.innerHTML = `<p class="bills-loading">Couldn't load your credentials.</p>`; }

  async function decryptAll() {
    if (!session) { render(); return; }
    const run = ++decryptRun;
    const out = [];
    for (const d of docs) {
      try { out.push({ id: d.id, ...(await decryptEntry(session.key, d)) }); }
      catch { out.push({ id: d.id, account: "⚠ Can't be read", broken: true }); }
    }
    if (run !== decryptRun) return;
    entries = out.sort((a, b) => String(a.account || "").localeCompare(String(b.account || ""), "en-GB", { sensitivity: "base" }));
    render();
  }

  const onLocked = () => { entries = []; [...dialogs].forEach((d) => { try { d.close(); } catch {} }); render(); };
  document.addEventListener("pv-cred-locked", onLocked);

  $("[data-cred-lock]").addEventListener("click", forget);
  $("[data-cred-add]").addEventListener("click", () => session && openEdit(null));

  // ---------- Screens ----------
  function render() {
    live.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    const unlockedNow = !!session && !!meta;
    $("[data-cred-lock]").hidden = !unlockedNow;
    $("[data-cred-add]").hidden = !unlockedNow;
    if (!metaLoaded) return;
    if (!meta) { body.replaceChildren(setupCard()); return; }
    if (!session) { body.replaceChildren(unlockCard()); return; }
    if (!docsLoaded) return;
    renderList();
  }

  function lockedCard(title, text, inner) {
    return el(`<section class="plate cred-lockcard">
        <span class="box-glyph">${icon("lock")}</span>
        <h2>${title}</h2>
        <p>${text}</p>
        ${inner}
      </section>`);
  }

  function unlockCard() {
    let useCode = false;
    const c = lockedCard("Locked", "Enter your master passphrase to open your accounts.", `
      <form class="cred-unlock" novalidate>
        <input name="secret" type="password" autocomplete="current-password" aria-label="Master passphrase" placeholder="Master passphrase">
        <p class="form-err" role="alert"></p>
        <button type="submit" class="btn">Unlock</button>
      </form>
      ${meta.hint ? `<button type="button" class="link-btn" data-hint>Show hint</button><p class="cred-hint" hidden></p>` : ""}
      <button type="button" class="link-btn" data-code>Use recovery code instead</button>`);
    const f = c.querySelector("form");
    const input = f.elements.secret;
    const err = c.querySelector(".form-err");
    const hintBtn = c.querySelector("[data-hint]");
    if (hintBtn) hintBtn.addEventListener("click", () => {
      const p = c.querySelector(".cred-hint");
      p.textContent = `Hint: ${meta.hint}`;
      p.hidden = false; hintBtn.hidden = true;
    });
    c.querySelector("[data-code]").addEventListener("click", (e) => {
      useCode = !useCode;
      input.type = useCode ? "text" : "password";
      input.value = ""; err.textContent = "";
      input.placeholder = useCode ? "Recovery code, e.g. ABCD-EFGH-…" : "Master passphrase";
      input.setAttribute("autocapitalize", useCode ? "characters" : "off");
      c.querySelector("p:not(.form-err):not(.cred-hint)").textContent = useCode
        ? "Enter the recovery code you wrote down when you set up Credentials."
        : "Enter your master passphrase to open your accounts.";
      e.target.textContent = useCode ? "Use passphrase instead" : "Use recovery code instead";
      input.focus();
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const secret = input.value;
      if (!secret) { err.textContent = useCode ? "Enter your recovery code." : "Enter your passphrase."; return; }
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Unlocking…";
      try {
        session = await unlockVault(meta, secret, useCode);
      } catch {
        err.textContent = useCode ? "That recovery code isn't right." : "That passphrase isn't right.";
        btn.disabled = false; btn.textContent = "Unlock";
        input.select();
        return;
      }
      input.value = "";
      await decryptAll();
      // Came in with the recovery code: choose a new passphrase now
      if (useCode) openPassphrase(true);
    });
    setTimeout(() => input.focus(), 80);
    return c;
  }

  function setupCard() {
    const c = lockedCard("Set up Credentials",
      "Choose a master passphrase. Your accounts are scrambled with it on this phone before anything is saved, so only someone who knows it can read them.", `
      <form class="cred-unlock form" novalidate>
        <input name="p1" type="password" autocomplete="new-password" placeholder="Master passphrase" aria-label="Master passphrase">
        <input name="p2" type="password" autocomplete="new-password" placeholder="Type it again" aria-label="Type it again">
        <input name="hint" type="text" autocomplete="off" maxlength="80" placeholder="Hint (optional)" aria-label="Hint">
        <small class="tp-hint">The hint is shown on the locked screen, so make it something only you would understand — never the passphrase itself.</small>
        <p class="form-err" role="alert"></p>
        <button type="submit" class="btn">Create</button>
      </form>`);
    const f = c.querySelector("form");
    const err = c.querySelector(".form-err");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const p1 = f.elements.p1.value, p2 = f.elements.p2.value, hint = f.elements.hint.value.trim();
      const msg = passProblem(p1, p2, hint);
      if (msg) { err.textContent = msg; return; }
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Setting up…";
      const v = await createVault(p1, hint);
      await writeOffline(setDoc(credMeta(), v.meta)).catch(console.error);
      session = { key: v.key, raw: v.raw };
      showCode(v.code, true);
    });
    return c;
  }

  function passProblem(p1, p2, hint) {
    if (p1.length < 8) return "Use at least 8 characters — a few words together works well.";
    if (p1 !== p2) return "The two passphrases don't match.";
    if (hint && hint.toLowerCase().includes(p1.toLowerCase())) return "The hint can't contain the passphrase.";
    return "";
  }

  // The recovery code, shown once
  function showCode(code, first) {
    const d = sheet("cred-code-sheet", "Recovery code", `
      <div class="sheet-grip"></div>
      <h2>Your recovery code</h2>
      <p class="payer-sub">If you ever forget your passphrase, this code is the only other way in. Write it down and keep it somewhere safe, away from your phone. It won't be shown again.</p>
      <div class="cred-code">${code.slice(0, 14)}<br>${code.slice(15)}</div>
      <label class="trav-check cred-ack"><input type="checkbox"><span class="tbox">${icon("check")}</span><span class="nm">I've written it down</span></label>
      <div class="sheet-buttons"><button type="button" class="btn" data-ok disabled>Continue</button></div>`);
    d.addEventListener("cancel", (e) => e.preventDefault()); // must tick first
    d.onclick = null;
    const ok = d.querySelector("[data-ok]");
    d.querySelector(".cred-ack input").addEventListener("change", (e) => { ok.disabled = !e.target.checked; });
    ok.addEventListener("click", () => d.close());
    d.addEventListener("close", () => { if (first) decryptAll(); });
    showDialog(d);
  }

  function renderList() {
    const wrap = el(`<div class="cred-list-wrap">
        <label class="cred-search">${icon("search")}<input type="search" placeholder="Search accounts" aria-label="Search accounts" autocomplete="off"></label>
        <div class="cred-list"></div>
        <button type="button" class="link-btn cred-settings">Change passphrase, hint or recovery code</button>
      </div>`);
    const input = wrap.querySelector("input");
    input.value = query;
    input.addEventListener("input", () => { query = input.value; drawRows(); });
    const list = wrap.querySelector(".cred-list");
    const drawRows = () => {
      const qq = query.trim().toLowerCase();
      const items = qq ? entries.filter((e) => [e.account, e.email, e.username].some((v) => String(v || "").toLowerCase().includes(qq))) : entries;
      const out = [];
      if (!entries.length) out.push(el(`<p class="act-empty">No accounts yet. Tap <strong>+</strong> to add your first one.</p>`));
      else if (!items.length) out.push(el(`<p class="act-empty">No accounts match “${esc(query)}”.</p>`));
      let letter = null;
      items.forEach((e) => {
        const L = (String(e.account || "#").trim()[0] || "#").toUpperCase();
        const head = /[A-Z]/.test(L) ? L : "#";
        if (head !== letter) { letter = head; out.push(el(`<div class="cred-letter">${head}</div>`)); }
        const row = el(`<button type="button" class="cred-row">
            <span class="pr-text"><b>${esc(e.account)}</b><small>${esc(e.email || e.username || "")}</small></span>
            <span class="cred-chev">${icon("back")}</span>
          </button>`);
        row.addEventListener("click", () => openView(e.id));
        out.push(row);
      });
      list.replaceChildren(...out);
    };
    drawRows();
    wrap.querySelector(".cred-settings").addEventListener("click", openSettings);
    const hadFocus = document.activeElement && document.activeElement.matches(".cred-search input");
    body.replaceChildren(wrap);
    if (hadFocus) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  // ---------- Pop-ups ----------
  function sheet(cls, title, html) {
    const d = document.createElement("dialog");
    d.className = "sheet " + cls;
    d.setAttribute("aria-label", title);
    d.innerHTML = html;
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    return d;
  }
  function showDialog(d, redraw) {
    document.body.appendChild(d);
    dialogs.add(d);
    if (redraw) live.add(redraw);
    d.addEventListener("close", () => { d.remove(); dialogs.delete(d); if (redraw) live.delete(redraw); });
    d.showModal();
    requestAnimationFrame(() => { const a = d.querySelector(":focus"); if (a && a.matches("input")) a.blur(); });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const t = document.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      t.remove(); return ok;
    }
  }

  function openView(id) {
    const d = sheet("cred-view", "Account", "");
    let copied = "";
    const draw = () => {
      const e = entries.find((x) => x.id === id);
      if (!e) { d.close(); return; }
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <div class="cred-view-head"><h2></h2><button type="button" class="cred-edit-btn" data-edit${e.broken ? " disabled" : ""}>${icon("pen")}Edit</button></div>
        <div class="cred-fields">${FIELDS.slice(1).map(([k, label]) => `
          <div class="cred-field">
            <span class="cf-text"><small>${label}</small><span class="cf-val${["password", "pin", "memorable"].includes(k) ? " mono" : ""}">${e[k] ? esc(e[k]) : `<i class="muted">—</i>`}</span></span>
            <button type="button" class="square-btn" data-copy="${k}" aria-label="Copy ${label.toLowerCase()}"${e[k] ? "" : " disabled"}>${icon("copy")}</button>
          </div>`).join("")}</div>
        <div class="cred-view-foot"><span class="up" data-copied>${copied ? `✓ ${copied} copied` : ""}</span><button type="button" class="btn-ghost" data-done>Done</button></div>`;
      d.querySelector("h2").textContent = e.account;
      d.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
        const k = b.dataset.copy;
        const label = FIELDS.find(([f]) => f === k)[1];
        const ok = await copy(String(e[k] || ""));
        copied = ok ? label : "";
        const out = d.querySelector("[data-copied]");
        out.textContent = ok ? `✓ ${label} copied` : "Couldn't copy — press and hold the text instead";
        out.className = ok ? "up" : "down";
        if (ok && navigator.vibrate) navigator.vibrate(10);
      }));
      d.querySelector("[data-edit]").addEventListener("click", () => { d.close(); openEdit(id); });
      d.querySelector("[data-done]").addEventListener("click", () => d.close());
    };
    draw();
    showDialog(d, draw);
  }

  function openEdit(id) {
    const e = id ? entries.find((x) => x.id === id) : null;
    const d = sheet("cred-edit", e ? "Edit account" : "Add an account", `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2></h2>
        <div class="form">
          <label class="fld"><span>Account</span><input name="account" type="text" autocomplete="off" maxlength="60" placeholder="e.g. Barclays"></label>
          <div class="two">
            <label class="fld"><span>Email</span><input name="email" type="email" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
            <label class="fld"><span>Username</span><input name="username" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          </div>
          <label class="fld"><span>Password</span><input name="password" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <div class="two">
            <label class="fld"><span>PIN</span><input name="pin" type="text" inputmode="numeric" autocomplete="off"></label>
            <label class="fld"><span>Memorable word</span><input name="memorable" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          </div>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${e ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`);
    d.querySelector("h2").textContent = e ? `Edit · ${e.account}` : "Add an account";
    const f = d.querySelector("form");
    if (e) FIELDS.forEach(([k]) => { f.elements[k].value = e[k] || ""; });
    const err = d.querySelector(".form-err");
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.textContent = "";
      if (!session) { d.close(); return; }
      const data = Object.fromEntries(FIELDS.map(([k]) => [k, f.elements[k].value.trim()]));
      if (!data.account) { err.textContent = "Enter the account name."; f.elements.account.focus(); return; }
      const btn = d.querySelector("[data-save]");
      btn.disabled = true;
      try {
        const box = await encryptEntry(session.key, data);
        await writeOffline(setDoc(e ? fsDoc(credCol(), e.id) : fsDoc(credCol()), { ...box, at: Date.now() }));
        d.close();
      } catch (ex) {
        console.error(ex);
        err.textContent = "Couldn't save — try again.";
        btn.disabled = false;
      }
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete ${e.account}? This can't be undone.`, "Delete", "Keep"))) return;
      deleteDoc(fsDoc(credCol(), e.id)).catch(console.error);
      d.close();
    });
    showDialog(d);
    if (!e) setTimeout(() => f.elements.account.focus(), 80);
  }

  // Change passphrase / hint (forced after unlocking with the recovery code)
  function openPassphrase(forced) {
    const d = sheet("cred-edit", "New passphrase", `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${forced ? "Choose a new passphrase" : "Change passphrase"}</h2>
        ${forced ? `<p class="payer-sub">You unlocked with your recovery code. Choose a new passphrase now — your recovery code keeps working too.</p>` : ""}
        <div class="form">
          <label class="fld"><span>New passphrase</span><input name="p1" type="password" autocomplete="new-password"></label>
          <label class="fld"><span>Type it again</span><input name="p2" type="password" autocomplete="new-password"></label>
          <label class="fld"><span>Hint (optional)</span><input name="hint" type="text" autocomplete="off" maxlength="80"></label>
          <small class="tp-hint">The hint shows on the locked screen — never put the passphrase itself in it.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${forced ? "" : `<button type="button" class="btn-ghost" data-cancel>Cancel</button>`}
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`);
    const f = d.querySelector("form");
    f.elements.hint.value = (meta && meta.hint) || "";
    if (forced) { d.addEventListener("cancel", (e) => e.preventDefault()); d.onclick = null; }
    const cancel = d.querySelector("[data-cancel]");
    if (cancel) cancel.addEventListener("click", () => d.close());
    const err = d.querySelector(".form-err");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const p1 = f.elements.p1.value, p2 = f.elements.p2.value, hint = f.elements.hint.value.trim();
      const msg = passProblem(p1, p2, hint);
      if (msg) { err.textContent = msg; return; }
      if (!session) { d.close(); return; }
      const btn = d.querySelector("[data-save]");
      btn.disabled = true; btn.textContent = "Saving…";
      const m = await rewrapPassphrase(meta, session.raw, p1, hint);
      await writeOffline(setDoc(credMeta(), m)).catch(console.error);
      d.close();
    });
    showDialog(d);
  }

  function openSettings() {
    const d = sheet("cred-edit", "Credentials settings", `
      <div class="sheet-grip"></div>
      <h2>Passphrase &amp; recovery</h2>
      <div class="cred-set-rows">
        <button type="button" class="set-pot" data-pass><span>Change passphrase or hint</span>${icon("pen")}</button>
        <button type="button" class="set-pot" data-code><span>Make a new recovery code</span>${icon("key")}</button>
      </div>
      <p class="payer-sub">A new recovery code replaces the old one, which stops working.</p>
      <div class="sheet-buttons"><button type="button" class="btn-ghost" data-done>Done</button></div>`);
    d.querySelector("[data-pass]").addEventListener("click", () => { d.close(); openPassphrase(false); });
    d.querySelector("[data-code]").addEventListener("click", async () => {
      if (!(await confirmDialog("Make a new recovery code? Your old code will stop working.", "Make new code", "Cancel"))) return;
      if (!session) { d.close(); return; }
      const r = await rewrapCode(meta, session.raw);
      await writeOffline(setDoc(credMeta(), r.meta)).catch(console.error);
      d.close();
      showCode(r.code, false);
    });
    d.querySelector("[data-done]").addEventListener("click", () => d.close());
    showDialog(d);
  }

  // Leaving Credentials: stop live updates and close anything open.
  // (The unlocked key stays in memory until PocketVault locks.)
  return () => {
    stops.forEach((s) => { try { s(); } catch {} });
    stops = [];
    document.removeEventListener("pv-cred-locked", onLocked);
    [...dialogs].forEach((d) => { try { d.close(); } catch {} });
  };
}
