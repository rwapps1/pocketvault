// investments.js — the Investments mini app
//
// Trading 212: pies, each holding pots. Money goes in and out of a pie and is
// split between its pots; you enter each pie's value now and then, and the
// app works out growth, XIRR and each pot's share. Premium Bonds sit on their
// own tab. Everything updates live from Firestore and works offline.

import { confirmDialog, db } from "./app.js";
import {
  onSnapshot, setDoc, deleteDoc, writeBatch, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  investMeta, investCol, pbCol, valueId, DEFAULT_ISA, emptyMeta, newId,
  todayIso, shortDate, niceDate, taxYearOfDate, taxYearName,
  money, money0, signed0, pctText, rateText, parseMoney, moneyInput,
  usualTotal, computeAll, xirrFor, isaUsed, pbSummary
} from "./investments-data.js";

const TYPE_NAMES = { deposit: "Deposit", withdraw: "Withdrawal", move: "Move between pots" };

export function mount(root, { open }) {
  const $ = (sel) => root.querySelector(sel);
  const icon = (n) => window.PV.icon(n);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let meta = emptyMeta(), events = [], pbEntries = [];
  let loaded = { meta: false, invest: false, pb: false };
  let calc = null;              // worked-out figures (computeAll)
  let stops = [];
  const dialogs = new Set();    // everything we opened, closed when leaving
  const live = new Set();       // redraw functions of open panels / sheets

  let tab = "t212";
  try { if (sessionStorage.getItem("pv-inv-tab") === "pb") tab = "pb"; } catch {}

  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);
  const saveMeta = (m) => writeOffline(setDoc(investMeta(), m));
  const pieById = (id) => (meta.pies || []).find((p) => p.id === id);
  const calcOf = (id) => calc && calc.pies.find((c) => c.id === id);
  const potName = (pie, potId) => ((pie.pots || []).find((p) => p.id === potId) || {}).name || "Removed pot";

  open.then(() => {
    stops.push(onSnapshot(investMeta(), (snap) => {
      meta = snap.exists() ? { ...emptyMeta(), ...snap.data() } : emptyMeta();
      loaded.meta = true; render();
    }, showError));
    stops.push(onSnapshot(investCol(), (snap) => {
      events = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e && e.date && e.pieId);
      loaded.invest = true; render();
    }, showError));
    stops.push(onSnapshot(pbCol(), (snap) => {
      pbEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e && e.date && e.type);
      loaded.pb = true; render();
    }, showError));
  });

  function showError(e) {
    console.error(e);
    $('[data-pane="t212"]').innerHTML = `<p class="bills-loading">Couldn't load your investments.</p>`;
  }

  // ---------- Tabs ----------
  root.querySelectorAll(".inv-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.tab;
    try { sessionStorage.setItem("pv-inv-tab", tab); } catch {}
    render();
  }));

  $("[data-inv-add]").addEventListener("click", () => {
    if (!loaded.meta) return;
    if (tab === "pb") openPB(null);
    else if (!(meta.pies || []).length) openSettings();
    else openMoney({});
  });
  $("[data-inv-settings]").addEventListener("click", () => loaded.meta && openSettings());

  // ---------- Drawing ----------
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const tone = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

  function render() {
    if (!loaded.meta || !loaded.invest || !loaded.pb) return;
    calc = computeAll(meta, events);
    root.querySelectorAll(".inv-tabs [data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
    $('[data-pane="t212"]').hidden = tab !== "t212";
    $('[data-pane="pb"]').hidden = tab !== "pb";
    $("[data-inv-add]").setAttribute("aria-label", tab === "pb" ? "Add a Premium Bonds entry" : "Add money");
    renderT212();
    renderPB();
    live.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  function statCell(label, value, sub, cls = "") {
    return `<div class="inv-stat"><span class="inv-label">${label}</span><b class="${cls}">${value}</b><small>${sub}</small></div>`;
  }
  function xirrCell(x) {
    if (x.rate != null) return statCell("XIRR", rateText(x.rate), "a year");
    return statCell("XIRR", "—", x.reason === "too-soon" ? "after 3 months" : "needs a value");
  }

  function renderT212() {
    const pane = $('[data-pane="t212"]');
    if (!(meta.pies || []).length) {
      pane.innerHTML = `<section class="plate empty-state">
          <span class="box-glyph">${icon("investments")}</span>
          <h2>Set up your pies</h2>
          <p>Import your setup file, or add your pies and pots in settings.</p>
          <label class="import-link">Import from a file<input type="file" accept=".json,application/json" hidden></label>
          <div><button type="button" class="btn-ghost" data-open-settings>Open settings</button></div>
        </section>`;
      pane.querySelector("[data-open-settings]").addEventListener("click", openSettings);
      hookImport(pane);
      return;
    }
    const ty = taxYearOfDate(todayIso());
    const used = isaUsed(events, ty);
    const limit = meta.isaLimit || DEFAULT_ISA;
    const asOf = calc.valueDate
      ? `As of ${niceDate(calc.valueDate)}${calc.stale ? ` · <em>money added since</em>` : ""}`
      : "No values entered yet";
    const card = el(`<section class="inv-card">
        <div class="inv-top">
          <div class="inv-headline"><span class="inv-label">Current value</span><span class="inv-big amt">${money0(calc.value)}</span><small class="inv-asof">${asOf}</small></div>
          <button type="button" class="inv-update" data-update-values>Update values</button>
        </div>
        <div class="inv-stats">
          ${statCell("Gain", signed0(calc.gain), calc.paidIn > 0 ? pctText(calc.gain / calc.paidIn) : "", "amt " + tone(calc.gain))}
          ${xirrCell(calc.xirr)}
          ${statCell("Paid in", money0(calc.paidIn), "after withdrawals", "amt")}
        </div>
        <div class="isa" aria-label="ISA allowance ${taxYearName(ty)}: ${money0(used)} of ${money0(limit)} used">
          <span class="inv-label">ISA ${taxYearName(ty)}</span>
          <div class="isa-bar${used > limit ? " over" : ""}"><i style="width:${Math.min(100, (used / limit) * 100).toFixed(1)}%"></i></div>
          <span class="isa-used"><b class="amt">${money0(used)}</b> of ${money0(limit)}</span>
        </div>
      </section>`);
    card.querySelector("[data-update-values]").addEventListener("click", openValues);
    const blocks = meta.pies.map((pie) => pieBlock(pie, calcOf(pie.id)));
    pane.replaceChildren(card, ...blocks);
  }

  function pieBlock(pie, c) {
    const x = calcXirr(pie.id);
    const b = el(`<section class="pie-block">
        <button type="button" class="pie-head" aria-label="Open ${esc(pie.name)}">
          <span class="pie-titles">
            <span class="pie-name">${esc(pie.name)}${pie.fullName ? ` <small>${esc(pie.fullName)}</small>` : ""}</span>
            <span class="pie-sub"><span class="amt ${tone(c.gain)}">${signed0(c.gain)}${c.paidIn > 0 ? ` · ${pctText(c.gain / c.paidIn)}` : ""}</span> · XIRR ${x.rate != null ? rateText(x.rate) : "—"}</span>
          </span>
          <span class="pie-value amt">${money0(c.value)}</span>
          <span class="pie-chev">${icon("back")}</span>
        </button>
        <div class="pie-pots"></div>
      </section>`);
    b.querySelector(".pie-head").addEventListener("click", () => openPiePanel(pie.id));
    const grid = b.querySelector(".pie-pots");
    (pie.pots || []).forEach((pot) => {
      const v = (c.pots[pot.id] || {}).value || 0;
      const cell = el(`<button type="button" class="pot-cell"><span class="pc-name">${esc(pot.name)}</span><span class="pc-val amt">${money0(v)}</span></button>`);
      cell.setAttribute("aria-label", `${pot.name}: ${money0(v)}. Open`);
      cell.addEventListener("click", () => openPotPanel(pie.id, pot.id));
      grid.appendChild(cell);
    });
    if (!(pie.pots || []).length) grid.innerHTML = `<p class="pie-empty">No pots yet — add them in settings.</p>`;
    return b;
  }

  // XIRR for one pie (same rules as the overall figure)
  const calcXirr = (pieId) => {
    const c = calcOf(pieId);
    return c ? xirrFor([c]) : { rate: null, reason: "no-value" };
  };

  // ---------- Premium Bonds tab ----------
  function renderPB() {
    const pane = $('[data-pane="pb"]');
    const s = pbSummary(pbEntries);
    const sorted = pbEntries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.at || 0) - (a.at || 0)));
    const card = el(`<section class="inv-card">
        <div class="inv-headline"><span class="inv-label">Held</span><span class="inv-big amt">${money0(s.held)}</span></div>
        <div class="inv-stats">
          ${statCell(`Prizes ${taxYearName(s.ty)}`, money0(s.prizesTY), `${s.countTY} prize${s.countTY === 1 ? "" : "s"}`, "amt " + (s.prizesTY ? "up" : ""))}
          ${statCell("All time", money0(s.prizesAll), s.since ? `since ${niceDate(s.since)}` : "no prizes yet", "amt")}
          ${statCell("Rate", s.rate != null ? rateText(s.rate) : "—", s.rate != null ? "last 12 months" : "after 3 months")}
        </div>
      </section>`);
    const list = el(`<div class="inv-activity"><div class="act-head"><span class="inv-label">Activity</span></div></div>`);
    if (!sorted.length) {
      list.appendChild(el(`<p class="act-empty">Nothing yet. Tap <strong>+</strong> to add your Premium Bonds.</p>`));
    }
    sorted.forEach((e) => {
      const sub = e.type === "prize" ? (e.reinvested ? "Reinvested" : "Paid out") : "";
      const cls = e.type === "withdraw" ? "down" : e.type === "prize" ? (e.reinvested ? "up" : "muted") : "";
      const row = el(`<button type="button" class="act-row">
          <span class="act-date">${shortDate(e.date)}</span>
          <span class="act-text"><b>${e.type === "prize" ? "Prize" : e.type === "withdraw" ? "Withdrawal" : "Deposit"}</b>${sub ? `<small>${sub}</small>` : ""}</span>
          <span class="act-amt amt ${cls}">${e.type === "withdraw" ? "−" : "+"}${money(e.amount)}</span>
        </button>`);
      row.addEventListener("click", () => openPB(e));
      list.appendChild(row);
    });
    pane.replaceChildren(card, list);
  }

  // =====================================================================
  // Drill-down panels (full screen; the phone's back button closes them)
  // =====================================================================
  function panelShell(title, onAdd) {
    const d = document.createElement("dialog");
    d.className = "panel";
    d.setAttribute("aria-label", title);
    const hidden = document.documentElement.classList.contains("pv-hide");
    d.innerHTML = `<div class="panel-inner">
        <header class="subbar">
          <button type="button" class="square-btn" data-close aria-label="Back">${icon("back")}</button>
          <h1></h1>
          <button class="square-btn eye-btn" type="button" data-eye aria-pressed="${hidden}" aria-label="${hidden ? "Show" : "Hide"} amounts">${icon(hidden ? "eyeOff" : "eye")}</button>
          ${onAdd ? `<button class="square-btn add-btn-head" type="button" data-add aria-label="Add money">${icon("plus")}</button>` : ""}
        </header>
        <div class="panel-body"></div>
      </div>`;
    d.querySelector("h1").textContent = title;
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    if (onAdd) d.querySelector("[data-add]").addEventListener("click", onAdd);
    return d;
  }
  function showDialog(d, redraw) {
    document.body.appendChild(d);
    dialogs.add(d);
    if (redraw) live.add(redraw);
    d.addEventListener("close", () => { d.remove(); dialogs.delete(d); if (redraw) live.delete(redraw); });
    d.showModal();
    requestAnimationFrame(() => { const a = d.querySelector(":focus"); if (a && a.matches("input, select, textarea")) a.blur(); });
  }

  function describeTx(e, pie) {
    if (e.kind === "value") return { title: "Value updated", sub: "", amt: money0(e.value), cls: "muted" };
    if (e.type === "move") return { title: "Moved between pots", sub: `${potName(pie, e.from)} → ${potName(pie, e.to)}`, amt: money(e.amount), cls: "muted" };
    const parts = Object.entries(e.split || {}).filter(([, v]) => v);
    const usual = (pie.pots || []).filter((p) => p.usual).map((p) => [p.id, p.usual]);
    const isUsual = e.type === "deposit" && usual.length && parts.length === usual.length &&
      usual.every(([id, v]) => (e.split || {})[id] === v);
    const sub = isUsual ? "Usual split" : parts.length === 1 ? potName(pie, parts[0][0])
      : `${parts.length} pots: ${parts.map(([id]) => potName(pie, id)).join(", ")}`;
    return e.type === "deposit"
      ? { title: "Deposit", sub, amt: "+" + money(e.amount), cls: "" }
      : { title: "Withdrawal", sub, amt: "−" + money(e.amount), cls: "down" };
  }
  const newestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.kind === "value") - (a.kind === "value") || (b.at || 0) - (a.at || 0));

  function openPiePanel(pieId) {
    const pie0 = pieById(pieId);
    if (!pie0) return;
    const d = panelShell(pie0.name, () => openMoney({ pieId }));
    const body = d.querySelector(".panel-body");
    const draw = () => {
      const pie = pieById(pieId), c = calcOf(pieId);
      if (!pie || !c) { d.close(); return; }
      d.querySelector("h1").textContent = pie.name;
      const x = calcXirr(pieId);
      const card = el(`<section class="inv-card">
          <div class="inv-top">
            <div class="inv-headline"><span class="inv-label">${esc(pie.fullName || pie.name)}</span><span class="inv-big amt">${money0(c.value)}</span>
            <small class="inv-asof">${c.valueDate ? `Value as of ${niceDate(c.valueDate)}${c.stale ? " · <em>money added since</em>" : ""}` : "No value entered yet"}</small></div>
          </div>
          <div class="inv-stats">
            ${statCell("Gain", signed0(c.gain), c.paidIn > 0 ? pctText(c.gain / c.paidIn) : "", "amt " + tone(c.gain))}
            ${xirrCell(x)}
            ${statCell("Paid in", money0(c.paidIn), c.firstTx ? `since ${niceDate(c.firstTx)}` : "", "amt")}
          </div>
        </section>`);
      const pots = el(`<div class="inv-list"><div class="act-head"><span class="inv-label">Pots</span></div></div>`);
      (pie.pots || []).forEach((pot) => {
        const p = c.pots[pot.id] || { value: 0, in: 0, out: 0, gain: 0 };
        const row = el(`<button type="button" class="pot-row">
            <span class="pr-text"><b>${esc(pot.name)}</b><small><span class="amt">Paid in ${money0(p.in)}${p.out ? ` · out ${money0(p.out)}` : ""}</span>${pot.usual ? ` · ${money0(pot.usual)}/month` : ""}</small></span>
            <span class="pr-fig"><b class="amt">${money0(p.value)}</b><small class="amt ${tone(p.gain)}">${signed0(p.gain)}</small></span>
          </button>`);
        row.addEventListener("click", () => openPotPanel(pieId, pot.id));
        pots.appendChild(row);
      });
      const acts = el(`<div class="inv-activity"><div class="act-head"><span class="inv-label">Activity</span><span class="act-hint">Tap to edit</span></div></div>`);
      const mine = events.filter((e) => e.pieId === pieId).sort(newestFirst);
      if (!mine.length) acts.appendChild(el(`<p class="act-empty">Nothing yet. Tap <strong>+</strong> to add money.</p>`));
      mine.forEach((e) => {
        const t = describeTx(e, pie);
        const row = el(`<button type="button" class="act-row">
            <span class="act-date">${shortDate(e.date)}</span>
            <span class="act-text"><b>${t.title}</b>${t.sub ? `<small>${esc(t.sub)}</small>` : ""}</span>
            <span class="act-amt amt ${t.cls}">${t.amt}</span>
          </button>`);
        row.addEventListener("click", () => (e.kind === "value" ? openValueEdit(e) : openMoney({ tx: e })));
        acts.appendChild(row);
      });
      body.replaceChildren(card, pots, acts);
    };
    draw();
    showDialog(d, draw);
  }

  function openPotPanel(pieId, potId) {
    const pie0 = pieById(pieId);
    const pot0 = pie0 && (pie0.pots || []).find((p) => p.id === potId);
    if (!pot0) return;
    const d = panelShell(pot0.name, () => openMoney({ pieId }));
    const body = d.querySelector(".panel-body");
    const draw = () => {
      const pie = pieById(pieId), c = calcOf(pieId);
      const pot = pie && (pie.pots || []).find((p) => p.id === potId);
      if (!pot || !c) { d.close(); return; }
      d.querySelector("h1").textContent = pot.name;
      const p = c.pots[potId] || { value: 0, in: 0, out: 0, gain: 0 };
      const card = el(`<section class="inv-card">
          <div class="inv-headline"><span class="inv-label">In ${esc(pie.name)}${pot.usual ? ` · ${money0(pot.usual)} a month` : ""}</span><span class="inv-big amt">${money0(p.value)}</span>
          <small class="inv-asof">Its share of ${esc(pie.name)}'s value</small></div>
          <div class="inv-stats">
            ${statCell("Growth", signed0(p.gain), "", "amt " + tone(p.gain))}
            ${statCell("Paid in", money0(p.in), "", "amt")}
            ${statCell("Taken out", money0(p.out), "", "amt")}
          </div>
        </section>`);
      const acts = el(`<div class="inv-activity"><div class="act-head"><span class="inv-label">Activity</span><span class="act-hint">Tap to edit</span></div></div>`);
      const mine = events.filter((e) => e.pieId === pieId && e.kind === "tx" &&
        ((e.split && e.split[potId]) || e.from === potId || e.to === potId)).sort(newestFirst);
      if (!mine.length) acts.appendChild(el(`<p class="act-empty">No money in or out of this pot yet.</p>`));
      mine.forEach((e) => {
        let title, sub = "", amt, cls = "";
        if (e.type === "move") {
          const inbound = e.to === potId;
          title = inbound ? "Moved in" : "Moved out";
          sub = inbound ? `from ${potName(pie, e.from)}` : `to ${potName(pie, e.to)}`;
          amt = (inbound ? "+" : "−") + money(e.amount); cls = inbound ? "" : "down";
        } else {
          const part = e.split[potId];
          title = e.type === "deposit" ? "Deposit" : "Withdrawal";
          if (part !== e.amount) sub = `part of ${money(e.amount)}`;
          amt = (e.type === "deposit" ? "+" : "−") + money(part); cls = e.type === "deposit" ? "" : "down";
        }
        const row = el(`<button type="button" class="act-row">
            <span class="act-date">${shortDate(e.date)}</span>
            <span class="act-text"><b>${title}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
            <span class="act-amt amt ${cls}">${amt}</span>
          </button>`);
        row.addEventListener("click", () => openMoney({ tx: e }));
        acts.appendChild(row);
      });
      body.replaceChildren(card, acts);
    };
    draw();
    showDialog(d, draw);
  }

  // =====================================================================
  // Add / edit money: deposit, withdrawal, move between pots
  // =====================================================================
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
  function sheetShell(cls, title) {
    const d = document.createElement("dialog");
    d.className = "sheet " + cls;
    d.setAttribute("aria-label", title);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    return d;
  }

  function openMoney({ tx = null, pieId = null, type = null }) {
    const editing = !!tx;
    let lastPie = null;
    try { lastPie = sessionStorage.getItem("pv-inv-pie"); } catch {}
    const st = {
      type: tx ? tx.type : type || "deposit",
      pieId: tx ? tx.pieId : pieId || (pieById(lastPie) ? lastPie : meta.pies[0].id)
    };
    const d = sheetShell("money-sheet", editing ? "Edit" : "Add money");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${editing ? "Edit " + TYPE_NAMES[st.type].toLowerCase() : "Add money"}</h2>
        <div class="form">
          ${editing ? "" : segButtons("type", [["deposit", "Deposit"], ["withdraw", "Withdraw"], ["move", "Move pots"]], st.type)}
          <div class="two">
            ${meta.pies.length > 1 ? `<div class="fld"><span>Pie</span>${segButtons("pie", meta.pies.map((p) => [p.id, p.name]), st.pieId)}</div>`
              : `<div class="fld"><span>Pie</span><div class="pie-one">${esc(meta.pies[0].name)}</div></div>`}
            <label class="fld"><span>Date</span><input name="date" type="date" required></label>
          </div>
          <div class="move-fields two" hidden>
            <label class="fld"><span>From</span><span class="sel"><select name="from"></select>${icon("chevron")}</span></label>
            <label class="fld"><span>To</span><span class="sel"><select name="to"></select>${icon("chevron")}</span></label>
          </div>
          <div class="amount-line">
            <label class="fld"><span>Amount</span><span class="money"><i>£</i><input name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
            <button type="button" class="inv-update usual-btn" data-usual></button>
          </div>
          <div class="split-box">
            <div class="split-head"><span class="inv-label">Split into pots</span><small data-split-note></small></div>
            <div class="split-rows"></div>
            <div class="split-foot"><span data-left></span></div>
          </div>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${editing ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    const rowsEl = d.querySelector(".split-rows");
    const usualBtn = d.querySelector("[data-usual]");
    f.elements.date.value = tx ? tx.date : todayIso();
    if (tx) f.elements.amount.value = moneyInput(tx.amount);

    const pie = () => pieById(st.pieId);
    const potInputs = () => [...rowsEl.querySelectorAll("input[data-pot]")];

    function drawSplit(prefill) {
      const p = pie();
      const c = calcOf(p.id);
      const isMove = st.type === "move";
      d.querySelector(".split-box").hidden = isMove;
      d.querySelector(".move-fields").hidden = !isMove;
      const total = usualTotal(p);
      usualBtn.hidden = st.type !== "deposit" || !total;
      usualBtn.textContent = `Use usual · ${money0(total)}`;
      if (isMove) {
        const opts = (p.pots || []).map((pot) => `<option value="${pot.id}">${esc(pot.name)} (${money0((c.pots[pot.id] || {}).value || 0)})</option>`).join("");
        f.elements.from.innerHTML = opts; f.elements.to.innerHTML = opts;
        if (tx && tx.type === "move" && tx.pieId === p.id) { f.elements.from.value = tx.from; f.elements.to.value = tx.to; }
        else if ((p.pots || []).length > 1) f.elements.to.selectedIndex = 1;
        updateLeft();
        return;
      }
      d.querySelector("[data-split-note]").textContent = st.type === "deposit" ? `${p.name} pots` : "tap a balance to take it all";
      rowsEl.replaceChildren(...(p.pots || []).map((pot) => {
        const has = (c.pots[pot.id] || {}).value || 0;
        const r = el(`<div class="split-row">
            <span class="sr-name">${esc(pot.name)}</span>
            ${st.type === "deposit"
              ? `<span class="sr-hint">${pot.usual ? "usual " + money0(pot.usual) : ""}</span>`
              : `<button type="button" class="sr-hint sr-take amt">has ${money0(has)}</button>`}
            <span class="money"><i>£</i><input type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" data-pot="${pot.id}" aria-label="${esc(pot.name)}"></span>
          </div>`);
        const input = r.querySelector("input");
        if (prefill && prefill[pot.id]) input.value = moneyInput(prefill[pot.id]);
        const take = r.querySelector(".sr-take");
        if (take) take.addEventListener("click", () => { input.value = moneyInput(has); autoAmount(); updateLeft(); });
        input.addEventListener("input", () => { autoAmount(); updateLeft(); });
        return r;
      }));
      updateLeft();
    }

    // If you type pot amounts without a total (or the total was filled by
    // the app), keep the total equal to the pots so there's nothing to add up.
    let amountAuto = !tx;
    f.elements.amount.addEventListener("input", () => { amountAuto = !f.elements.amount.value.trim(); updateLeft(); });
    function autoAmount() {
      if (!amountAuto || st.type === "move") return;
      const sum = potInputs().reduce((s, i) => s + (parseMoney(i.value) || 0), 0);
      f.elements.amount.value = sum ? moneyInput(sum) : "";
    }

    function updateLeft() {
      const out = d.querySelector("[data-left]");
      out.className = "";
      if (st.type === "move") { out.textContent = ""; return; }
      const amt = parseMoney(f.elements.amount.value);
      const sum = potInputs().reduce((s, i) => s + (parseMoney(i.value) || 0), 0);
      if (amt == null) { out.textContent = sum ? `Total ${money(sum)}` : "Enter the amount, then split it"; return; }
      const left = amt - sum;
      if (left === 0 && amt > 0) { out.innerHTML = `${icon("check")}Fully allocated`; out.className = "ok"; }
      else if (left > 0) { out.textContent = `${money(left)} left to allocate`; out.className = "warn"; }
      else if (left < 0) { out.textContent = `${money(-left)} too much`; out.className = "bad"; }
      else out.textContent = "";
    }

    usualBtn.addEventListener("click", () => {
      const p = pie();
      const split = Object.fromEntries((p.pots || []).filter((x) => x.usual).map((x) => [x.id, x.usual]));
      f.elements.amount.value = moneyInput(usualTotal(p));
      amountAuto = true;
      drawSplit(split);
    });

    const usualSplit = () => Object.fromEntries((pie().pots || []).filter((x) => x.usual).map((x) => [x.id, x.usual]));
    const startFill = () => {
      if (tx && tx.pieId === st.pieId && tx.type !== "move") return tx.split || {};
      if (st.type === "deposit" && !tx) {
        const total = usualTotal(pie());
        f.elements.amount.value = total ? moneyInput(total) : "";
        amountAuto = true;
        return usualSplit();
      }
      return null;
    };

    if (!editing) wireSeg(d, "type", (v) => {
      st.type = v; err.textContent = "";
      if (v !== "deposit") { f.elements.amount.value = ""; amountAuto = v !== "move"; }
      drawSplit(startFill());
    });
    if (meta.pies.length > 1) wireSeg(d, "pie", (v) => {
      st.pieId = v; err.textContent = "";
      if (st.type !== "deposit" && !tx) f.elements.amount.value = "";
      drawSplit(startFill());
    });

    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    drawSplit(startFill());

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const p = pie(), c = calcOf(p.id);
      const date = f.elements.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = "Pick a date."; return; }
      if (date > todayIso()) { err.textContent = "The date can't be in the future."; return; }
      const amount = parseMoney(f.elements.amount.value);
      const data = { kind: "tx", type: st.type, pieId: p.id, date, at: tx && tx.at ? tx.at : Date.now() };
      // What the pot holds now, ignoring this entry if we're editing it
      const holds = (potId) => {
        let v = (c.pots[potId] || {}).value || 0;
        if (tx && tx.pieId === p.id) {
          if (tx.type === "withdraw") v += (tx.split || {})[potId] || 0;
          if (tx.type === "move" && tx.from === potId) v += tx.amount;
          if (tx.type === "move" && tx.to === potId) v -= tx.amount;
          if (tx.type === "deposit") v -= (tx.split || {})[potId] || 0;
        }
        return v;
      };

      if (st.type === "move") {
        const from = f.elements.from.value, to = f.elements.to.value;
        if (!from || !to || from === to) { err.textContent = "Pick two different pots."; return; }
        if (!amount) { err.textContent = "Enter the amount to move."; f.elements.amount.focus(); return; }
        if (amount > holds(from) + 100) {
          const ok = await confirmDialog(`${potName(p, from)} only has about ${money0(holds(from))}. Move ${money(amount)} anyway?`, "Move anyway", "Go back");
          if (!ok) return;
        }
        Object.assign(data, { amount, from, to });
      } else {
        const split = {};
        for (const i of potInputs()) {
          const t = i.value.trim();
          if (!t) continue;
          const v = parseMoney(t);
          if (v == null) { err.textContent = "One of the pot amounts isn't a valid amount."; i.focus(); return; }
          if (v) split[i.dataset.pot] = v;
        }
        const sum = Object.values(split).reduce((s, v) => s + v, 0);
        const amt = amount == null && !f.elements.amount.value.trim() ? sum : amount;
        if (amt == null) { err.textContent = "The amount isn't a valid amount."; f.elements.amount.focus(); return; }
        if (!amt) { err.textContent = "Enter the amount and split it between the pots."; return; }
        if (sum !== amt) {
          err.textContent = sum < amt ? `Split the full amount — ${money(amt - sum)} still to allocate.` : `The pots add up to ${money(sum - amt)} more than the amount.`;
          return;
        }
        if (st.type === "withdraw") {
          const short = Object.entries(split).filter(([id, v]) => v > holds(id) + 100);
          if (short.length) {
            const list = short.map(([id]) => `${potName(p, id)} has about ${money0(holds(id))}`).join("; ");
            const ok = await confirmDialog(`That's more than the pot holds (${list}). Save anyway?`, "Save anyway", "Go back");
            if (!ok) return;
          }
        }
        Object.assign(data, { amount: amt, split });
      }
      d.querySelector("[data-save]").disabled = true;
      try {
        await writeOffline(setDoc(fsDoc(investCol(), tx ? tx.id : newId()), data));
        try { sessionStorage.setItem("pv-inv-pie", p.id); } catch {}
        if (navigator.vibrate) navigator.vibrate(12);
        d.close();
      } catch (ex) {
        err.textContent = "Couldn't save: " + (ex && ex.message || ex);
        d.querySelector("[data-save]").disabled = false;
      }
    });

    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      const ok = await confirmDialog(`Delete this ${TYPE_NAMES[tx.type].toLowerCase()} of ${money(tx.amount)} on ${niceDate(tx.date)}?`, "Delete", "Keep");
      if (!ok) return;
      deleteDoc(fsDoc(investCol(), tx.id)).catch(console.error);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // Update values (all pies at once) and edit one value
  // =====================================================================
  function openValues() {
    const d = sheetShell("values-sheet", "Update values");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Update values</h2>
        <div class="form">
          <label class="fld"><span>Values as of</span><input name="date" type="date" required></label>
          <div class="value-rows">${meta.pies.map((p) => {
            const c = calcOf(p.id);
            const since = events.filter((e) => e.pieId === p.id && e.kind === "tx" && e.type !== "move" && (!c.valueDate || e.date > c.valueDate))
              .reduce((s, e) => s + (e.type === "deposit" ? e.amount : -e.amount), 0);
            const hint = c.valueDate
              ? `Last ${money0(c.valueDate ? valueOn(p.id, c.valueDate) : 0)} · ${niceDate(c.valueDate)}${since ? ` · ${signed0(since)} since` : ""}`
              : `No value yet · ${money0(c.paidIn)} paid in`;
            return `<label class="value-row"><span class="vr-text"><b>${esc(p.name)}${p.fullName ? ` <small>${esc(p.fullName)}</small>` : ""}</b><small class="amt">${hint}</small></span>
              <span class="money"><i>£</i><input type="text" inputmode="decimal" autocomplete="off" data-pie="${p.id}" aria-label="${esc(p.name)} value"></span></label>`;
          }).join("")}</div>
          <small class="tp-hint">Type what each pie shows in Trading 212 now. Leave one blank to keep its last value. A value dated the same day as a deposit is taken to include it.</small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    f.elements.date.value = todayIso();
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const date = f.elements.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = "Pick a date."; return; }
      if (date > todayIso()) { err.textContent = "The date can't be in the future."; return; }
      const writes = [];
      for (const i of d.querySelectorAll("input[data-pie]")) {
        const t = i.value.trim();
        if (!t) continue;
        const v = parseMoney(t);
        if (v == null) { err.textContent = "That isn't a valid amount."; i.focus(); return; }
        writes.push([i.dataset.pie, v]);
      }
      if (!writes.length) { err.textContent = "Enter at least one value."; return; }
      const batch = writeBatch(db);
      writes.forEach(([pieId, value]) => batch.set(fsDoc(investCol(), valueId(pieId, date)), { kind: "value", pieId, date, value, at: Date.now() }));
      d.querySelector("[data-save]").disabled = true;
      await writeOffline(batch.commit()).catch(console.error);
      d.close();
    });
    showDialog(d);
  }
  const valueOn = (pieId, date) => ((events.find((e) => e.kind === "value" && e.pieId === pieId && e.date === date)) || {}).value || 0;

  function openValueEdit(v) {
    const pie = pieById(v.pieId);
    const d = sheetShell("values-sheet", "Edit value");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>Edit value · ${esc(pie ? pie.name : "")}</h2>
        <div class="form">
          <div class="two">
            <label class="fld"><span>Date</span><input name="date" type="date" required></label>
            <label class="fld"><span>Value</span><span class="money"><i>£</i><input name="value" type="text" inputmode="decimal" autocomplete="off"></span></label>
          </div>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            <button type="button" class="btn-ghost danger" data-del>Delete</button>
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    f.elements.date.value = v.date;
    f.elements.value.value = moneyInput(v.value);
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const date = f.elements.date.value, value = parseMoney(f.elements.value.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIso()) { err.textContent = "Pick a date (not in the future)."; return; }
      if (value == null) { err.textContent = "That isn't a valid amount."; return; }
      const batch = writeBatch(db);
      if (date !== v.date) batch.delete(fsDoc(investCol(), v.id));
      batch.set(fsDoc(investCol(), valueId(v.pieId, date)), { kind: "value", pieId: v.pieId, date, value, at: Date.now() });
      await writeOffline(batch.commit()).catch(console.error);
      d.close();
    });
    d.querySelector("[data-del]").addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete the ${money0(v.value)} value from ${niceDate(v.date)}?`, "Delete", "Keep"))) return;
      deleteDoc(fsDoc(investCol(), v.id)).catch(console.error);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // Premium Bonds entry
  // =====================================================================
  function openPB(entry) {
    const editing = !!entry;
    const lastPrize = pbEntries.filter((e) => e.type === "prize").sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const st = { type: entry ? entry.type : "deposit", reinvested: entry ? !!entry.reinvested : lastPrize ? !!lastPrize.reinvested : true };
    const d = sheetShell("pb-sheet", editing ? "Edit Premium Bonds entry" : "Add Premium Bonds entry");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${editing ? "Edit" : "Add"} · Premium Bonds</h2>
        <div class="form">
          ${segButtons("type", [["deposit", "Deposit"], ["withdraw", "Withdraw"], ["prize", "Prize"]], st.type)}
          <div class="two">
            <label class="fld"><span>Date</span><input name="date" type="date" required></label>
            <label class="fld"><span>Amount</span><span class="money"><i>£</i><input name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
          </div>
          <div class="fld prize-only"><span>Prize</span>${segButtons("re", [["1", "Reinvested"], ["0", "Paid out"]], st.reinvested ? "1" : "0")}</div>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${editing ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    f.elements.date.value = entry ? entry.date : todayIso();
    if (entry) f.elements.amount.value = moneyInput(entry.amount);
    const showPrize = () => { d.querySelector(".prize-only").hidden = st.type !== "prize"; };
    wireSeg(d, "type", (v) => { st.type = v; showPrize(); });
    wireSeg(d, "re", (v) => { st.reinvested = v === "1"; });
    showPrize();
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const date = f.elements.date.value, amount = parseMoney(f.elements.amount.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIso()) { err.textContent = "Pick a date (not in the future)."; return; }
      if (!amount) { err.textContent = "Enter the amount."; f.elements.amount.focus(); return; }
      if (st.type === "withdraw") {
        const held = pbSummary(pbEntries.filter((x) => !entry || x.id !== entry.id)).held;
        if (amount > held) {
          const ok = await confirmDialog(`You only hold ${money(held)} in Premium Bonds. Save anyway?`, "Save anyway", "Go back");
          if (!ok) return;
        }
      }
      const data = { type: st.type, date, amount, reinvested: st.type === "prize" ? st.reinvested : false, at: entry && entry.at ? entry.at : Date.now() };
      d.querySelector("[data-save]").disabled = true;
      await writeOffline(setDoc(fsDoc(pbCol(), entry ? entry.id : newId()), data)).catch(console.error);
      d.close();
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete this ${entry.type === "prize" ? "prize" : entry.type === "withdraw" ? "withdrawal" : "deposit"} of ${money(entry.amount)}?`, "Delete", "Keep"))) return;
      deleteDoc(fsDoc(pbCol(), entry.id)).catch(console.error);
      d.close();
    });
    showDialog(d);
  }

  // =====================================================================
  // Settings: pies, pots, usual amounts, ISA allowance, import
  // =====================================================================
  const potInUse = (pieId, potId) => events.some((e) => e.pieId === pieId && e.kind === "tx" &&
    ((e.split && e.split[potId]) || e.from === potId || e.to === potId));
  const pieInUse = (pieId) => events.some((e) => e.pieId === pieId);

  function openSettings() {
    const d = sheetShell("inv-settings", "Investment settings");
    const draw = () => {
      d.innerHTML = `
        <div class="sheet-grip"></div>
        <h2>Investment settings</h2>
        <div class="set-pies">${(meta.pies || []).map((pie) => `
          <section class="set-pie" data-pie="${pie.id}">
            <button type="button" class="set-pie-head" data-edit-pie>
              <span><b>${esc(pie.name)}</b>${pie.fullName ? ` <small>${esc(pie.fullName)}</small>` : ""}</span>
              <span class="set-usual">${money0(usualTotal(pie))}/month</span>${icon("pen")}
            </button>
            ${(pie.pots || []).map((pot) => `<button type="button" class="set-pot" data-edit-pot="${pot.id}">
              <span>${esc(pot.name)}</span><span class="set-usual">${pot.usual ? money0(pot.usual) + "/month" : "—"}</span>${icon("pen")}</button>`).join("")}
            <button type="button" class="set-add" data-add-pot>+ Add a pot to ${esc(pie.name)}</button>
          </section>`).join("")}
        </div>
        <button type="button" class="btn-dashed set-add-pie" data-add-pie>+ Add a pie</button>
        <form class="sheet-row isa-row" data-isa>
          <div class="txt"><strong>ISA allowance</strong><small>Per tax year</small></div>
          <span class="money small"><i>£</i><input type="text" inputmode="numeric" autocomplete="off" aria-label="ISA allowance" value="${Math.round((meta.isaLimit || DEFAULT_ISA) / 100)}"></span>
        </form>
        <label class="import-link">Import from a file<input type="file" accept=".json,application/json" hidden></label>
        <div class="sheet-buttons"><button type="button" class="btn-ghost" data-done>Done</button></div>`;
      d.querySelectorAll(".set-pie").forEach((sec) => {
        const pie = pieById(sec.dataset.pie);
        sec.querySelector("[data-edit-pie]").addEventListener("click", () => editPie(pie));
        sec.querySelector("[data-add-pot]").addEventListener("click", () => editPot(pie, null));
        sec.querySelectorAll("[data-edit-pot]").forEach((b) => b.addEventListener("click", () =>
          editPot(pie, pie.pots.find((p) => p.id === b.dataset.editPot))));
      });
      d.querySelector("[data-add-pie]").addEventListener("click", () => editPie(null));
      const isa = d.querySelector("[data-isa]");
      const isaInput = isa.querySelector("input");
      const saveIsa = () => {
        const v = parseMoney(isaInput.value);
        if (v == null || !v) { isaInput.value = Math.round((meta.isaLimit || DEFAULT_ISA) / 100); return; }
        if (v !== meta.isaLimit) saveMeta({ ...meta, isaLimit: v });
      };
      isa.addEventListener("submit", (e) => { e.preventDefault(); isaInput.blur(); });
      isaInput.addEventListener("change", saveIsa);
      hookImport(d, () => d.close());
      d.querySelector("[data-done]").addEventListener("click", () => d.close());
    };
    draw();
    // Redraw when data changes, unless you're typing in the ISA box
    showDialog(d, () => { if (!d.contains(document.activeElement) || !document.activeElement.matches("input")) draw(); });
  }

  function smallForm(title, fieldsHtml, { onSave, onDelete, deleteNote }) {
    const d = document.createElement("dialog");
    d.className = "pv-dialog set-form";
    d.innerHTML = `<form method="dialog" novalidate class="form">
        <h2></h2>${fieldsHtml}
        ${deleteNote ? `<small class="tp-hint">${deleteNote}</small>` : ""}
        <p class="form-err" role="alert"></p>
        <div class="sheet-buttons">
          ${onDelete ? `<button type="button" class="btn-ghost danger" data-del>Delete</button>` : ""}
          <button type="button" class="btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn">Save</button>
        </div></form>`;
    d.querySelector("h2").textContent = title;
    const f = d.querySelector("form");
    const err = d.querySelector(".form-err");
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = onSave(f);
      if (msg) { err.textContent = msg; return; }
      d.close();
    });
    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => { if (await onDelete()) d.close(); });
    showDialog(d);
    return f;
  }

  function editPie(pie) {
    const f = smallForm(pie ? "Edit pie" : "Add a pie", `
      <label class="fld"><span>Name (short, e.g. LTP)</span><input name="name" type="text" autocomplete="off" maxlength="24"></label>
      <label class="fld"><span>Full name (optional)</span><input name="fullName" type="text" autocomplete="off" maxlength="40"></label>`, {
      onSave: (f) => {
        const name = f.elements.name.value.trim(), fullName = f.elements.fullName.value.trim();
        if (!name) return "Enter a name.";
        if (meta.pies.some((p) => p !== pie && p.name.toLowerCase() === name.toLowerCase())) return "You already have a pie with that name.";
        const pies = pie ? meta.pies.map((p) => (p.id === pie.id ? { ...p, name, fullName } : p))
          : [...meta.pies, { id: newId(), name, fullName, pots: [] }];
        saveMeta({ ...meta, pies });
      },
      onDelete: pie && !pieInUse(pie.id) ? async () => {
        if (!(await confirmDialog(`Delete ${pie.name} and its pots?`, "Delete", "Keep"))) return false;
        saveMeta({ ...meta, pies: meta.pies.filter((p) => p.id !== pie.id) });
        return true;
      } : null,
      deleteNote: pie && pieInUse(pie.id) ? "Pies with money recorded can be renamed but not deleted." : ""
    });
    if (pie) { f.elements.name.value = pie.name; f.elements.fullName.value = pie.fullName || ""; }
  }

  function editPot(pie, pot) {
    const f = smallForm(pot ? `Edit pot · ${pie.name}` : `Add a pot to ${pie.name}`, `
      <label class="fld"><span>Name</span><input name="name" type="text" autocomplete="off" maxlength="30"></label>
      <label class="fld"><span>Usual monthly amount (blank if not paying in)</span><span class="money"><i>£</i><input name="usual" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>`, {
      onSave: (f) => {
        const name = f.elements.name.value.trim();
        const t = f.elements.usual.value.trim();
        const usual = t ? parseMoney(t) : 0;
        if (!name) return "Enter a name.";
        if (usual == null) return "The usual amount isn't a valid amount.";
        if ((pie.pots || []).some((p) => p !== pot && p.name.toLowerCase() === name.toLowerCase())) return `${pie.name} already has a pot with that name.`;
        const pots = pot ? pie.pots.map((p) => (p.id === pot.id ? { ...p, name, usual } : p)) : [...(pie.pots || []), { id: newId(), name, usual }];
        saveMeta({ ...meta, pies: meta.pies.map((p) => (p.id === pie.id ? { ...p, pots } : p)) });
      },
      onDelete: pot && !potInUse(pie.id, pot.id) ? async () => {
        if (!(await confirmDialog(`Delete the ${pot.name} pot?`, "Delete", "Keep"))) return false;
        saveMeta({ ...meta, pies: meta.pies.map((p) => (p.id === pie.id ? { ...p, pots: p.pots.filter((x) => x.id !== pot.id) } : p)) });
        return true;
      } : null,
      deleteNote: pot && potInUse(pie.id, pot.id) ? "Pots with money recorded can be renamed but not deleted." : ""
    });
    if (pot) { f.elements.name.value = pot.name; f.elements.usual.value = pot.usual ? moneyInput(pot.usual) : ""; }
  }

  // =====================================================================
  // Import from a file (kept off GitHub — it's your data)
  // =====================================================================
  // {
  //   "pies": [ { "name": "LTP", "fullName": "Long Term Pie", "pots": [ { "name": "Car", "usual": 180 } ] } ],
  //   "isaLimit": 20000,
  //   "transactions": [
  //     { "date": "2026-08-28", "pie": "LTP", "type": "deposit", "amount": 415, "split": { "Car": 180, ... } },
  //     { "date": "2026-08-30", "pie": "LTP", "type": "withdraw", "amount": 250, "split": { "Car": 250 } },
  //     { "date": "2026-09-01", "pie": "STP", "type": "move", "amount": 50, "from": "Livs Phone", "to": "Our Phones" } ],
  //   "values": [ { "date": "2026-09-27", "pie": "LTP", "value": 8215.43 } ],
  //   "premiumBonds": [ { "date": "2026-09-01", "type": "prize", "amount": 25, "reinvested": true } ]
  // }
  // Amounts are in pounds. Pies and pots are matched by name; new ones are added.
  // Importing the same file twice doesn't create duplicates.
  function hookImport(scope, before) {
    const input = scope.querySelector(".import-link input");
    if (!input) return;
    input.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (before) before();
      importFile(file);
    });
  }

  function hashId(prefix, obj) {
    const s = JSON.stringify(obj);
    let h1 = 0x811c9dc5, h2 = 0x1234567;
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
      h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519);
    }
    return prefix + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  async function importFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    } catch {
      await confirmDialog("That file isn't a PocketVault investments file, so nothing was imported.", "OK", null, "Import");
      return;
    }
    const p2p = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v * 100) : null);
    const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const pies = JSON.parse(JSON.stringify(meta.pies || []));
    let newPies = 0, newPots = 0, skipped = 0;
    const findPie = (name) => pies.find((p) => p.name.toLowerCase() === String(name || "").trim().toLowerCase() ||
      (p.fullName && p.fullName.toLowerCase() === String(name || "").trim().toLowerCase()));
    const findPot = (pie, name, create) => {
      const n = String(name || "").trim();
      if (!n) return null;
      let pot = pie.pots.find((p) => p.name.toLowerCase() === n.toLowerCase());
      if (!pot && create) { pot = { id: newId(), name: n, usual: 0 }; pie.pots.push(pot); newPots++; }
      return pot;
    };
    for (const fp of Array.isArray(data.pies) ? data.pies : []) {
      const name = String(fp.name || "").trim();
      if (!name) continue;
      let pie = findPie(name);
      if (!pie) { pie = { id: newId(), name, fullName: String(fp.fullName || "").trim(), pots: [] }; pies.push(pie); newPies++; }
      else if (fp.fullName) pie.fullName = String(fp.fullName).trim();
      pie.pots = pie.pots || [];
      for (const fpot of Array.isArray(fp.pots) ? fp.pots : []) {
        const pot = findPot(pie, fpot.name, true);
        if (pot && fpot.usual != null && p2p(fpot.usual) != null) pot.usual = p2p(fpot.usual);
      }
    }
    const docs = [];
    for (const t of Array.isArray(data.transactions) ? data.transactions : []) {
      const pie = findPie(t.pie);
      const amount = p2p(t.amount);
      if (!pie || !isDate(t.date) || !amount || !["deposit", "withdraw", "move"].includes(t.type)) { skipped++; continue; }
      const base = { kind: "tx", type: t.type, pieId: pie.id, date: t.date, amount };
      if (t.type === "move") {
        const from = findPot(pie, t.from, true), to = findPot(pie, t.to, true);
        if (!from || !to || from === to) { skipped++; continue; }
        Object.assign(base, { from: from.id, to: to.id });
      } else {
        const split = {};
        let ok = true;
        for (const [n, v] of Object.entries(t.split || {})) {
          const pot = findPot(pie, n, true), pv = p2p(v);
          if (!pot || pv == null) { ok = false; break; }
          if (pv) split[pot.id] = (split[pot.id] || 0) + pv;
        }
        if (!ok || Object.values(split).reduce((s, v) => s + v, 0) !== amount) { skipped++; continue; }
        base.split = split;
      }
      docs.push([investCol(), hashId("imp_", { ...t, pie: pie.id }), { ...base, at: Date.parse(t.date + "T12:00:00Z") + docs.length }]);
    }
    let values = 0;
    for (const v of Array.isArray(data.values) ? data.values : []) {
      const pie = findPie(v.pie), value = p2p(v.value);
      if (!pie || !isDate(v.date) || value == null) { skipped++; continue; }
      docs.push([investCol(), valueId(pie.id, v.date), { kind: "value", pieId: pie.id, date: v.date, value, at: Date.parse(v.date + "T23:00:00Z") }]);
      values++;
    }
    let pbs = 0;
    for (const b of Array.isArray(data.premiumBonds) ? data.premiumBonds : []) {
      const amount = p2p(b.amount);
      if (!isDate(b.date) || !amount || !["deposit", "withdraw", "prize"].includes(b.type)) { skipped++; continue; }
      docs.push([pbCol(), hashId("imp_", b), { type: b.type, date: b.date, amount, reinvested: b.type === "prize" ? !!b.reinvested : false, at: Date.parse(b.date + "T12:00:00Z") + pbs }]);
      pbs++;
    }
    const txs = docs.length - values - pbs;
    const parts = [];
    if (newPies) parts.push(`${newPies} pie${newPies > 1 ? "s" : ""}`);
    if (newPots) parts.push(`${newPots} pot${newPots > 1 ? "s" : ""}`);
    if (txs) parts.push(`${txs} transaction${txs > 1 ? "s" : ""}`);
    if (values) parts.push(`${values} value${values > 1 ? "s" : ""}`);
    if (pbs) parts.push(`${pbs} Premium Bonds entr${pbs > 1 ? "ies" : "y"}`);
    const isaLimit = p2p(data.isaLimit);
    if (!parts.length && isaLimit == null) {
      await confirmDialog("Nothing to import was found in that file." + (skipped ? ` ${skipped} row${skipped > 1 ? "s" : ""} couldn't be read.` : ""), "OK", null, "Import");
      return;
    }
    const msg = (parts.length ? `Add ${parts.join(", ")}?` : "Update your settings?") +
      (skipped ? ` ${skipped} row${skipped > 1 ? "s" : ""} couldn't be read and will be left out (check dates, names, and that each split adds up).` : "") +
      " Anything already imported from this file is replaced, not doubled.";
    if (!(await confirmDialog(msg, "Import", "Cancel", "Import investments"))) return;
    const newMeta = { ...meta, pies };
    if (isaLimit) newMeta.isaLimit = isaLimit;
    // Firestore takes up to 500 changes at once
    const all = [[null, null, newMeta], ...docs];
    for (let i = 0; i < all.length; i += 400) {
      const batch = writeBatch(db);
      all.slice(i, i + 400).forEach(([c, id, v]) => batch.set(c ? fsDoc(c, id) : investMeta(), v));
      writeOffline(batch.commit()).catch(console.error);
    }
  }

  // Leaving Investments: stop live updates and close anything open
  return () => {
    stops.forEach((s) => { try { s(); } catch {} });
    stops = [];
    [...dialogs].forEach((d) => { try { d.close(); } catch {} });
  };
}
