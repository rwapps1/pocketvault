// stocks.js — the Stocks tab inside Investments: share prices from Alpha
// Vantage (free key, 25 calls a day) with day / week / month changes.
//
// Each share's recent daily closes are saved under your login, so prices
// are fetched at most once a day per share (the first time you open the
// tab that day). You can refresh everything, or one share at a time to
// save calls. Your key is saved under your login too — never in the code.

import { col, doc, confirmDialog } from "./app.js";
import {
  onSnapshot, setDoc, updateDoc, deleteDoc, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

//   pocketvault/{you}/meta/stocks    { apiKey, usage: { day "YYYY-MM-DD", count } }
//   pocketvault/{you}/stocks/{id}    { ticker, market "LSE"|"US", unit "GBP"|"GBX"|"USD", order,
//                                      closes: [[date, close], …newest first], fetchedAt (ms), error }
const stocksMeta = () => doc("meta", "stocks");
const stocksCol = () => col("stocks");

export const DAILY_LIMIT = 25;
const GAP_MS = 1500; // pause between calls so the free plan doesn't refuse them

export const todayIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function niceDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MON[m - 1]}`;
}
export const symbolOf = (s) => (s.market === "LSE" ? `${s.ticker}.LON` : s.ticker);

// "2026-10-02" minus n days / one month, as "YYYY-MM-DD"
function shiftIso(iso, { days = 0, months = 0 }) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - months, d - days));
  if (months && dt.getUTCDate() !== d) dt.setUTCDate(0); // 31 Mar → 28/29 Feb
  return dt.toISOString().slice(0, 10);
}

// Day / week / month changes from closes (newest first). Fractions, or null.
export function changes(closes) {
  if (!closes || !closes.length) return { price: null, asOf: null, day: null, week: null, month: null };
  const [asOf, price] = closes[0];
  const onOrBefore = (iso) => (closes.find(([d]) => d <= iso) || [])[1];
  const pct = (base) => (base ? price / base - 1 : null);
  return {
    price, asOf,
    day: closes[1] ? pct(closes[1][1]) : null,
    week: pct(onOrBefore(shiftIso(asOf, { days: 7 }))),
    month: pct(onOrBefore(shiftIso(asOf, { months: 1 })))
  };
}

// One call to Alpha Vantage: recent daily closes, newest first.
export async function fetchCloses(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  let j;
  try {
    const r = await Promise.race([fetch(url), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 15000))]);
    j = await r.json();
  } catch {
    throw { kind: "network" };
  }
  const series = j && j["Time Series (Daily)"];
  if (series) {
    const closes = Object.entries(series).map(([d, v]) => [d, Number(v["4. close"])])
      .filter(([, c]) => c > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 45);
    if (closes.length) return closes;
  }
  if (j && j["Error Message"]) throw { kind: "notfound" };
  const note = String((j && (j.Note || j.Information)) || "");
  if (/api ?key/i.test(note) && /invalid|missing/i.test(note)) throw { kind: "key" };
  if (/rate limit|requests per day|premium/i.test(note)) throw { kind: "limit" };
  throw { kind: "notfound" };
}

const ERR_TEXT = {
  network: "Couldn't reach Alpha Vantage — try again later",
  notfound: "Alpha Vantage doesn't recognise this ticker",
  key: "Your Alpha Vantage key wasn't accepted",
  limit: "Today's 25 free calls are used up"
};

const fmt = {
  GBP: new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }),
  USD: new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD" })
};
export function priceText(p, unit) {
  if (p == null) return "—";
  if (unit === "GBX") return `${p.toLocaleString("en-GB", { maximumFractionDigits: 2 })}p`;
  return (fmt[unit] || fmt.GBP).format(p).replace("US$", "$");
}
const pctText = (x) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`);
const tone = (x) => (x == null ? "muted" : x > 0.00049 ? "up" : x < -0.00049 ? "down" : "muted");

