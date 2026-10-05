// stocks.js — the Stocks tab inside Investments: share prices with day /
// week / month changes.
//
// Prices come from Google Finance through a small script in your own
// Google account (a Google Sheet + Apps Script "web app"). PocketVault
// sends it the tickers and gets back prices and recent daily closes — no
// key, no daily limit, prices about 20 minutes delayed. The script's
// address and secret are saved under your login, never in the code.
// The last prices are kept, so the tab still shows them without signal.

import { col, doc, confirmDialog } from "./app.js";
import {
  onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./app.js";

//   pocketvault/{you}/meta/stocks    { scriptUrl, secret }
//   pocketvault/{you}/stocks/{id}    { ticker, market "LSE"|"US", order,
//                                      price, changepct, currency, name,
//                                      closes: [{ d: date, c: close }, …newest first], fetchedAt (ms), error }
// (Firestore can't store arrays inside arrays, so each close is a small object.)
const stocksMeta = () => doc("meta", "stocks");
const stocksCol = () => col("stocks");
const AUTO_GAP_MS = 2 * 60 * 1000; // don't re-fetch on every tap if you just did

export const todayIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const symbolOf = (s) => (s.market === "LSE" ? `LON:${s.ticker}` : s.ticker);

function shiftIso(iso, { days = 0, months = 0 }) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - months, d - days));
  if (months && dt.getUTCDate() !== d) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

// Day / week / month changes as fractions (0.012 = +1.2%), or null.
// Day uses Google's own change since yesterday's close; week and month
// compare today's price with the close a week / a month ago.
const toStore = (closes) => (closes || []).slice(0, 45).map(([d, c]) => ({ d, c }));
const fromStore = (closes) => (closes || []).map((x) => (Array.isArray(x) ? x : [x.d, x.c])).filter(([d, c]) => d && typeof c === "number");

export function changes(s) {
  const closes = fromStore(s.closes);
  const price = typeof s.price === "number" ? s.price : closes.length ? closes[0][1] : null;
  if (price == null) return { price: null, day: null, week: null, month: null };
  const ref = s.fetchedAt ? todayIso(new Date(s.fetchedAt)) : (closes[0] || [])[0];
  const onOrBefore = (iso) => (closes.find(([d]) => d <= iso) || [])[1];
  const pct = (base) => (base ? price / base - 1 : null);
  let day = typeof s.changepct === "number" ? s.changepct / 100 : null;
  if (day == null) { const prev = closes.find(([d]) => d < ref); day = prev ? pct(prev[1]) : null; }
  return {
    price, day,
    week: ref ? pct(onOrBefore(shiftIso(ref, { days: 7 }))) : null,
    month: ref ? pct(onOrBefore(shiftIso(ref, { months: 1 }))) : null
  };
}

// Ask your price script for some tickers. Returns { SYMBOL: {...} }.
export async function fetchPrices(symbols, { scriptUrl, secret }) {
  const url = `${scriptUrl}${scriptUrl.includes("?") ? "&" : "?"}k=${encodeURIComponent(secret || "")}&s=${encodeURIComponent(symbols.join(","))}`;
  let j;
  try {
    const r = await Promise.race([fetch(url, { redirect: "follow" }), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 40000))]);
    j = await r.json();
  } catch {
    throw { kind: "network" };
  }
  if (!j || !j.ok) throw { kind: j && j.error === "secret" ? "secret" : "script" };
  return j.data || {};
}

const ERR_TEXT = {
  network: "Couldn't reach your price script — check the signal, or the script address in settings (gear)",
  secret: "The price script didn't accept the secret — check it in settings (gear)",
  script: "The price script returned an error — try again in a minute",
  save: "Got the prices but couldn't save them — try again",
  notfound: "Google Finance doesn't recognise this ticker"
};

