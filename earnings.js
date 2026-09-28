// earnings.js — the Earnings mini app
// One gross (before tax) amount per month, in whole pounds, grouped into
// UK tax years (April to March). Updates live and works offline.

import { confirmDialog, db } from "./app.js";
import {
  onSnapshot, setDoc, deleteDoc, writeBatch, doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  earningsCol, monthId, MONTH_NAMES, MONTH_SHORT,
  taxYearOf, currentTaxYear, taxYearLabel, monthsOfTaxYear, summarise, pounds, parsePounds
} from "./earnings-data.js";

export function mount(root, { open }) {
  const $ = (sel) => root.querySelector(sel);
  const icon = (n) => window.PV.icon(n);
  const thisTY = currentTaxYear();
  let ty = thisTY;
  let entries = [];        // { year, month, amount }
  let loaded = false;
  let stop = null;
  let openSheet = null;

  const entryDoc = (year, month) => fsDoc(earningsCol(), monthId(year, month));
  const findEntry = (year, month) => entries.find((e) => e.year === year && e.month === month);
  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);

  open.then(() => {
    stop = onSnapshot(earningsCol(), (snap) => {
      entries = snap.docs.map((d) => d.data()).filter((e) => e && e.year && e.month);
      loaded = true;
      render();
    }, (e) => {
      $("[data-months]").innerHTML = `<p class="bills-loading">Couldn't load your earnings.</p>`;
      console.error(e);
    });
  });

  // ---------- Year arrows ----------
  const earliestTY = () => Math.min(thisTY, ...entries.map((e) => taxYearOf(e.year, e.month)));
  $("[data-ty-prev]").addEventListener("click", () => { if (ty > earliestTY()) { ty--; render(); } });
  $("[data-ty-next]").addEventListener("click", () => { if (ty < thisTY) { ty++; render(); } });

  // ---------- Drawing ----------
  function render() {
    if (!loaded) return;
    const first = monthsOfTaxYear(ty)[0], last = monthsOfTaxYear(ty)[11];
    $("[data-ty-name]").textContent = `Tax year ${ty}/${String(ty + 1).slice(2)}`;
    $("[data-ty-sub]").textContent = `April ${first.year} – March ${last.year} · Gross`;
    $("[data-ty-prev]").disabled = ty <= earliestTY();
    $("[data-ty-next]").disabled = ty >= thisTY;

    // Stats
    const s = summarise(entries, ty);
    const stat = (label, value, sub, brass) => {
      const el = document.createElement("div");
      el.className = "pot" + (brass ? " brass" : "");
      el.innerHTML = `<span class="pot-name"></span><span class="pot-left amt"></span><span class="pot-sub"></span>`;
      el.querySelector(".pot-name").textContent = label;
      el.querySelector(".pot-left").textContent = value;
      el.querySelector(".pot-sub").textContent = sub;
      return el;
    };
    $("[data-stats]").replaceChildren(
      stat(s.complete ? "Year total" : "So far", pounds(s.total), `${s.count} of 12 months`),
      stat("Monthly avg", pounds(s.average), s.count ? "per month entered" : "no months yet"),
      s.complete
        ? stat("Full year", pounds(s.total), "complete", true)
        : stat("Projected", s.count ? pounds(s.projected) : "—", "full year", true)
    );

    // Months, April first
    const now = new Date();
    const nowKey = now.getFullYear() * 12 + now.getMonth() + 1;
    const max = Math.max(1, ...monthsOfTaxYear(ty).map(({ year, month }) => (findEntry(year, month) || {}).amount || 0));
    const list = $("[data-months]");
    list.replaceChildren(...monthsOfTaxYear(ty).map(({ year, month }) => {
      const e = findEntry(year, month);
      const future = year * 12 + month > nowKey;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "month-row" + (future && !e ? " future" : "");
      row.innerHTML = `<span class="m-name"><b></b><small></small></span><span class="m-bar"><i></i></span><span class="m-amt"></span>`;
      row.querySelector(".m-name b").textContent = MONTH_SHORT[month - 1];
      row.querySelector(".m-name small").textContent = String(year).slice(2);
      const amt = row.querySelector(".m-amt");
      if (e) {
        row.querySelector(".m-bar i").style.width = `${Math.round((e.amount / max) * 100)}%`;
        amt.textContent = pounds(e.amount);
        amt.classList.add("amt");
        row.setAttribute("aria-label", `${MONTH_NAMES[month - 1]} ${year}: ${pounds(e.amount)}. Edit`);
        row.addEventListener("click", () => openEntry({ year, month, amount: e.amount }));
      } else if (!future) {
        row.classList.add("missing");
        amt.textContent = "+ Add";
        row.setAttribute("aria-label", `Add ${MONTH_NAMES[month - 1]} ${year}`);
        row.addEventListener("click", () => openEntry({ year, month }, true));
      } else {
        amt.textContent = "—";
        row.disabled = true;
      }
      return row;
    }));

    // Import link when there's nothing yet
    const foot = $("[data-foot]");
    foot.innerHTML = entries.length ? "" :
      `<label class="import-link">Import earlier months from a file<input type="file" accept=".json,application/json" hidden></label>`;
    const input = foot.querySelector("input");
    if (input) input.addEventListener("change", (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (f) importEarnings(f);
    });
  }

  // ---------- Add / edit pop-up ----------
  $("[data-add-earning]").addEventListener("click", () => {
    if (!loaded) return;
    // Default: this month, or the latest month of the year you're viewing
    const now = new Date();
    const inView = ty === thisTY ? { year: now.getFullYear(), month: now.getMonth() + 1 } : monthsOfTaxYear(ty)[11];
    openEntry(inView, true);
  });

  function openEntry(start, isNew = !findEntry(start.year, start.month)) {
    const years = [];
    for (let y = thisTY + 1; y >= Math.min(earliestTY(), thisTY - 6); y--) years.push(y);
    const monthOrder = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]; // April first
    const d = document.createElement("dialog");
    d.className = "sheet earn-sheet";
    d.setAttribute("aria-label", isNew ? "Add earnings" : "Edit earnings");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${isNew ? "Add earnings" : "Edit earnings"}</h2>
        <div class="form">
          <div class="two">
            <label class="fld"><span>Month</span><span class="sel"><select name="month">${monthOrder.map((m) => `<option value="${m}"${m === start.month ? " selected" : ""}>${MONTH_NAMES[m - 1]}</option>`).join("")}</select>${icon("chevron")}</span></label>
            <label class="fld"><span>Year</span><span class="sel"><select name="year">${years.map((y) => `<option value="${y}"${y === start.year ? " selected" : ""}>${y}</option>`).join("")}</select>${icon("chevron")}</span></label>
          </div>
          <label class="fld"><span>Amount (Gross, whole pounds)</span><span class="money"><i>£</i><input name="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="0"></span></label>
          <small class="tp-hint" data-which></small>
          <p class="form-err" role="alert"></p>
          <div class="sheet-buttons">
            ${isNew ? "" : `<button type="button" class="btn-ghost danger" data-del>Delete</button>`}
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn" data-save>Save</button>
          </div>
        </div>
      </form>`;
    root.appendChild(d);
    const f = d.querySelector("form");
    if (start.amount != null) f.elements.amount.value = start.amount.toLocaleString("en-GB");
    const which = d.querySelector("[data-which]");
    const err = d.querySelector(".form-err");
    const showWhich = () => {
      const y = Number(f.elements.year.value), m = Number(f.elements.month.value);
      const existing = findEntry(y, m);
      const moved = !isNew && (y !== start.year || m !== start.month);
      which.textContent = `Counts towards tax year ${taxYearLabel(taxYearOf(y, m))}.` +
        (existing && (isNew || moved) ? ` ${MONTH_NAMES[m - 1]} ${y} already has ${pounds(existing.amount)} — saving replaces it.` : "");
    };
    f.elements.year.addEventListener("change", showWhich);
    f.elements.month.addEventListener("change", showWhich);
    showWhich();

    const close = () => d.close();
    d.addEventListener("close", () => { d.remove(); if (openSheet === d) openSheet = null; });
    d.querySelector("[data-cancel]").addEventListener("click", close);
    d.addEventListener("click", (e) => { if (e.target === d) close(); });

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const year = Number(f.elements.year.value), month = Number(f.elements.month.value);
      const amount = parsePounds(f.elements.amount.value);
      if (amount == null) {
        err.textContent = /[.]/.test(f.elements.amount.value) ? "Whole pounds only — no pence." : "Enter the amount, e.g. 4300";
        f.elements.amount.focus();
        return;
      }
      const moved = !isNew && (year !== start.year || month !== start.month);
      d.querySelector("[data-save]").disabled = true;
      try {
        if (moved) {
          const batch = writeBatch(db);
          batch.delete(entryDoc(start.year, start.month));
          batch.set(entryDoc(year, month), { year, month, amount });
          await writeOffline(batch.commit());
        } else {
          await writeOffline(setDoc(entryDoc(year, month), { year, month, amount }));
        }
        ty = taxYearOf(year, month); // show the year you just saved into
        render();
        close();
      } catch (ex) {
        err.textContent = "Couldn't save: " + (ex && ex.message || ex);
        d.querySelector("[data-save]").disabled = false;
      }
    });

    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      const ok = await confirmDialog(`Delete ${MONTH_NAMES[start.month - 1]} ${start.year} (${pounds(start.amount)})?`, "Delete", "Keep");
      if (!ok) return;
      deleteDoc(entryDoc(start.year, start.month)).catch(console.error);
      close();
    });

    openSheet = d;
    d.showModal();
    requestAnimationFrame(() => { const a = d.querySelector(":focus"); if (a) a.blur(); });
  }

  // ---------- Import earlier months from a file ----------
  // File: { entries: [ { year, month, amount } ] }. Months already there are replaced.
  async function importEarnings(file) {
    let rows;
    try {
      const data = JSON.parse(await file.text());
      rows = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(rows) || !rows.length) throw new Error();
    } catch {
      await confirmDialog("That file isn't a PocketVault earnings file, so nothing was imported.", "OK", null, "Import");
      return;
    }
    const clean = rows.map((r) => ({ year: Number(r.year), month: Number(r.month), amount: Number(r.amount) }))
      .filter((r) => r.year > 1990 && r.year < 2200 && r.month >= 1 && r.month <= 12 && Number.isInteger(r.amount) && r.amount >= 0);
    if (!clean.length) { await confirmDialog("No valid months were found in that file.", "OK", null, "Import"); return; }
    const years = [...new Set(clean.map((r) => taxYearOf(r.year, r.month)))].sort().map(taxYearLabel);
    const replacing = clean.filter((r) => findEntry(r.year, r.month)).length;
    const ok = await confirmDialog(
      `Add ${clean.length} months across tax years ${years.join(", ")}?` + (replacing ? ` ${replacing} month${replacing > 1 ? "s" : ""} already entered will be replaced.` : ""),
      "Import", "Cancel", "Import earnings");
    if (!ok) return;
    const batch = writeBatch(db);
    clean.forEach((r) => batch.set(entryDoc(r.year, r.month), r));
    writeOffline(batch.commit()).catch(console.error);
  }

  // Leaving Earnings: stop live updates and close any open pop-up
  return () => {
    if (stop) { try { stop(); } catch {} }
    if (openSheet && openSheet.open) openSheet.close();
  };
}