export function createStocks({ pane, open, icon, onDialog }) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);

  let meta = { apiKey: "", usage: { day: "", count: 0 } };
  let shares = [];
  let loaded = { meta: false, shares: false };
  let stops = [];
  let visible = false;
  let autoDone = false;      // auto-refresh runs once per visit
  let busy = new Set();      // share ids being fetched right now
  let queue = Promise.resolve();
  let banner = "";           // last problem to show above the list
  const live = new Set();

  open.then(() => {
    stops.push(onSnapshot(stocksMeta(), (snap) => {
      meta = snap.exists() ? { apiKey: "", usage: { day: "", count: 0 }, ...snap.data() } : { apiKey: "", usage: { day: "", count: 0 } };
      loaded.meta = true; render(); maybeAuto();
    }, console.error));
    stops.push(onSnapshot(stocksCol(), (snap) => {
      shares = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s && s.ticker)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      loaded.shares = true; render(); maybeAuto();
    }, console.error));
  });

  // ---------- Calls left today ----------
  const used = () => (meta.usage && meta.usage.day === todayIso() ? meta.usage.count || 0 : 0);
  const left = () => Math.max(0, DAILY_LIMIT - used());
  function countCall(limitHit) {
    const count = limitHit ? DAILY_LIMIT : used() + 1;
    meta = { ...meta, usage: { day: todayIso(), count } };
    writeOffline(setDoc(stocksMeta(), meta)).catch(console.error);
  }

  // Fetch one share (queued, with a pause between calls). Returns true if updated.
  function refreshOne(s) {
    const run = async () => {
      if (!meta.apiKey) { banner = "Add your Alpha Vantage key first (gear button)."; render(); return false; }
      if (!left()) { banner = ERR_TEXT.limit + ". Prices will update tomorrow."; render(); return false; }
      busy.add(s.id); render();
      try {
        const closes = await fetchCloses(symbolOf(s), meta.apiKey);
        countCall(false);
        await writeOffline(updateDoc(fsDoc(stocksCol(), s.id), { closes, fetchedAt: Date.now(), error: "" }));
        return true;
      } catch (e) {
        const kind = (e && e.kind) || "network";
        if (kind !== "network") countCall(kind === "limit");
        if (kind === "notfound") writeOffline(updateDoc(fsDoc(stocksCol(), s.id), { error: "notfound" })).catch(console.error);
        banner = ERR_TEXT[kind];
        return false;
      } finally {
        busy.delete(s.id); render();
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }
  async function refreshMany(list) {
    banner = "";
    for (const s of list) {
      if (!left() || !meta.apiKey) { if (!left()) { banner = ERR_TEXT.limit + "."; render(); } break; }
      const ok = await refreshOne(s);
      if (!ok && (banner === ERR_TEXT.key || banner.startsWith(ERR_TEXT.limit) || banner === ERR_TEXT.network)) break;
    }
  }
  const fetchedToday = (s) => s.fetchedAt && todayIso(new Date(s.fetchedAt)) === todayIso();
  // First visit of the day: update the shares not yet fetched today (oldest first)
  function maybeAuto() {
    if (!visible || autoDone || !loaded.meta || !loaded.shares || !meta.apiKey) return;
    autoDone = true;
    const stale = shares.filter((s) => !fetchedToday(s) && s.error !== "notfound")
      .sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    if (stale.length) refreshMany(stale);
  }

  // ---------- Drawing ----------
  function render() {
    live.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    if (!loaded.meta || !loaded.shares) return;
    if (!meta.apiKey) {
      pane.replaceChildren(keyCard());
      return;
    }
    const asOfs = shares.map((s) => changes(s.closes).asOf).filter(Boolean).sort();
    const latest = asOfs[asOfs.length - 1];
    const fetched = shares.map((s) => s.fetchedAt || 0).sort((a, b) => b - a)[0];
    const n = left();
    const info = el(`<div class="stk-info">
        <div class="stk-info-text"><span>${latest ? `Prices as of <b>${niceDay(latest)}</b> close` : "No prices yet"}</span>
          <small>${fetched ? `Updated ${new Date(fetched).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${todayIso(new Date(fetched)) === todayIso() ? "" : " " + niceDay(todayIso(new Date(fetched)))} · ` : ""}${n} of ${DAILY_LIMIT} calls left today</small></div>
        <button type="button" class="inv-update stk-refresh" data-refresh-all${!shares.length || busy.size || !n ? " disabled" : ""}>${icon("refresh")}${busy.size ? "Updating…" : "Refresh all"}</button>
      </div>`);
    info.querySelector("[data-refresh-all]").addEventListener("click", async () => {
      if (shares.length > left()) {
        const ok = await confirmDialog(`Refreshing all ${shares.length} shares needs ${shares.length} calls, but only ${left()} are left today. The ones updated longest ago go first.`, "Refresh what I can", "Cancel");
        if (!ok) return;
      }
      refreshMany(shares.slice().sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0)));
    });
    const out = [info];
    if (banner) out.push(el(`<p class="stk-banner">${esc(banner)}</p>`));
    const list = el(`<div class="stk-list"><div class="stk-row stk-head"><span class="stk-name inv-label">Share · price</span><span class="inv-label">Day</span><span class="inv-label">Week</span><span class="inv-label">Month</span></div></div>`);
    if (!shares.length) list.appendChild(el(`<p class="act-empty">No shares yet. Tap <strong>+</strong> to add one.</p>`));
    shares.forEach((s) => {
      const c = changes(s.closes);
      const sub = busy.has(s.id) ? `<span class="brass">Updating…</span>`
        : s.error === "notfound" ? `<span class="down">Not found — tap to check</span>`
        : `${s.market === "LSE" ? "LSE" : "US"} · <span class="amt">${priceText(c.price, s.unit)}</span>`;
      const row = el(`<button type="button" class="stk-row${busy.has(s.id) ? " busy" : ""}">
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

  function keyCard() {
    const c = el(`<section class="inv-card stk-key">
        <span class="inv-label">Connect share prices</span>
        <p>Paste your free Alpha Vantage key. It's saved under your login, not in the app's code.</p>
        <form class="list-add"><input type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Alpha Vantage key" aria-label="Alpha Vantage key"><button type="submit" class="add-btn" aria-label="Save key">${icon("check")}</button></form>
      </section>`);
    c.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = c.querySelector("input").value.trim();
      if (!v) return;
      meta = { ...meta, apiKey: v };
      writeOffline(setDoc(stocksMeta(), meta)).catch(console.error);
      autoDone = false; render(); maybeAuto();
    });
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
    if (!meta.apiKey) { settings(); return; }
    const st = { market: "LSE", unit: "GBP" };
    const d = sheet("stk-sheet", "Add a share", `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Add a share</h2>
        <div class="form">
          <label class="fld"><span>Ticker</span><input name="ticker" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="e.g. VUSA or AAPL"></label>
          <div class="fld"><span>Market</span>${seg("market", [["LSE", "London (LSE)"], ["US", "US"]], st.market)}</div>
          <div class="fld" data-unit><span>Priced in</span>${seg("unit", [["GBP", "Pounds (£)"], ["GBX", "Pence (p)"]], st.unit)}</div>
          <small class="tp-hint">Adding it checks the ticker with Alpha Vantage straight away (1 call) and shows its latest price. ${left()} calls left today.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn" data-save>Add</button></div>
        </div>
      </form>`);
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    wireSeg(d, "market", (v) => { st.market = v; d.querySelector("[data-unit]").hidden = v !== "LSE"; });
    wireSeg(d, "unit", (v) => { st.unit = v; });
    f.elements.ticker.addEventListener("input", () => { err.textContent = ""; });
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const ticker = f.elements.ticker.value.trim().toUpperCase().replace(/\.(LON|L)$/, "");
      if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) { err.textContent = "Enter the ticker, e.g. VUSA."; return; }
      if (shares.some((s) => s.ticker === ticker && s.market === st.market)) { err.textContent = `${ticker} is already on your list.`; return; }
      if (!left()) { err.textContent = ERR_TEXT.limit + " — try again tomorrow."; return; }
      const btn = d.querySelector("[data-save]");
      btn.disabled = true; btn.textContent = "Checking…";
      const s = { ticker, market: st.market, unit: st.market === "US" ? "USD" : st.unit };
      try {
        const closes = await fetchCloses(symbolOf(s), meta.apiKey);
        countCall(false);
        const order = Math.max(0, ...shares.map((x) => x.order || 0)) + 1;
        await writeOffline(setDoc(fsDoc(stocksCol()), { ...s, order, closes, fetchedAt: Date.now(), error: "" }));
        d.close();
      } catch (ex) {
        const kind = (ex && ex.kind) || "network";
        if (kind !== "network") countCall(kind === "limit");
        err.textContent = kind === "notfound" ? `Alpha Vantage doesn't recognise ${ticker} on ${st.market === "LSE" ? "London" : "US"} markets — check the ticker and market.` : ERR_TEXT[kind] + ".";
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
      const c = changes(s.closes);
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <h2>${esc(s.ticker)} <small class="stk-mkt">${s.market === "LSE" ? "London" : "US"}</small></h2>
        <div class="stk-detail">
          <div><span class="inv-label">Price</span><b class="amt">${priceText(c.price, s.unit)}</b><small>${c.asOf ? `${niceDay(c.asOf)} close` : "not fetched yet"}</small></div>
          <div><span class="inv-label">Day</span><b class="${tone(c.day)}">${pctText(c.day)}</b></div>
          <div><span class="inv-label">Week</span><b class="${tone(c.week)}">${pctText(c.week)}</b></div>
          <div><span class="inv-label">Month</span><b class="${tone(c.month)}">${pctText(c.month)}</b></div>
        </div>
        ${s.error === "notfound" ? `<p class="stk-banner">${ERR_TEXT.notfound}. Check the ticker and market, or remove it.</p>` : ""}
        <small class="tp-hint">${s.fetchedAt ? `Last updated ${new Date(s.fetchedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}. ` : ""}${left()} of ${DAILY_LIMIT} calls left today.</small>
        ${s.market === "LSE" ? `<div class="fld stk-unit"><span>Priced in</span>${seg("unit", [["GBP", "Pounds (£)"], ["GBX", "Pence (p)"]], s.unit || "GBP")}</div>` : ""}
        <div class="sheet-buttons">
          <button type="button" class="btn-ghost danger" data-remove>Remove</button>
          <button type="button" class="btn" data-refresh${busy.has(s.id) || !left() ? " disabled" : ""}>${busy.has(s.id) ? "Updating…" : "Refresh"}</button>
        </div>`;
      if (s.market === "LSE") wireSeg(d, "unit", (v) => { writeOffline(updateDoc(fsDoc(stocksCol(), s.id), { unit: v })).catch(console.error); });
      d.querySelector("[data-refresh]").addEventListener("click", () => { banner = ""; refreshOne(s); });
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
          <label class="fld"><span>Alpha Vantage key</span><input name="key" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
          <small class="tp-hint">Free key from alphavantage.co — 25 calls a day, one call per share. Saved under your login, not in the app's code. ${left()} calls left today.</small>
          <div class="sheet-buttons"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn">Save</button></div>
        </div>
      </form>`);
    const f = d.querySelector("form");
    f.elements.key.value = meta.apiKey || "";
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      meta = { ...meta, apiKey: f.elements.key.value.trim() };
      writeOffline(setDoc(stocksMeta(), meta)).catch(console.error);
      banner = ""; autoDone = false; render(); maybeAuto();
      d.close();
    });
    d.showModal();
  }

  return {
    show(on) { visible = on; if (on) { render(); maybeAuto(); } },
    add, settings,
    stop() { stops.forEach((s) => { try { s(); } catch {} }); stops = []; }
  };
}