const fmt = {
  GBP: new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }),
  USD: new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD" }),
  EUR: new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" })
};
export function priceText(p, currency, market) {
  if (p == null) return "—";
  const cur = currency || (market === "US" ? "USD" : "GBP");
  if (cur === "GBX") return `${p.toLocaleString("en-GB", { maximumFractionDigits: 2 })}p`;
  if (fmt[cur]) return fmt[cur].format(p).replace("US$", "$");
  return `${p.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${cur}`;
}
const pctText = (x) => (x == null ? "—" : `${x > 0.00049 ? "+" : x < -0.00049 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`);
const tone = (x) => (x == null ? "muted" : x > 0.00049 ? "up" : x < -0.00049 ? "down" : "muted");
const timeText = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const DAYW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const whenText = (ms) => (todayIso(new Date(ms)) === todayIso() ? timeText(ms) : `${DAYW[new Date(ms).getDay()]} ${timeText(ms)}`);

export function createStocks({ pane, open, icon, onDialog }) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);

  let meta = { scriptUrl: "", secret: "" };
  let shares = [];
  let loaded = { meta: false, shares: false };
  let stops = [];
  let visible = false;
  let autoDone = false;
  let busy = false;
  let banner = "";
  const live = new Set();
  const ready = () => !!(meta.scriptUrl && meta.secret);

  open.then(() => {
    stops.push(onSnapshot(stocksMeta(), (snap) => {
      meta = { scriptUrl: "", secret: "", ...(snap.exists() ? snap.data() : {}) };
      loaded.meta = true; render(); maybeAuto();
    }, console.error));
    stops.push(onSnapshot(stocksCol(), (snap) => {
      shares = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s && s.ticker)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      loaded.shares = true; render(); maybeAuto();
    }, console.error));
  });

  // ---------- Fetching (all shares in one request) ----------
  async function refreshAll() {
    if (busy || !ready() || !shares.length) return;
    busy = true; banner = ""; render();
    try {
      const data = await fetchPrices(shares.map(symbolOf), meta);
      try {
        const batch = writeBatch(db);
        const now = Date.now();
        shares.forEach((s) => {
          const r = data[symbolOf(s)];
          if (!r) return;
          if (r.error) batch.update(fsDoc(stocksCol(), s.id), { error: "notfound" });
          else batch.update(fsDoc(stocksCol(), s.id), {
            price: r.price, changepct: r.changepct, currency: r.currency || "", name: r.name || "",
            closes: toStore(r.closes), fetchedAt: now, error: ""
          });
        });
        await writeOffline(batch.commit());
      } catch (we) { console.error(we); throw { kind: "save" }; }
    } catch (e) {
      banner = ERR_TEXT[(e && e.kind) || "network"];
    } finally {
      busy = false; render();
    }
  }
  // Each time the tab is shown: refresh, unless that happened a moment ago
  function maybeAuto() {
    if (!visible || autoDone || !loaded.meta || !loaded.shares || !ready()) return;
    autoDone = true;
    const last = Math.max(0, ...shares.map((s) => s.fetchedAt || 0));
    if (shares.length && Date.now() - last > AUTO_GAP_MS) refreshAll();
  }

  // ---------- Drawing ----------
  function render() {
    live.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    if (!loaded.meta || !loaded.shares) return;
    if (!ready()) { pane.replaceChildren(setupCard()); return; }
    const fetched = Math.max(0, ...shares.map((s) => s.fetchedAt || 0));
    const info = el(`<div class="stk-info">
        <div class="stk-info-text"><span>${fetched ? `Prices at <b>${whenText(fetched)}</b>` : "No prices yet"}</span>
          <small>From Google Finance · about 20 min delayed</small></div>
        <button type="button" class="inv-update stk-refresh" data-refresh-all${!shares.length || busy ? " disabled" : ""}>${icon("refresh")}${busy ? "Updating…" : "Refresh"}</button>
      </div>`);
    info.querySelector("[data-refresh-all]").addEventListener("click", refreshAll);
    const out = [info];
    if (banner) out.push(el(`<p class="stk-banner">${esc(banner)}</p>`));
    const list = el(`<div class="stk-list"><div class="stk-row stk-head"><span class="stk-name inv-label">Share · price</span><span class="inv-label">Day</span><span class="inv-label">Week</span><span class="inv-label">Month</span></div></div>`);
    if (!shares.length) list.appendChild(el(`<p class="act-empty">No shares yet. Tap <strong>+</strong> to add one.</p>`));
    shares.forEach((s) => {
      const c = changes(s);
      const sub = s.error === "notfound" ? `<span class="down">Not found — tap to check</span>`
        : `${s.market === "LSE" ? "LSE" : "US"} · <span class="amt">${priceText(c.price, s.currency, s.market)}</span>`;
      const row = el(`<button type="button" class="stk-row${busy ? " busy" : ""}">
          <span class="stk-name"><b>${esc(s.ticker)}</b><small>${sub}</small></span>
          <span class="stk-pct ${tone(c.day)}">${pctText(c.day)}</span>
          <span class="stk-pct ${tone(c.week)}">${pctText(c.week)}</span>
          <span class="stk-pct ${tone(c.month)}">${pctText(c.month)}</span>
        </button>`);
      row.setAttribute("aria-label", `${s.ticker}: day ${pctText(c.day)}, week ${pctText(c.week)}, month ${pctText(c.month)}. Open`);
      row.addEventListener("click", () => openShare(s.id));
      list.appendChild(row);
    });
    out.push(list);
    pane.replaceChildren(...out);
  }

  function setupCard() {
    const c = el(`<section class="inv-card stk-key">
        <span class="inv-label">Connect share prices</span>
        <p>Set up your free Google price script (see the steps I sent you), then paste its web app address and secret here. They're saved under your login, not in the app's code.</p>
        <div class="sheet-buttons"><button type="button" class="btn" data-setup>Enter script details</button></div>
      </section>`);
    c.querySelector("[data-setup]").addEventListener("click", settings);
    return c;
  }

  // ---------- Sheets ----------
  function sheet(cls, title, html) {
    const d = document.createElement("dialog");
    d.className = "sheet " + cls;
    d.setAttribute("aria-label", title);
    d.innerHTML = html;
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    onDialog(d);
    return d;
  }
  const seg = (name, items, cur) => `<div class="segmented" role="group" data-seg="${name}">${items.map(([v, l]) =>
    `<button type="button" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join("")}</div>`;
  const wireSeg = (d, name, fn) => d.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => {
    d.querySelectorAll(`[data-seg="${name}"] button`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    fn(b.dataset.v);
  }));

  function add() {
    if (!loaded.meta) return;
    if (!ready()) { settings(); return; }
    const st = { market: "LSE" };
    const d = sheet("stk-sheet", "Add a share", `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Add a share</h2>
        <div class="form">
          <label class="fld"><span>Ticker</span><input name="ticker" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="e.g. VUSA or AAPL"></label>
          <div class="fld"><span>Market</span>${seg("market", [["LSE", "London (LSE)"], ["US", "US"]], st.market)}</div>
          <small class="tp-hint">Adding it checks the ticker with Google Finance straight away and shows its name and price.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn" data-save>Add</button></div>
        </div>
      </form>`);
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    wireSeg(d, "market", (v) => { st.market = v; err.textContent = ""; });
    f.elements.ticker.addEventListener("input", () => { err.textContent = ""; });
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const ticker = f.elements.ticker.value.trim().toUpperCase().replace(/^(LON|LSE|NASDAQ|NYSE):/, "").replace(/\.(LON|L)$/, "");
      if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) { err.textContent = "Enter the ticker, e.g. VUSA."; return; }
      if (shares.some((s) => s.ticker === ticker && s.market === st.market)) { err.textContent = `${ticker} is already on your list.`; return; }
      const btn = d.querySelector("[data-save]");
      btn.disabled = true; btn.textContent = "Checking…";
      const s = { ticker, market: st.market };
      try {
        const r = (await fetchPrices([symbolOf(s)], meta))[symbolOf(s)];
        if (!r || r.error) throw { kind: "notfound" };
        const order = Math.max(0, ...shares.map((x) => x.order || 0)) + 1;
        try {
          await writeOffline(setDoc(fsDoc(stocksCol()), {
            ...s, order, price: r.price, changepct: r.changepct, currency: r.currency || "", name: r.name || "",
            closes: toStore(r.closes), fetchedAt: Date.now(), error: ""
          }));
        } catch (we) { console.error(we); throw { kind: "save" }; }
        d.close();
      } catch (ex) {
        const kind = (ex && ex.kind) || "network";
        err.textContent = kind === "notfound"
          ? `Google Finance doesn't recognise ${ticker} on ${st.market === "LSE" ? "London" : "US"} markets — check the ticker and market.`
          : ERR_TEXT[kind] + ".";
        btn.disabled = false; btn.textContent = "Add";
      }
    });
    d.showModal();
    setTimeout(() => f.elements.ticker.focus(), 50);
  }

  function openShare(id) {
    const d = sheet("stk-sheet", "Share", "");
    const draw = () => {
      const s = shares.find((x) => x.id === id);
      if (!s) { d.close(); return; }
      const c = changes(s);
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <h2>${esc(s.ticker)} <small class="stk-mkt">${s.market === "LSE" ? "London" : "US"}</small></h2>
        ${s.name ? `<p class="payer-sub">${esc(s.name)}</p>` : ""}
        <div class="stk-detail">
          <div><span class="inv-label">Price</span><b class="amt">${priceText(c.price, s.currency, s.market)}</b><small>${s.fetchedAt ? `at ${whenText(s.fetchedAt)}` : "not fetched yet"}</small></div>
          <div><span class="inv-label">Day</span><b class="${tone(c.day)}">${pctText(c.day)}</b></div>
          <div><span class="inv-label">Week</span><b class="${tone(c.week)}">${pctText(c.week)}</b></div>
          <div><span class="inv-label">Month</span><b class="${tone(c.month)}">${pctText(c.month)}</b></div>
        </div>
        ${s.error === "notfound" ? `<p class="stk-banner">${ERR_TEXT.notfound}. Check the ticker and market, or remove it.</p>` : ""}
        <div class="sheet-buttons">
          <button type="button" class="btn-ghost danger" data-remove>Remove</button>
          <button type="button" class="btn-ghost" data-done>Done</button>
        </div>`;
      d.querySelector("[data-done]").addEventListener("click", () => d.close());
      d.querySelector("[data-remove]").addEventListener("click", async () => {
        if (!(await confirmDialog(`Remove ${s.ticker} from your list?`, "Remove", "Keep"))) return;
        deleteDoc(fsDoc(stocksCol(), s.id)).catch(console.error);
        d.close();
      });
    };
    draw();
    live.add(draw);
    d.addEventListener("close", () => live.delete(draw));
    d.showModal();
  }

  function settings() {
    const d = sheet("stk-sheet", "Share price settings", `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Share prices</h2>
        <div class="form">
          <label class="fld"><span>Price script web app address</span><input name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"></label>
          <label class="fld"><span>Secret</span><input name="secret" type="text" autocomplete="off" spellcheck="false"></label>
          <small class="tp-hint">From your Google price script. Saved under your login, not in the app's code.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn" data-save>Save</button></div>
        </div>
      </form>`);
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    f.elements.url.value = meta.scriptUrl || "";
    f.elements.secret.value = meta.secret || "";
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const scriptUrl = f.elements.url.value.trim(), secret = f.elements.secret.value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(scriptUrl)) { err.textContent = "Paste the web app address — it starts https://script.google.com/"; return; }
      if (!secret) { err.textContent = "Enter the secret from the script."; return; }
      // Check it works before saving
      const btn = d.querySelector("[data-save]");
      btn.disabled = true; btn.textContent = "Checking…";
      try {
        await fetchPrices([], { scriptUrl, secret });
      } catch (ex) {
        err.textContent = ERR_TEXT[(ex && ex.kind) || "network"] + ".";
        btn.disabled = false; btn.textContent = "Save";
        return;
      }
      meta = { ...meta, scriptUrl, secret };
      writeOffline(setDoc(stocksMeta(), meta)).catch(console.error);
      banner = ""; autoDone = false; render(); maybeAuto();
      d.close();
    });
    d.showModal();
  }

  return {
    show(on) { visible = on; if (on) { autoDone = false; render(); maybeAuto(); } },
    add, settings,
    stop() { stops.forEach((s) => { try { s(); } catch {} }); stops = []; }
  };
}
