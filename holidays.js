// holidays.js — the Holidays mini app
//
// Each holiday has a location, dates, who's going and who pays for whom.
// Costs (taxis, flights, transfer, hotel, local tax, other) are made of
// payments — e.g. a deposit and a balance — each marked paid, due by a
// date, or paid on arrival, and split between the payers. You tick each
// payer's share when they've paid you. Updates live and works offline.

import { confirmDialog } from "./app.js";
import {
  onSnapshot, setDoc, deleteDoc, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  holMeta, holCol, newId, COST_TYPES, typeName, PAYMENT_LABELS,
  todayIso, niceDate, tripDates, tripPhase, daysToGo,
  money, pounds0, SYMBOL, parseMoney, moneyInput, toGBP,
  payersOf, sharesOf, tripTotals, nextPayment, sortTrips
} from "./holidays-data.js";

export function mount(root, { open }) {
  const $ = (sel) => root.querySelector(sel);
  const icon = (n) => window.PV.icon(n);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  let meta = { people: [], rates: {} };
  let trips = [];
  let loaded = { meta: false, trips: false };
  let stops = [];
  const dialogs = new Set();
  const live = new Set();
  let tab = "upcoming";
  try { if (sessionStorage.getItem("pv-hol-tab") === "past") tab = "past"; } catch {}

  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);
  const saveMeta = (m) => writeOffline(setDoc(holMeta(), m)).catch(console.error);
  const saveTrip = (t) => { const { id, ...data } = t; return writeOffline(setDoc(fsDoc(holCol(), id), data)).catch(console.error); };
  const tripById = (id) => trips.find((t) => t.id === id);
  const personName = (id) => ((meta.people || []).find((p) => p.id === id) || {}).name || "Someone";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // "for Rob & Emma", "for Dad", "own share"
  function forText(payer) {
    const self = payer.for.includes(payer.id);
    const others = payer.for.filter((id) => id !== payer.id).map(personName);
    if (!others.length) return "own share";
    const all = self ? [...others, personName(payer.id)] : others; // payer's own name last: "for Rob & Emma"
    return "for " + (all.length === 1 ? all[0] : all.slice(0, -1).join(", ") + " & " + all[all.length - 1]);
  }

  open.then(() => {
    stops.push(onSnapshot(holMeta(), (snap) => {
      meta = snap.exists() ? { people: [], rates: {}, ...snap.data() } : { people: [], rates: {} };
      loaded.meta = true; render();
    }, showError));
    stops.push(onSnapshot(holCol(), (snap) => {
      trips = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t && t.location);
      loaded.trips = true; render();
    }, showError));
  });
  function showError(e) {
    console.error(e);
    $("[data-list]").innerHTML = `<p class="bills-loading">Couldn't load your holidays.</p>`;
  }

  // ---------- Header & tabs ----------
  root.querySelectorAll(".inv-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.tab;
    try { sessionStorage.setItem("pv-hol-tab", tab); } catch {}
    render();
  }));
  $("[data-hol-add]").addEventListener("click", () => loaded.meta && editTrip(null));
  $("[data-hol-people]").addEventListener("click", () => loaded.meta && openPeople());

  // ---------- Main list ----------
  function bar(label, done, total, cls = "") {
    const w = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    return `<div class="hol-bar ${cls}"><div class="hb-top"><span class="inv-label">${label}</span><span class="hb-fig"><b class="amt">${pounds0(done)}</b> of <span class="amt">${pounds0(total)}</span></span></div>
      <div class="hb-track"><i style="width:${w.toFixed(1)}%"></i></div></div>`;
  }
  function countdown(t) {
    const phase = tripPhase(t);
    if (phase === "past") return "";
    if (phase === "now") return `<div class="hol-count"><b>Away</b><small>now</small></div>`;
    const n = daysToGo(t);
    return n === 0 ? `<div class="hol-count"><b>Today</b><small>have fun</small></div>`
      : `<div class="hol-count"><b>${n}</b><small>day${n === 1 ? "" : "s"} to go</small></div>`;
  }
  function nextLine(t) {
    const n = nextPayment(t);
    if (!n) return (t.costs || []).length ? `<span class="hol-next-done">${icon("check")}Everything paid to suppliers</span>` : `<span class="muted">No costs added yet</span>`;
    const when = n.pay.status === "arrival" ? "on arrival" : n.pay.date ? `due ${niceDate(n.pay.date)}` : "due";
    return `<span>${esc(typeName(n.cost))}${/full/i.test(n.pay.label) ? "" : " " + esc(n.pay.label.toLowerCase())} <span class="amt">${money(n.pay.amount, n.pay.currency)}</span> · ${when}</span>`;
  }

  function render() {
    if (!loaded.meta || !loaded.trips) return;
    const { upcoming, past } = sortTrips(trips);
    root.querySelectorAll(".inv-tabs [data-tab]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
      const n = b.dataset.tab === "past" ? past.length : upcoming.length;
      b.textContent = `${b.dataset.tab === "past" ? "Past" : "Upcoming"}${n ? " · " + n : ""}`;
    });
    const list = $("[data-list]");
    const shown = tab === "past" ? past : upcoming;
    if (!shown.length) {
      list.innerHTML = tab === "past"
        ? `<p class="act-empty hol-empty">Holidays move here once you're back.</p>`
        : `<section class="plate empty-state"><span class="box-glyph">${icon("holidays")}</span><h2>No holidays yet</h2>
           <p>${(meta.people || []).length ? "Tap <strong>+</strong> to add your next trip." : "Start by adding the people you go away with (the gear button), then tap <strong>+</strong> to add a trip."}</p></section>`;
    } else {
      list.replaceChildren(...shown.map(tripCard));
    }
    live.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  function tripCard(t) {
    const tot = tripTotals(t);
    const phase = tripPhase(t);
    const card = el(`<button type="button" class="hol-card${phase === "past" ? " past" : ""}">
        <div class="hol-top">
          <div class="hol-title"><span class="hol-loc">${esc(t.location)}</span><span class="hol-dates">${tripDates(t)}</span></div>
          ${countdown(t)}
        </div>
        <div class="hol-chips">${(t.travellers || []).map((x) => `<span class="chip">${esc(personName(x.personId))}</span>`).join("")}</div>
        ${tot.total ? bar("Received from payers", tot.received, tot.total, "in") + bar("Paid to suppliers", tot.supplier, tot.total) : ""}
        <div class="hol-next"><span class="inv-label brass">Next</span>${nextLine(t)}</div>
      </button>`);
    if (phase === "past") card.querySelector(".hol-next").remove();
    card.setAttribute("aria-label", `${t.location}, ${tripDates(t)}. Open`);
    card.addEventListener("click", () => openTrip(t.id));
    return card;
  }

  // =====================================================================
  // Shared: dialogs
  // =====================================================================
  function showDialog(d, redraw) {
    document.body.appendChild(d);
    dialogs.add(d);
    if (redraw) live.add(redraw);
    d.addEventListener("close", () => { d.remove(); dialogs.delete(d); if (redraw) live.delete(redraw); });
    d.showModal();
    requestAnimationFrame(() => { const a = d.querySelector(":focus"); if (a && a.matches("input, select, textarea")) a.blur(); });
  }
  function sheetShell(cls, title) {
    const d = document.createElement("dialog");
    d.className = "sheet " + cls;
    d.setAttribute("aria-label", title);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    return d;
  }
  function segButtons(name, items, current) {
    return `<div class="segmented" role="group" data-seg="${name}">${items.map(([v, label]) =>
      `<button type="button" data-v="${esc(v)}" aria-pressed="${v === current}">${esc(label)}</button>`).join("")}</div>`;
  }
  function wireSeg(d, name, onPick) {
    d.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => {
      d.querySelectorAll(`[data-seg="${name}"] button`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(b.dataset.v);
    }));
  }
  const toggleHtml = (on, label) =>
    `<button type="button" class="paid-toggle rcv" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${esc(label)}"><span></span></button>`;

  // Today's euro rate (free service, no sign-up). Falls back quietly.
  async function fetchRate() {
    const urls = ["https://api.frankfurter.app/latest?from=EUR&to=GBP", "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=GBP"];
    for (const u of urls) {
      try {
        const r = await Promise.race([fetch(u), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 5000))]);
        if (!r.ok) continue;
        const j = await r.json();
        const v = j && j.rates && Number(j.rates.GBP);
        if (v > 0) {
          saveMeta({ ...meta, rates: { ...(meta.rates || {}), EUR: v, EURdate: j.date || todayIso() } });
          return v;
        }
      } catch {}
    }
    return null;
  }
  // Rate field: "€1 = £ [0.8346] [Today's rate]"
  function rateHtml(rate) {
    return `<div class="rate-line"><span>€1 =</span><span class="money"><i>£</i><input name="rate" type="text" inputmode="decimal" autocomplete="off" value="${rate ? rate : ""}" placeholder="0.00" aria-label="Exchange rate"></span>
      <button type="button" class="inv-update" data-fetch-rate>Today's rate</button></div>`;
  }
  function wireRate(d, onChange) {
    const btn = d.querySelector("[data-fetch-rate]");
    const input = d.querySelector('[name="rate"]');
    input.addEventListener("input", onChange);
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Getting…";
      const v = await fetchRate();
      btn.disabled = false;
      if (v) { input.value = v.toFixed(4); btn.textContent = "Today's rate"; onChange(); }
      else btn.textContent = "No signal — type it";
    });
  }
  const readRate = (d) => { const v = parseFloat(String(d.querySelector('[name="rate"]').value).replace(/[£,\s]/g, "")); return v > 0 ? Math.round(v * 10000) / 10000 : null; };

  // =====================================================================
  // Trip panel (full screen; the phone's back button closes it)
  // =====================================================================
  function panelShell(title, buttons) {
    const d = document.createElement("dialog");
    d.className = "panel";
    d.setAttribute("aria-label", title);
    const hidden = document.documentElement.classList.contains("pv-hide");
    d.innerHTML = `<div class="panel-inner">
        <header class="subbar">
          <button type="button" class="square-btn" data-close aria-label="Back">${icon("back")}</button>
          <h1></h1>
          <button class="square-btn eye-btn" type="button" data-eye aria-pressed="${hidden}" aria-label="${hidden ? "Show" : "Hide"} amounts">${icon(hidden ? "eyeOff" : "eye")}</button>
          ${buttons}
        </header>
        <div class="panel-body"></div>
      </div>`;
    d.querySelector("h1").textContent = title;
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    return d;
  }

  function openTrip(tripId) {
    const t0 = tripById(tripId);
    if (!t0) return;
    const d = panelShell(t0.location, `<button class="square-btn" type="button" data-edit aria-label="Edit holiday">${icon("pen")}</button>
      <button class="square-btn add-btn-head" type="button" data-add aria-label="Add a cost">${icon("plus")}</button>`);
    d.querySelector("[data-edit]").addEventListener("click", () => editTrip(tripById(tripId)));
    d.querySelector("[data-add]").addEventListener("click", () => addCost(tripId));
    const body = d.querySelector(".panel-body");
    const draw = () => {
      const t = tripById(tripId);
      if (!t) { d.close(); return; }
      d.querySelector("h1").textContent = t.location;
      const tot = tripTotals(t);
      const arr = Object.entries(tot.arrival).filter(([, v]) => v).map(([c, v]) => money(v, c)).join(" + ");
      const n = (t.travellers || []).length;
      const card = el(`<section class="inv-card hol-sum">
          <div class="hol-top">
            <div class="inv-headline"><span class="inv-label">Total cost</span><span class="inv-big amt">${tot.total ? (hasEuro(t) ? "≈ " : "") + pounds0(tot.total) : "£0"}</span>
            <small class="inv-asof">${tripDates(t)} · ${n} traveller${n === 1 ? "" : "s"}</small></div>
            ${countdown(t)}
          </div>
          ${tot.total ? bar("Received from payers", tot.received, tot.total, "in") + bar("Paid to suppliers", tot.supplier, tot.total) : ""}
          ${arr ? `<small class="inv-asof">To pay on arrival: <span class="amt">${arr}</span>${hasEuroArrival(tot) ? ` <span class="amt">(≈ ${pounds0(tot.arrivalGBP)})</span>` : ""}</small>` : ""}
        </section>`);
      // Who's paying
      const who = el(`<div class="inv-list"><div class="act-head"><span class="inv-label">Who's paying</span><span class="act-hint">Tap to tick off</span></div></div>`);
      const payers = payersOf(t);
      if (!payers.length) who.appendChild(el(`<p class="act-empty">Nobody's going yet — tap the pen to add travellers.</p>`));
      payers.forEach((p) => {
        const b = tot.byPayer[p.id] || { total: 0, received: 0 };
        const left = b.total - b.received;
        const row = el(`<button type="button" class="pot-row">
            <span class="pr-text"><b>${esc(personName(p.id))}</b><small>${esc(forText(p))}</small></span>
            <span class="pr-fig"><b class="amt">${pounds0(b.total)}</b><small>${left > 0 ? `<span class="up amt">${pounds0(b.received)} in</span> · <span class="brass amt">${pounds0(left)} to come</span>` : b.total ? `<span class="up">All paid ✓</span>` : ""}</small></span>
          </button>`);
        row.addEventListener("click", () => openPayer(tripId, p.id));
        who.appendChild(row);
      });
      // Costs
      const costs = el(`<div class="hol-costs"><div class="act-head"><span class="inv-label">Costs</span>${(t.costs || []).length ? `<span class="act-hint">Tap a payment to edit</span>` : ""}</div></div>`);
      (t.costs || []).forEach((c) => costs.appendChild(costBlock(t, c)));
      const addBtn = el(`<button type="button" class="btn-dashed hol-add-cost">+ Add a cost</button>`);
      addBtn.addEventListener("click", () => addCost(tripId));
      costs.appendChild(addBtn);
      body.replaceChildren(card, who, costs);
    };
    draw();
    showDialog(d, draw);
  }
  const hasEuro = (t) => (t.costs || []).some((c) => (c.payments || []).some((p) => p.currency === "EUR"));
  const hasEuroArrival = (tot) => !!tot.arrival.EUR;

  function costBlock(t, c) {
    const pays = c.payments || [];
    const cur = pays.length && pays.every((p) => p.currency === pays[0].currency) ? pays[0].currency : null;
    const total = pays.reduce((s, p) => s + (p.amount || 0), 0);
    const gbp = pays.reduce((s, p) => s + toGBP(p.amount || 0, p), 0);
    const b = el(`<section class="hol-cost">
        <button type="button" class="hc-head">
          <span class="hc-name">${esc(typeName(c))}</span>
          <span class="hc-fig"><b class="amt">${cur ? money(total, cur) : pounds0(gbp)}</b>${cur === "EUR" ? `<small class="amt">≈ ${pounds0(gbp)}</small>` : ""}</span>
        </button>
      </section>`);
    b.querySelector(".hc-head").addEventListener("click", () => editCost(t.id, c.id));
    const payers = payersOf(t);
    pays.forEach((p) => {
      const shares = sharesOf(t, p);
      const owed = Object.entries(shares).filter(([, v]) => v);
      const inCount = owed.filter(([id]) => (p.received || {})[id]).length;
      const when = p.status === "paid" ? (p.date ? `Paid ${niceDate(p.date)}` : "Paid")
        : p.status === "due" ? (p.date ? `Due ${niceDate(p.date)}` : "Due") : "On arrival";
      const split = p.split === "payer" ? "split per payer" : p.split === "custom" ? "custom split" : "split per person";
      const sup = p.status === "paid" ? `<span class="st ok">✓ Supplier</span>` : p.status === "arrival" ? `<span class="st">On arrival</span>` : `<span class="st due">Due</span>`;
      const rec = owed.length ? `<span class="st ${inCount === owed.length ? "ok" : "due"}">${inCount === owed.length ? "✓ " : ""}${inCount}/${owed.length} in</span>` : "";
      const row = el(`<button type="button" class="hc-pay">
          <span class="pr-text"><b>${esc(p.label)}</b><small>${when} · ${split}${payers.length ? "" : " · nobody going yet"}</small></span>
          <span class="pr-fig"><b class="amt">${money(p.amount, p.currency)}</b><small class="hc-st">${sup}${rec}</small></span>
        </button>`);
      row.addEventListener("click", () => openPayment(t.id, c.id, p.id));
      b.appendChild(row);
    });
    const add = el(`<button type="button" class="hc-add">+ Add a payment</button>`);
    add.addEventListener("click", () => openPayment(t.id, c.id, null));
    b.appendChild(add);
    return b;
  }

  // =====================================================================
  // Add / edit a holiday
  // =====================================================================
  function editTrip(trip) {
    const editing = !!trip;
    const st = {
      going: new Map((trip ? trip.travellers : []).map((x) => [x.personId, x.payerId]))
    };
    const d = sheetShell("hol-trip-sheet", editing ? "Edit holiday" : "Add a holiday");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${editing ? "Edit holiday" : "Add a holiday"}</h2>
        <div class="form">
          <label class="fld"><span>Location</span><input name="location" type="text" autocomplete="off" maxlength="40" placeholder="e.g. Majorca"></label>
          <div class="two">
            <label class="fld"><span>Going</span><input name="start" type="date"></label>
            <label class="fld"><span>Back</span><input name="end" type="date"></label>
          </div>
          <div class="act-head"><span class="inv-label">Who's going</span><button type="button" class="link-btn" data-add-person>+ Add a person</button></div>
          <div class="trav-rows"></div>
          <small class="tp-hint" data-payers></small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${editing ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    if (trip) { f.elements.location.value = trip.location; f.elements.start.value = trip.start || ""; f.elements.end.value = trip.end || ""; }
    const rowsEl = d.querySelector(".trav-rows");
    const drawRows = () => {
      const people = meta.people || [];
      if (!people.length) { rowsEl.innerHTML = `<p class="act-empty">Add the people who go away with you — including yourself.</p>`; }
      else rowsEl.replaceChildren(...people.map((p) => {
        const on = st.going.has(p.id);
        const r = el(`<div class="trav-row${on ? " on" : ""}">
            <label class="trav-check"><input type="checkbox"${on ? " checked" : ""}><span class="tbox">${icon("check")}</span><span class="nm">${esc(p.name)}</span></label>
            ${on ? `<span class="trav-by"><small>paid by</small><span class="sel"><select aria-label="Who pays for ${esc(p.name)}">${people.map((q) => `<option value="${q.id}"${q.id === st.going.get(p.id) ? " selected" : ""}>${esc(q.name)}</option>`).join("")}</select>${icon("chevron")}</span></span>`
              : `<span class="trav-by off">not going</span>`}
          </div>`);
        r.querySelector("input").addEventListener("change", (e) => {
          if (e.target.checked) st.going.set(p.id, p.id); else st.going.delete(p.id);
          drawRows();
        });
        const s = r.querySelector("select");
        if (s) s.addEventListener("change", () => { st.going.set(p.id, s.value); drawPayers(); });
        return r;
      }));
      drawPayers();
    };
    const drawPayers = () => {
      const t = { travellers: orderedTravellers() };
      const ps = payersOf(t);
      d.querySelector("[data-payers]").textContent = ps.length
        ? `${ps.length} payer${ps.length > 1 ? "s" : ""}: ${ps.map((p) => `${personName(p.id)}${forText(p) === "own share" ? "" : ` (${forText(p)})`}`).join(", ")}` : "";
    };
    // Travellers in the order of your people list
    const orderedTravellers = () => (meta.people || []).filter((p) => st.going.has(p.id)).map((p) => ({ personId: p.id, payerId: st.going.get(p.id) }));
    drawRows();
    const redraw = () => { if (!d.contains(document.activeElement) || !document.activeElement.matches("input[type=text], input[type=date]")) drawRows(); };
    d.querySelector("[data-add-person]").addEventListener("click", () => addPerson((id) => { st.going.set(id, id); }));
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      err.textContent = "";
      const location = f.elements.location.value.trim();
      const start = f.elements.start.value, end = f.elements.end.value;
      if (!location) { err.textContent = "Enter the location."; f.elements.location.focus(); return; }
      if (!start) { err.textContent = "Pick the date you're going."; return; }
      if (end && end < start) { err.textContent = "The return date is before the going date."; return; }
      const travellers = orderedTravellers();
      const data = trip ? { ...clone(trip), location, start, end, travellers } : { id: newId(), location, start, end, travellers, costs: [], at: Date.now() };
      saveTrip(data);
      d.close();
      if (!editing) { if (tab !== "upcoming" && tripPhase(data) !== "past") { tab = "upcoming"; render(); } setTimeout(() => openTrip(data.id), 250); }
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete ${trip.location} and all its costs? This can't be undone.`, "Delete", "Keep"))) return;
      deleteDoc(fsDoc(holCol(), trip.id)).catch(console.error);
      d.close();
    });
    showDialog(d, redraw);
  }

  // =====================================================================
  // Add a cost (with its first payment or deposit + balance)
  // =====================================================================
  function addCost(tripId) {
    const st = { type: "flights", currency: "GBP", mode: "full" };
    const d = sheetShell("hol-cost-sheet", "Add a cost");
    const statusSel = (name, v) => `<span class="sel"><select name="${name}">
        <option value="paid"${v === "paid" ? " selected" : ""}>Paid</option>
        <option value="due"${v === "due" ? " selected" : ""}>Due by date</option>
        <option value="arrival"${v === "arrival" ? " selected" : ""}>On arrival</option></select>${icon("chevron")}</span>`;
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Add a cost</h2>
        <div class="form">
          <div class="fld"><span>Type</span><div class="type-grid">${COST_TYPES.map(([k, n]) =>
            `<button type="button" data-type="${k}" aria-pressed="${k === st.type}">${k === "other" ? "Other…" : n}</button>`).join("")}</div></div>
          <label class="fld other-name" hidden><span>Name</span><input name="name" type="text" autocomplete="off" maxlength="30" placeholder="e.g. Car hire"></label>
          <div class="two">
            <label class="fld"><span>Total cost</span><span class="money"><i data-sym>£</i><input name="total" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
            <div class="fld"><span>Currency</span>${segButtons("cur", [["GBP", "£"], ["EUR", "€"]], st.currency)}</div>
          </div>
          <div class="eur-only" hidden>${rateHtml(meta.rates && meta.rates.EUR)}</div>
          <div class="fld"><span>How is it being paid?</span>${segButtons("mode", [["full", "In full"], ["split", "Deposit + balance"]], st.mode)}</div>
          <div class="parts">
            <div class="part" data-part="full">
              <div class="two"><div class="fld"><span>Status</span>${statusSel("fullStatus", "paid")}</div>
              <label class="fld dated"><span data-dl>Paid on</span><input name="fullDate" type="date"></label></div>
            </div>
            <div class="part" data-part="split" hidden>
              <div class="two"><label class="fld"><span>Deposit</span><span class="money"><i data-sym>£</i><input name="deposit" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
                <div class="fld"><span>Status</span>${statusSel("depStatus", "paid")}</div></div>
              <label class="fld dated"><span data-dl>Paid on</span><input name="depDate" type="date"></label>
              <div class="two"><div class="fld"><span>Balance</span><div class="bal-fig amt" data-balance>—</div></div>
                <div class="fld"><span>Status</span>${statusSel("balStatus", "arrival")}</div></div>
              <label class="fld dated"><span data-dl>Due by</span><input name="balDate" type="date"></label>
            </div>
          </div>
          <small class="tp-hint">Each payment is split per person to start with. Open it afterwards to change the split or tick who's paid you.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    const today = todayIso();
    f.elements.fullDate.value = today; f.elements.depDate.value = today;
    const trip = tripById(tripId);
    if (trip && trip.start) f.elements.balDate.value = trip.start;
    d.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
      st.type = b.dataset.type;
      d.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      d.querySelector(".other-name").hidden = st.type !== "other";
      if (st.type === "other") f.elements.name.focus();
    }));
    const updBalance = () => {
      const tot = parseMoney(f.elements.total.value), dep = parseMoney(f.elements.deposit.value);
      d.querySelector("[data-balance]").textContent = tot != null && dep != null && tot >= dep ? money(tot - dep, st.currency) : "—";
    };
    const updDates = () => {
      const pairs = [["fullStatus", "fullDate"], ["depStatus", "depDate"], ["balStatus", "balDate"]];
      pairs.forEach(([s, dt]) => {
        const v = f.elements[s].value;
        const lab = f.elements[dt].closest(".fld");
        lab.hidden = v === "arrival";
        lab.querySelector("[data-dl]").textContent = v === "paid" ? "Paid on" : "Due by";
      });
    };
    ["fullStatus", "depStatus", "balStatus"].forEach((n) => f.elements[n].addEventListener("change", updDates));
    f.elements.total.addEventListener("input", updBalance);
    f.elements.deposit.addEventListener("input", updBalance);
    wireSeg(d, "cur", (v) => {
      st.currency = v;
      d.querySelectorAll("[data-sym]").forEach((s) => { s.textContent = SYMBOL[v]; });
      d.querySelector(".eur-only").hidden = v !== "EUR";
      updBalance();
    });
    wireSeg(d, "mode", (v) => {
      st.mode = v;
      d.querySelector('[data-part="full"]').hidden = v !== "full";
      d.querySelector('[data-part="split"]').hidden = v !== "split";
    });
    wireRate(d, () => {});
    updDates();
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      err.textContent = "";
      const t = tripById(tripId);
      if (!t) { d.close(); return; }
      const name = f.elements.name.value.trim();
      if (st.type === "other" && !name) { err.textContent = "Give the cost a name."; f.elements.name.focus(); return; }
      const total = parseMoney(f.elements.total.value);
      if (!total) { err.textContent = "Enter the total cost."; f.elements.total.focus(); return; }
      let rate = null;
      if (st.currency === "EUR") { rate = readRate(d); if (!rate) { err.textContent = "Enter the exchange rate (or tap Today's rate)."; return; } }
      const mk = (label, amount, status, date) => ({
        id: newId(), label, currency: st.currency, amount, rate, status, date: status === "arrival" ? "" : date || "",
        split: "person", received: {}
      });
      let payments;
      if (st.mode === "full") {
        payments = [mk("Paid in full", total, f.elements.fullStatus.value, f.elements.fullDate.value)];
        if (payments[0].status !== "paid") payments[0].label = "Full payment";
      } else {
        const dep = parseMoney(f.elements.deposit.value);
        if (!dep || dep >= total) { err.textContent = "The deposit must be more than 0 and less than the total."; f.elements.deposit.focus(); return; }
        payments = [mk("Deposit", dep, f.elements.depStatus.value, f.elements.depDate.value),
          mk("Balance", total - dep, f.elements.balStatus.value, f.elements.balDate.value)];
      }
      const cost = { id: newId(), type: st.type, name: st.type === "other" ? name : "", payments };
      saveTrip({ ...clone(t), costs: [...(t.costs || []), cost] });
      if (rate && rate !== (meta.rates || {}).EUR) saveMeta({ ...meta, rates: { ...(meta.rates || {}), EUR: rate } });
      d.close();
    });
    showDialog(d);
  }

  // Edit a cost: its type/name, or delete it
  function editCost(tripId, costId) {
    const t = tripById(tripId);
    const c = t && (t.costs || []).find((x) => x.id === costId);
    if (!c) return;
    const st = { type: c.type };
    const d = sheetShell("hol-cost-sheet", "Edit cost");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Edit cost</h2>
        <div class="form">
          <div class="fld"><span>Type</span><div class="type-grid">${COST_TYPES.map(([k, n]) =>
            `<button type="button" data-type="${k}" aria-pressed="${k === st.type}">${k === "other" ? "Other…" : n}</button>`).join("")}</div></div>
          <label class="fld other-name"${c.type === "other" ? "" : " hidden"}><span>Name</span><input name="name" type="text" autocomplete="off" maxlength="30"></label>
          <small class="tp-hint">To change amounts, dates or who's paid, tap the payment itself.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            <button type="button" class="btn-ghost danger" data-del>Delete</button>
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    f.elements.name.value = c.name || "";
    d.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
      st.type = b.dataset.type;
      d.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      d.querySelector(".other-name").hidden = st.type !== "other";
    }));
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = f.elements.name.value.trim();
      if (st.type === "other" && !name) { d.querySelector(".form-err").textContent = "Give the cost a name."; return; }
      const tt = clone(tripById(tripId));
      tt.costs = tt.costs.map((x) => (x.id === costId ? { ...x, type: st.type, name: st.type === "other" ? name : "" } : x));
      saveTrip(tt);
      d.close();
    });
    d.querySelector("[data-del]").addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete ${typeName(c)} and its payments?`, "Delete", "Keep"))) return;
      const tt = clone(tripById(tripId));
      tt.costs = tt.costs.filter((x) => x.id !== costId);
      saveTrip(tt);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // One payment: amount, currency, status, split and who's paid you
  // =====================================================================
  function openPayment(tripId, costId, payId) {
    const t = tripById(tripId);
    const c = t && (t.costs || []).find((x) => x.id === costId);
    if (!c) return;
    const existing = payId ? (c.payments || []).find((p) => p.id === payId) : null;
    const prev = (c.payments || [])[0];
    const p = existing ? clone(existing) : {
      id: newId(), label: (c.payments || []).length ? "Balance" : "Paid in full",
      currency: prev ? prev.currency : "GBP", amount: 0, rate: prev ? prev.rate : (meta.rates || {}).EUR || null,
      status: "due", date: t.start || "", split: "person", received: {}
    };
    p.received = p.received || {};
    const d = sheetShell("hol-pay-sheet", `${typeName(c)} payment`);
    const labels = PAYMENT_LABELS.includes(p.label) ? PAYMENT_LABELS : [p.label, ...PAYMENT_LABELS];
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${esc(typeName(c))} · <span data-title>${esc(p.label)}</span></h2>
        <div class="form">
          <div class="two wide-left">
            <div class="fld"><span>Payment</span><span class="sel"><select name="label">${labels.map((l) => `<option${l === p.label ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${icon("chevron")}</span></div>
            <div class="fld"><span>Currency</span>${segButtons("cur", [["GBP", "£"], ["EUR", "€"]], p.currency)}</div>
          </div>
          <label class="fld"><span>Amount</span><span class="money"><i data-sym>${SYMBOL[p.currency]}</i><input name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
          <div class="eur-only"${p.currency === "EUR" ? "" : " hidden"}>${rateHtml(p.rate)}</div>
          <div class="fld"><span>Status</span>${segButtons("status", [["paid", "Paid"], ["due", "Due by date"], ["arrival", "On arrival"]], p.status)}</div>
          <label class="fld dated"${p.status === "arrival" ? " hidden" : ""}><span data-dl>${p.status === "paid" ? "Paid on" : "Due by"}</span><input name="date" type="date"></label>
          <div class="fld"><span>Split</span>${segButtons("split", [["person", "Per person"], ["payer", "Per payer"], ["custom", "Custom"]], p.split)}</div>
          <div class="act-head"><span class="inv-label">Shares</span><span class="act-hint muted">Received?</span></div>
          <div class="share-rows"></div>
          <div class="split-foot"><span data-left></span></div>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${existing ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    f.elements.amount.value = p.amount ? moneyInput(p.amount) : "";
    f.elements.date.value = p.date || (p.status === "paid" ? todayIso() : "");
    const rowsEl = d.querySelector(".share-rows");
    let customShares = null; // { payerId: amount } while in custom

    const current = () => ({ ...p, amount: parseMoney(f.elements.amount.value) || 0, rate: p.currency === "EUR" ? readRate(d) : null });
    function drawShares() {
      const tt = tripById(tripId) || t;
      const cur = current();
      const shares = p.split === "custom" ? customShares : sharesOf(tt, cur);
      const payers = payersOf(tt);
      const ids = [...payers.map((x) => x.id), ...Object.keys(shares).filter((id) => !payers.some((x) => x.id === id))];
      if (!ids.length) { rowsEl.innerHTML = `<p class="act-empty">Add travellers to the holiday to split this payment.</p>`; updLeft(); return; }
      rowsEl.replaceChildren(...ids.map((id) => {
        const payer = payers.find((x) => x.id === id);
        const v = shares[id] || 0;
        const r = el(`<div class="share-row">
            <span class="pr-text"><b>${esc(personName(id))}</b><small>${payer ? esc(forText(payer)) : "no longer paying"}</small></span>
            <span class="share-amt"><span class="money"><i>${SYMBOL[p.currency]}</i><input type="text" inputmode="decimal" autocomplete="off" data-payer="${id}" aria-label="${esc(personName(id))}'s share"${p.split === "custom" ? "" : " readonly"}></span>
              ${p.currency === "EUR" ? `<small class="amt" data-gbp></small>` : ""}</span>
            ${toggleHtml(!!p.received[id], `${personName(id)} has paid you`)}
          </div>`);
        const input = r.querySelector("input");
        input.value = moneyInput(v);
        const gb = r.querySelector("[data-gbp]");
        const setGbp = (val) => { if (gb) gb.textContent = cur.rate ? `≈ ${pounds0(Math.round(val * cur.rate))}` : ""; };
        setGbp(v);
        input.addEventListener("input", () => {
          const nv = parseMoney(input.value);
          customShares[id] = nv || 0;
          setGbp(nv || 0);
          updLeft();
        });
        const tg = r.querySelector(".rcv");
        tg.addEventListener("click", () => {
          p.received[id] = !p.received[id];
          if (!p.received[id]) delete p.received[id];
          tg.setAttribute("aria-checked", String(!!p.received[id]));
          if (p.received[id] && navigator.vibrate) navigator.vibrate(12);
        });
        return r;
      }));
      updLeft();
    }
    function updLeft() {
      const out = d.querySelector("[data-left]");
      out.className = ""; out.textContent = "";
      if (p.split !== "custom") return;
      const amt = parseMoney(f.elements.amount.value) || 0;
      const sum = Object.values(customShares || {}).reduce((s, v) => s + (v || 0), 0);
      const left = amt - sum;
      if (!amt) return;
      if (left === 0) { out.innerHTML = `${icon("check")}Split matches the amount`; out.className = "ok"; }
      else if (left > 0) { out.textContent = `${money(left, p.currency)} still to share out`; out.className = "warn"; }
      else { out.textContent = `${money(-left, p.currency)} too much`; out.className = "bad"; }
    }

    if (p.split === "custom") customShares = { ...(p.shares || {}) };
    f.addEventListener("input", () => { err.textContent = ""; });
    d.addEventListener("click", (e) => { if (e.target.closest("[data-seg] button")) err.textContent = ""; });
    f.elements.label.addEventListener("change", () => { p.label = f.elements.label.value; d.querySelector("[data-title]").textContent = p.label; });
    f.elements.amount.addEventListener("input", () => { if (p.split !== "custom") drawShares(); else updLeft(); });
    wireSeg(d, "cur", (v) => {
      p.currency = v;
      if (v === "EUR" && !readRate(d) && (meta.rates || {}).EUR) d.querySelector('[name="rate"]').value = meta.rates.EUR;
      d.querySelector("[data-sym]").textContent = SYMBOL[v];
      d.querySelector(".eur-only").hidden = v !== "EUR";
      drawShares();
    });
    wireSeg(d, "status", (v) => {
      p.status = v;
      const lab = d.querySelector(".dated");
      lab.hidden = v === "arrival";
      lab.querySelector("[data-dl]").textContent = v === "paid" ? "Paid on" : "Due by";
      if (v === "paid" && !f.elements.date.value) f.elements.date.value = todayIso();
    });
    wireSeg(d, "split", (v) => {
      if (v === "custom" && p.split !== "custom") customShares = sharesOf(tripById(tripId) || t, current()); // start from what it was
      p.split = v;
      drawShares();
    });
    wireRate(d, () => drawShares());
    drawShares();

    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      err.textContent = "";
      const amount = parseMoney(f.elements.amount.value);
      if (!amount) { err.textContent = "Enter the amount."; f.elements.amount.focus(); return; }
      let rate = null;
      if (p.currency === "EUR") { rate = readRate(d); if (!rate) { err.textContent = "Enter the exchange rate (or tap Today's rate)."; return; } }
      const date = p.status === "arrival" ? "" : f.elements.date.value;
      if (p.status === "due" && !date) { err.textContent = "Pick the date it's due by."; return; }
      const out = { id: p.id, label: p.label, currency: p.currency, amount, rate, status: p.status, date, split: p.split, received: p.received };
      if (p.split === "custom") {
        const sum = Object.values(customShares).reduce((s, v) => s + (v || 0), 0);
        if (sum !== amount) { err.textContent = sum < amount ? `Share out the full amount — ${money(amount - sum, p.currency)} left.` : `The shares add up to ${money(sum - amount, p.currency)} more than the amount.`; return; }
        out.shares = Object.fromEntries(Object.entries(customShares).filter(([, v]) => v));
      }
      const tt = clone(tripById(tripId));
      tt.costs = tt.costs.map((x) => x.id !== costId ? x : {
        ...x, payments: existing ? x.payments.map((q) => (q.id === p.id ? out : q)) : [...(x.payments || []), out]
      });
      saveTrip(tt);
      if (rate && rate !== (meta.rates || {}).EUR) saveMeta({ ...meta, rates: { ...(meta.rates || {}), EUR: rate } });
      d.close();
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete this ${p.label.toLowerCase()} of ${money(existing.amount, existing.currency)}?`, "Delete", "Keep"))) return;
      const tt = clone(tripById(tripId));
      tt.costs = tt.costs.map((x) => x.id !== costId ? x : { ...x, payments: x.payments.filter((q) => q.id !== p.id) });
      saveTrip(tt);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // One payer: every share they owe, tick each off (or all at once)
  // =====================================================================
  function openPayer(tripId, payerId) {
    const d = sheetShell("hol-payer-sheet", personName(payerId));
    const draw = () => {
      const t = tripById(tripId);
      if (!t) { d.close(); return; }
      const payer = payersOf(t).find((x) => x.id === payerId) || { id: payerId, for: [] };
      const tot = tripTotals(t).byPayer[payerId] || { total: 0, received: 0 };
      const rows = [];
      for (const c of t.costs || []) for (const p of c.payments || []) {
        const v = sharesOf(t, p)[payerId];
        if (v) rows.push({ c, p, v });
      }
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <h2>${esc(personName(payerId))}</h2>
        <p class="payer-sub">${esc(forText(payer))} · <span class="amt">${pounds0(tot.received)}</span> of <span class="amt">${pounds0(tot.total)}</span> received</p>
        <div class="payer-rows">${rows.length ? "" : `<p class="act-empty">Nothing to pay yet.</p>`}</div>
        <div class="sheet-buttons">
          ${rows.some((r) => !(r.p.received || {})[payerId]) ? `<button type="button" class="btn-ghost" data-all>All received</button>` : ""}
          <button type="button" class="btn" data-done>Done</button>
        </div>`;
      const list = d.querySelector(".payer-rows");
      rows.forEach(({ c, p, v }) => {
        const on = !!(p.received || {})[payerId];
        const r = el(`<div class="share-row">
            <span class="pr-text"><b>${esc(typeName(c))} · ${esc(p.label)}</b><small>${p.status === "paid" ? "Paid to supplier" : p.status === "arrival" ? "Pay on arrival" : p.date ? `Due ${niceDate(p.date)}` : "Due"}</small></span>
            <span class="pr-fig"><b class="amt">${money(v, p.currency)}</b>${p.currency === "EUR" ? `<small class="amt">≈ ${pounds0(toGBP(v, p))}</small>` : ""}</span>
            ${toggleHtml(on, `${typeName(c)} ${p.label} received`)}
          </div>`);
        r.querySelector(".rcv").addEventListener("click", () => setReceived(tripId, [[c.id, p.id]], payerId, !on));
        list.appendChild(r);
      });
      const all = d.querySelector("[data-all]");
      if (all) all.addEventListener("click", () => setReceived(tripId, rows.map(({ c, p }) => [c.id, p.id]), payerId, true));
      d.querySelector("[data-done]").addEventListener("click", () => d.close());
    };
    draw();
    showDialog(d, draw);
  }
  function setReceived(tripId, which, payerId, on) {
    const tt = clone(tripById(tripId));
    for (const c of tt.costs || []) for (const p of c.payments || []) {
      if (!which.some(([ci, pi]) => ci === c.id && pi === p.id)) continue;
      p.received = p.received || {};
      if (on) p.received[payerId] = true; else delete p.received[payerId];
    }
    if (on && navigator.vibrate) navigator.vibrate(12);
    // Show it straight away, then save
    const i = trips.findIndex((t) => t.id === tripId);
    if (i >= 0) { trips[i] = tt; render(); }
    saveTrip(tt);
  }

  // =====================================================================
  // People
  // =====================================================================
  const personInUse = (id) => trips.some((t) => (t.travellers || []).some((x) => x.personId === id || x.payerId === id) ||
    (t.costs || []).some((c) => (c.payments || []).some((p) => (p.received || {})[id] || (p.shares || {})[id])));

  function openPeople() {
    const d = sheetShell("lists-sheet hol-people", "People");
    const draw = () => {
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <h2>People</h2>
        <p class="payer-sub">Everyone who might go away with you, including yourself. Pick who's going on each holiday.</p>
        <div class="list-items">${(meta.people || []).map((p) => `
          <div class="list-item" data-id="${p.id}"><span class="li-name">${esc(p.name)}</span><span class="li-used">${personInUse(p.id) ? "on a holiday" : ""}</span>
            <button type="button" class="square-btn" data-rename aria-label="Rename">${icon("pen")}</button>
            <button type="button" class="square-btn" data-remove aria-label="Delete"${personInUse(p.id) ? " disabled" : ""}>${icon("x")}</button></div>`).join("")}</div>
        <form class="list-add"><input type="text" autocomplete="off" maxlength="24" aria-label="New person" placeholder="Add a person…"><button type="submit" class="add-btn" aria-label="Add">${icon("plus")}</button></form>
        <p class="list-hint">People on a holiday can be renamed but not deleted.</p>
        <div class="sheet-buttons"><button type="button" class="btn-ghost" data-done>Done</button></div>`;
      d.querySelectorAll(".list-item").forEach((row) => {
        const id = row.dataset.id;
        const person = meta.people.find((p) => p.id === id);
        row.querySelector("[data-rename]").addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "text"; input.value = person.name; input.className = "li-edit"; input.maxLength = 24; input.setAttribute("aria-label", "New name");
          row.querySelector(".li-name").replaceWith(input);
          input.focus(); input.select();
          const commit = () => {
            const name = input.value.trim();
            if (name && name !== person.name) saveMeta({ ...meta, people: meta.people.map((p) => (p.id === id ? { ...p, name } : p)) });
            else draw();
          };
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
          input.addEventListener("blur", commit, { once: true });
        });
        row.querySelector("[data-remove]").addEventListener("click", async () => {
          if (personInUse(id)) return;
          if (await confirmDialog(`Delete ${person.name}?`, "Delete", "Keep")) saveMeta({ ...meta, people: meta.people.filter((p) => p.id !== id) });
        });
      });
      const form = d.querySelector(".list-add");
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const name = input.value.trim();
        if (!name) return;
        if ((meta.people || []).some((p) => p.name.toLowerCase() === name.toLowerCase())) { input.select(); return; }
        meta = { ...meta, people: [...(meta.people || []), { id: newId(), name }] };
        saveMeta(meta);
        draw();
        d.querySelector(".list-add input").focus();
      });
      d.querySelector("[data-done]").addEventListener("click", () => d.close());
    };
    draw();
    showDialog(d, () => { if (!d.contains(document.activeElement) || !document.activeElement.matches("input")) draw(); });
  }

  // Small pop-up to add one person (from the holiday form)
  function addPerson(onAdded) {
    const d = document.createElement("dialog");
    d.className = "pv-dialog set-form";
    d.innerHTML = `<form method="dialog" novalidate class="form"><h2>Add a person</h2>
      <label class="fld"><span>Name</span><input name="name" type="text" autocomplete="off" maxlength="24"></label>
      <p class="form-err" role="alert"></p>
      <div class="sheet-buttons"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn">Add</button></div></form>`;
    const f = d.querySelector("form");
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = f.elements.name.value.trim();
      if (!name) { d.querySelector(".form-err").textContent = "Enter a name."; return; }
      const found = (meta.people || []).find((p) => p.name.toLowerCase() === name.toLowerCase());
      const id = found ? found.id : newId();
      if (!found) { meta = { ...meta, people: [...(meta.people || []), { id, name }] }; saveMeta(meta); }
      onAdded(id);
      d.close();
      live.forEach((fn) => { try { fn(); } catch {} });
    });
    showDialog(d);
  }

  // Leaving Holidays: stop live updates and close anything open
  return () => {
    stops.forEach((s) => { try { s(); } catch {} });
    stops = [];
    [...dialogs].forEach((x) => { try { x.close(); } catch {} });
  };
}
