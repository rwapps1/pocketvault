// holidays.js — the Holidays mini app
//
// Each holiday has a location, dates, who's going and who pays for whom.
// Each cost (taxis, flights, transfer, hotel, local tax, other) is paid in
// advance or on arrival and split equally per person, or with your own
// amounts. Tick "supplier paid" and each payer's "in" straight from the
// trip screen. Updates live and works offline.

import { confirmDialog } from "./app.js";
import {
  onSnapshot, setDoc, deleteDoc, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  holMeta, holCol, newId, COST_TYPES, typeName, typeLabel, normalizeTrip,
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
      trips = snap.docs.map((d) => normalizeTrip({ id: d.id, ...d.data() })).filter((t) => t && t.location);
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
    if (!n) return (t.costs || []).length ? `<span class="hol-next-done">${icon("check")}All suppliers paid</span>` : `<span class="muted">No costs added yet</span>`;
    return `<span>${esc(typeName(n))} <span class="amt">${money(n.amount, n.currency)}</span> · ${n.when === "arrival" ? "on arrival" : "to pay"}</span>`;
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
        ${tot.total ? bar("Money received", tot.received, tot.total, "in") + bar("Suppliers paid", tot.supplier, tot.total) : ""}
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
    d.querySelector("[data-add]").addEventListener("click", () => openCost(tripId, null));
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
          ${tot.total ? bar("Money received", tot.received, tot.total, "in") + bar("Suppliers paid", tot.supplier, tot.total) : ""}
          ${arr ? `<small class="inv-asof">To pay on arrival: <span class="amt">${arr}</span>${tot.arrival.EUR ? ` <span class="amt">(≈ ${pounds0(tot.arrivalGBP)})</span>` : ""}</small>` : ""}
        </section>`);
      // Still to come in, per payer
      const payers = payersOf(t);
      const who = el(`<div class="hol-owed"><span class="inv-label">Still to come in</span><div class="owed-grid"></div></div>`);
      const grid = who.querySelector(".owed-grid");
      if (!payers.length) who.appendChild(el(`<p class="act-empty">Nobody's going yet. Tap the pen to add who's going.</p>`));
      payers.forEach((p) => {
        const b = tot.byPayer[p.id] || { total: 0, received: 0 };
        const left = b.total - b.received;
        grid.appendChild(el(`<div class="owed"><span>${esc(personName(p.id))}</span>${left > 0 ? `<b class="brass amt">${pounds0(left)}</b>` : b.total ? `<b class="up">✓ All in</b>` : `<b class="muted">—</b>`}</div>`));
      });
      // Costs, each with its ticks
      const costs = el(`<div class="hol-costs"><div class="act-head"><span class="inv-label">Costs</span>${(t.costs || []).length ? `<span class="act-hint">Tap a name to edit</span>` : ""}</div></div>`);
      (t.costs || []).forEach((c) => costs.appendChild(costCard(t, c)));
      const addBtn = el(`<button type="button" class="btn-dashed hol-add-cost">+ Add a cost</button>`);
      addBtn.addEventListener("click", () => openCost(tripId, null));
      costs.appendChild(addBtn);
      body.replaceChildren(card, who, costs);
    };
    draw();
    showDialog(d, draw);
  }
  const hasEuro = (t) => (t.costs || []).some((c) => c.currency === "EUR");

  // A tick button: "Supplier paid" or "In"
  const tickHtml = (on, text, label) =>
    `<button type="button" class="tick${on ? " on" : ""}" aria-pressed="${on}" aria-label="${esc(label)}">${on ? icon("check") : "<i></i>"}${text}</button>`;

  function costCard(t, c) {
    const eur = c.currency === "EUR";
    const b = el(`<section class="hol-cost">
        <button type="button" class="hc-head">
          <span class="hc-titles"><span class="hc-name">${esc(typeName(c))}</span>
            <small><span class="${c.when === "arrival" ? "brass" : ""}">${c.when === "arrival" ? "On arrival" : "In advance"}</span> · ${c.split === "custom" ? "custom split" : "equal per person"}</small></span>
          <span class="hc-fig"><b class="amt">${money(c.amount, c.currency)}</b>${eur ? `<small class="amt">≈ ${pounds0(toGBP(c.amount, c))}</small>` : ""}</span>
        </button>
        <div class="hc-sup"><span>Supplier</span>${tickHtml(!!c.supplierPaid, "Supplier paid", `${typeName(c)}: supplier paid`)}</div>
      </section>`);
    b.querySelector(".hc-head").addEventListener("click", () => openCost(t.id, c.id));
    b.querySelector(".hc-sup .tick").addEventListener("click", () => setTick(t.id, c.id, "supplier", null));
    const payers = payersOf(t);
    const shares = sharesOf(t, c);
    const ids = [...payers.map((x) => x.id), ...Object.keys(shares).filter((id) => !payers.some((x) => x.id === id))];
    if (!ids.length) b.appendChild(el(`<p class="act-empty">Add who's going to split this cost.</p>`));
    ids.forEach((id) => {
      const v = shares[id] || 0;
      if (!v) return;
      const payer = payers.find((x) => x.id === id);
      const on = !!(c.received || {})[id];
      const row = el(`<div class="hc-line">
          <span class="pr-text"><b>${esc(personName(id))}</b><small>${payer ? esc(forText(payer)) : "no longer going"}</small></span>
          <span class="pr-fig"><b class="amt">${money(v, c.currency)}</b>${eur ? `<small class="amt">≈ ${pounds0(toGBP(v, c))}</small>` : ""}</span>
          ${tickHtml(on, "In", `${personName(id)} has paid you for ${typeName(c)}`)}
        </div>`);
      row.querySelector(".tick").addEventListener("click", () => setTick(t.id, c.id, "in", id));
      b.appendChild(row);
    });
    return b;
  }

  // Tick or untick "supplier paid" or a payer's "in", straight from the list
  function setTick(tripId, costId, kind, payerId) {
    const tt = clone(tripById(tripId));
    const c = (tt.costs || []).find((x) => x.id === costId);
    if (!c) return;
    let on;
    if (kind === "supplier") on = c.supplierPaid = !c.supplierPaid;
    else {
      c.received = c.received || {};
      on = !c.received[payerId];
      if (on) c.received[payerId] = true; else delete c.received[payerId];
    }
    if (on && navigator.vibrate) navigator.vibrate(12);
    const i = trips.findIndex((x) => x.id === tripId);
    if (i >= 0) { trips[i] = tt; render(); } // show it straight away
    saveTrip(tt);
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
  // Add / edit a cost: what for, amount, when, and how it's split
  // =====================================================================
  function openCost(tripId, costId) {
    const t0 = tripById(tripId);
    if (!t0) return;
    const existing = costId ? (t0.costs || []).find((x) => x.id === costId) : null;
    const last = (t0.costs || [])[(t0.costs || []).length - 1];
    const c = existing ? clone(existing) : {
      id: newId(), type: "flights", name: "", currency: last ? last.currency : "GBP", amount: 0,
      rate: (meta.rates || {}).EUR || null, when: "advance", supplierPaid: false, split: "equal", received: {}
    };
    c.received = c.received || {};
    let custom = c.split === "custom" ? { ...(c.shares || {}) } : null;
    const d = sheetShell("hol-cost-sheet", existing ? "Edit cost" : "Add a cost");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${existing ? "Edit cost" : "Add a cost"}</h2>
        <div class="form">
          <div class="fld"><span>What for</span><div class="type-grid">${COST_TYPES.map(([k, n]) =>
            `<button type="button" data-type="${k}" aria-pressed="${k === c.type}">${k === "other" ? "Other…" : n}</button>`).join("")}</div></div>
          <label class="fld"><span>Name on the list</span><input name="name" type="text" autocomplete="off" maxlength="30"></label>
          <div class="two wide-left">
            <label class="fld"><span>Amount</span><span class="money"><i data-sym>${SYMBOL[c.currency]}</i><input name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
            <div class="fld"><span>Currency</span>${segButtons("cur", [["GBP", "£"], ["EUR", "€"]], c.currency)}</div>
          </div>
          <div class="eur-only"${c.currency === "EUR" ? "" : " hidden"}>${rateHtml(c.rate)}</div>
          <div class="fld"><span>When</span>${segButtons("when", [["advance", "Pay in advance"], ["arrival", "On arrival"]], c.when)}</div>
          <div class="fld"><span>Split</span>${segButtons("split", [["equal", "Equal"], ["custom", "Custom"]], c.split === "custom" ? "custom" : "equal")}</div>
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
    const nameInput = f.elements.name;
    // The name follows the type until you type your own (e.g. "Hotel deposit")
    let nameAuto = !existing || !existing.name || existing.name === typeLabel(existing.type);
    nameInput.value = existing ? typeName(existing) : typeLabel(c.type);
    nameInput.addEventListener("input", () => { nameAuto = false; });
    f.elements.amount.value = c.amount ? moneyInput(c.amount) : "";
    f.addEventListener("input", () => { err.textContent = ""; });

    d.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
      c.type = b.dataset.type;
      d.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (nameAuto) nameInput.value = c.type === "other" ? "" : typeLabel(c.type);
      if (c.type === "other") { nameAuto = false; nameInput.focus(); }
    }));

    const rowsEl = d.querySelector(".share-rows");
    const current = () => ({ ...c, amount: parseMoney(f.elements.amount.value) || 0, rate: c.currency === "EUR" ? readRate(d) : null, split: custom ? "custom" : "equal", shares: custom || {} });
    function drawShares() {
      const t = tripById(tripId) || t0;
      const cur = current();
      const shares = custom || sharesOf(t, cur);
      const payers = payersOf(t);
      const ids = [...payers.map((x) => x.id), ...Object.keys(shares).filter((id) => !payers.some((x) => x.id === id))];
      if (!ids.length) { rowsEl.innerHTML = `<p class="act-empty">Add who's going to the holiday to split this cost.</p>`; updLeft(); return; }
      rowsEl.replaceChildren(...ids.map((id) => {
        const payer = payers.find((x) => x.id === id);
        const v = shares[id] || 0;
        const r = el(`<div class="share-row">
            <span class="pr-text"><b>${esc(personName(id))}</b><small>${payer ? esc(forText(payer)) : "no longer going"}</small></span>
            <span class="share-amt"><span class="money"><i>${SYMBOL[c.currency]}</i><input type="text" inputmode="decimal" autocomplete="off" aria-label="${esc(personName(id))}'s share"${custom ? "" : " readonly tabindex=\"-1\""}></span>
              ${c.currency === "EUR" ? `<small class="amt" data-gbp></small>` : ""}</span>
          </div>`);
        const input = r.querySelector("input");
        input.value = moneyInput(v);
        const gb = r.querySelector("[data-gbp]");
        const setGbp = (val) => { if (gb) gb.textContent = cur.rate ? `≈ ${pounds0(Math.round(val * cur.rate))}` : ""; };
        setGbp(v);
        input.addEventListener("input", () => { const nv = parseMoney(input.value); custom[id] = nv || 0; setGbp(nv || 0); updLeft(); });
        return r;
      }));
      updLeft();
    }
    function updLeft() {
      const out = d.querySelector("[data-left]");
      out.className = ""; out.textContent = "";
      if (!custom) return;
      const amt = parseMoney(f.elements.amount.value) || 0;
      const left = amt - Object.values(custom).reduce((s, v) => s + (v || 0), 0);
      if (!amt) return;
      if (left === 0) { out.innerHTML = `${icon("check")}Split matches the amount`; out.className = "ok"; }
      else if (left > 0) { out.textContent = `${money(left, c.currency)} still to share out`; out.className = "warn"; }
      else { out.textContent = `${money(-left, c.currency)} too much`; out.className = "bad"; }
    }
    f.elements.amount.addEventListener("input", () => { if (!custom) drawShares(); else updLeft(); });
    wireSeg(d, "cur", (v) => {
      c.currency = v;
      if (v === "EUR" && !readRate(d) && (meta.rates || {}).EUR) d.querySelector('[name="rate"]').value = meta.rates.EUR;
      d.querySelector("[data-sym]").textContent = SYMBOL[v];
      d.querySelector(".eur-only").hidden = v !== "EUR";
      drawShares();
    });
    wireSeg(d, "when", (v) => { c.when = v; });
    wireSeg(d, "split", (v) => {
      err.textContent = "";
      if (v === "custom" && !custom) custom = sharesOf(tripById(tripId) || t0, { ...current(), split: "equal" }); // start from the equal split
      if (v === "equal") custom = null;
      drawShares();
    });
    wireRate(d, () => drawShares());
    drawShares();

    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      err.textContent = "";
      const name = nameInput.value.trim();
      const amount = parseMoney(f.elements.amount.value);
      if (!name) { err.textContent = "Give the cost a name."; nameInput.focus(); return; }
      if (!amount) { err.textContent = "Enter the amount."; f.elements.amount.focus(); return; }
      let rate = null;
      if (c.currency === "EUR") { rate = readRate(d); if (!rate) { err.textContent = "Enter the exchange rate (or tap Today's rate)."; return; } }
      const out = {
        id: c.id, type: c.type, name: name === typeLabel(c.type) ? "" : name, currency: c.currency, amount, rate,
        when: c.when, supplierPaid: !!c.supplierPaid, split: custom ? "custom" : "equal", received: c.received
      };
      if (custom) {
        const sum = Object.values(custom).reduce((s, v) => s + (v || 0), 0);
        if (sum !== amount) { err.textContent = sum < amount ? `Share out the full amount — ${money(amount - sum, c.currency)} left.` : `The shares add up to ${money(sum - amount, c.currency)} more than the amount.`; return; }
        out.shares = Object.fromEntries(Object.entries(custom).filter(([, v]) => v));
      }
      const tt = clone(tripById(tripId));
      tt.costs = existing ? tt.costs.map((x) => (x.id === c.id ? out : x)) : [...(tt.costs || []), out];
      saveTrip(tt);
      if (rate && rate !== (meta.rates || {}).EUR) saveMeta({ ...meta, rates: { ...(meta.rates || {}), EUR: rate } });
      d.close();
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete ${typeName(existing)} (${money(existing.amount, existing.currency)})?`, "Delete", "Keep"))) return;
      const tt = clone(tripById(tripId));
      tt.costs = tt.costs.filter((x) => x.id !== c.id);
      saveTrip(tt);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // People
  // =====================================================================
  const personInUse = (id) => trips.some((t) => (t.travellers || []).some((x) => x.personId === id || x.payerId === id) ||
    (t.costs || []).some((c) => (c.received || {})[id] || (c.shares || {})[id]));

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
