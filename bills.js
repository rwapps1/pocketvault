// bills.js — the Bills mini app
//
// Everything updates live from Firestore (and works offline: changes made
// without signal sync later). Amounts are stored in pence.

import { confirmDialog } from "./app.js";
import {
  onSnapshot, setDoc, updateDoc, addDoc, deleteDoc, writeBatch, deleteField, serverTimestamp,
  doc as fsDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./app.js";
import {
  billsCol, billsMeta, defaultMeta, newListItem,
  periodStartFor, periodLabel, isoDate, sortBills, ordinal, periodPos,
  amountThisPeriod, money, parseMoney, moneyInput
} from "./bills-data.js";

const LISTS = [
  { key: "purposes", label: "Purpose", field: "purposeId", add: "Add a purpose…" },
  { key: "types", label: "Payment type", field: "typeId", add: "Add a payment type…" },
  { key: "pots", label: "Pot", field: "potId", add: "Add a pot…" }
];

export function mount(root, { open }) {
  const $ = (sel) => root.querySelector(sel);
  const icon = (n) => window.PV.icon(n);
  let bills = [];
  let meta = null;
  let metaLoaded = false, billsLoaded = false;
  let stops = [];
  let openSheet = null;      // a pop-up that's open, closed if we leave Bills
  let redrawSettings = null; // redraws the settings pop-up while it's open

  $("[data-period]").textContent = periodLabel();

  open.then(() => {
    // Your lists + last reset
    stops.push(onSnapshot(billsMeta(), (snap) => {
      if (!snap.exists()) {
        // First time: create the starting lists; this period counts as started.
        setDoc(billsMeta(), defaultMeta(isoDate(periodStartFor())));
        return;
      }
      meta = snap.data();
      metaLoaded = true;
      render();
      maybePromptNewPeriod();
    }, showError));
    // The bills themselves
    stops.push(onSnapshot(billsCol(), (snap) => {
      bills = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      billsLoaded = true;
      render();
    }, showError));
  });

  // ---------- Drawing the screen ----------
  function nameOf(listKey, itemId) {
    const item = meta && (meta[listKey] || []).find((i) => i.id === itemId);
    return item ? item.name : "—";
  }

  function render() {
    if (!metaLoaded || !billsLoaded) return;
    if (redrawSettings) redrawSettings(); // keep an open settings pop-up in step
    const sorted = sortBills(bills);
    const paid = sorted.filter((b) => b.paid).length;
    $("[data-paid-count]").textContent = sorted.length ? `${paid} of ${sorted.length} paid` : "";

    // Left to pay per pot
    const pots = $("[data-pots]");
    pots.replaceChildren(...(meta.pots || []).map((p) => {
      const left = sorted.filter((b) => b.potId === p.id && !b.paid)
        .reduce((sum, b) => sum + amountThisPeriod(b), 0);
      const el = document.createElement("div");
      el.className = "pot";
      el.innerHTML = `<span class="pot-name"></span><span class="pot-left amt"></span><span class="pot-sub">left to pay</span>`;
      el.querySelector(".pot-name").textContent = p.name;
      el.querySelector(".pot-left").textContent = money(left);
      if (left === 0) el.classList.add("clear");
      return el;
    }));

    // The list
    const list = $("[data-list]");
    if (!sorted.length) {
      list.innerHTML = `<div class="bills-empty"><p>No bills yet.</p><p>Tap <strong>+</strong> to add your first one.</p></div>`;
      return;
    }
    list.replaceChildren(...sorted.map(rowFor));
  }

  function rowFor(b) {
    const row = document.createElement("div");
    row.className = "bill-row" + (b.paid ? " paid" : "");
    const changed = Number.isInteger(b.periodAmount) && b.periodAmount !== b.usualAmount;
    row.innerHTML = `
      <button type="button" class="bill-main" aria-label="Edit">
        <span class="bill-day"><b></b><small></small></span>
        <span class="bill-text">
          <span class="bill-name"><span class="n"></span></span>
          <span class="bill-meta"></span>
        </span>
        <span class="bill-amount">
          <span class="a amt"></span>
        </span>
      </button>
      <button type="button" class="paid-toggle" role="switch" aria-checked="${b.paid ? "true" : "false"}"><span></span></button>`;
    row.querySelector(".bill-day b").textContent = b.dueDay;
    row.querySelector(".bill-day small").textContent = ordinal(b.dueDay);
    row.querySelector(".bill-name .n").textContent = b.company;
    if (b.note) {
      const n = document.createElement("span");
      n.className = "bill-note"; n.innerHTML = icon("note"); n.title = b.note;
      row.querySelector(".bill-name").appendChild(n);
    }
    row.querySelector(".bill-meta").textContent = `${nameOf("types", b.typeId)} · ${nameOf("pots", b.potId)}`;
    row.querySelector(".bill-amount .a").textContent = money(amountThisPeriod(b));
    if (changed) {
      const u = document.createElement("span");
      u.className = "usual amt"; u.textContent = `usual ${money(b.usualAmount)}`;
      row.querySelector(".bill-amount").appendChild(u);
    }
    const toggle = row.querySelector(".paid-toggle");
    toggle.setAttribute("aria-label", `${b.company} paid`);
    toggle.addEventListener("click", () => {
      const now = !b.paid;
      toggle.setAttribute("aria-checked", String(now));
      row.classList.toggle("paid", now);
      if (now && navigator.vibrate) navigator.vibrate(12);
      updateDoc(billDoc(b.id), { paid: now }).catch(showError);
    });
    row.querySelector(".bill-main").addEventListener("click", () => editBill(b));
    return row;
  }

  function showError(e) {
    console.error(e);
    const list = $("[data-list]");
    if (list) list.innerHTML = `<div class="bills-empty"><p>Couldn't load your bills.</p><p class="err-detail"></p></div>`;
    const d = list && list.querySelector(".err-detail");
    if (d) d.textContent = String(e && e.message || e);
  }

  // ---------- Add / edit pop-up ----------
  $("[data-add-bill]").addEventListener("click", () => metaLoaded && editBill(null));

  function options(listKey, selectedId) {
    return (meta[listKey] || []).map((i) =>
      `<option value="${i.id}"${i.id === selectedId ? " selected" : ""}></option>`).join("");
  }
  function fillOptionText(sel, listKey) {
    [...sel.options].forEach((o) => {
      const item = (meta[listKey] || []).find((i) => i.id === o.value);
      if (item) o.textContent = item.name;
    });
  }

  function editBill(b) {
    const isNew = !b;
    const bill = b || {
      company: "", purposeId: (meta.purposes[0] || {}).id, typeId: (meta.types[0] || {}).id,
      potId: (meta.pots[0] || {}).id, dueDay: 28, usualAmount: null, note: "", paid: false, periodAmount: null
    };
    const days = [];
    for (let i = 0; i < 31; i++) days.push(((27 + i) % 31) + 1); // 28 … 31, 1 … 27
    const d = document.createElement("dialog");
    d.className = "sheet bill-sheet";
    d.setAttribute("aria-label", isNew ? "Add bill" : "Edit bill");
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="sheet-grip"></div>
        <h2>${isNew ? "Add bill" : "Edit bill"}</h2>
        <div class="form">
          <label class="fld"><span>Company</span><input name="company" type="text" autocomplete="off" required></label>
          <div class="two">
            <label class="fld"><span>Purpose</span><span class="sel"><select name="purposeId">${options("purposes", bill.purposeId)}</select>${icon("chevron")}</span></label>
            <label class="fld"><span>Due day</span><span class="sel"><select name="dueDay">${days.map((n) => `<option value="${n}"${n === bill.dueDay ? " selected" : ""}>${n}${ordinal(n)}</option>`).join("")}</select>${icon("chevron")}</span></label>
          </div>
          <div class="two">
            <label class="fld"><span>Payment type</span><span class="sel"><select name="typeId">${options("types", bill.typeId)}</select>${icon("chevron")}</span></label>
            <label class="fld"><span>Pot</span><span class="sel"><select name="potId">${options("pots", bill.potId)}</select>${icon("chevron")}</span></label>
          </div>
          <label class="fld"><span>Usual amount</span><span class="money"><i>£</i><input name="usual" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></span></label>
          <label class="fld"><span>Note</span><textarea name="note" rows="2"></textarea></label>
          <div class="this-period">
            <span class="tp-label">This period only</span>
            <label class="tp-row"><span>Amount this period</span><span class="money small"><i>£</i><input name="period" type="text" inputmode="decimal" autocomplete="off" placeholder="same"></span></label>
            <div class="tp-row"><span>Paid</span><button type="button" class="paid-toggle" role="switch" aria-label="Paid" aria-checked="${bill.paid ? "true" : "false"}"><span></span></button></div>
            <small class="tp-hint"></small>
          </div>
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
    ["purposes", "types", "pots"].forEach((k, i) => fillOptionText(f.elements[["purposeId", "typeId", "potId"][i]], k));
    f.elements.company.value = bill.company;
    f.elements.usual.value = moneyInput(bill.usualAmount);
    f.elements.note.value = bill.note || "";
    const hasOverride = Number.isInteger(bill.periodAmount) && bill.periodAmount !== bill.usualAmount;
    f.elements.period.value = hasOverride ? moneyInput(bill.periodAmount) : "";
    let paid = !!bill.paid;
    const paidBtn = d.querySelector(".this-period .paid-toggle");
    paidBtn.addEventListener("click", () => { paid = !paid; paidBtn.setAttribute("aria-checked", String(paid)); });

    const hint = d.querySelector(".tp-hint");
    const updateHint = () => {
      const usual = parseMoney(f.elements.usual.value);
      hint.textContent = usual == null
        ? "Leave blank to use the usual amount."
        : `Leave blank to use ${money(usual)}. A different amount goes back to ${money(usual)} when you start a new period.`;
    };
    f.elements.usual.addEventListener("input", updateHint); updateHint();

    const close = () => { d.close(); };
    d.addEventListener("close", () => { d.remove(); if (openSheet === d) openSheet = null; });
    d.querySelector("[data-cancel]").addEventListener("click", close);
    d.addEventListener("click", (e) => { if (e.target === d) close(); });
    const err = d.querySelector(".form-err");

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const company = f.elements.company.value.trim();
      const usual = parseMoney(f.elements.usual.value);
      const periodText = f.elements.period.value.trim();
      const period = periodText ? parseMoney(periodText) : null;
      if (!company) { err.textContent = "Enter the company name."; f.elements.company.focus(); return; }
      if (usual == null) { err.textContent = "Enter the usual amount, e.g. 150.00"; f.elements.usual.focus(); return; }
      if (periodText && period == null) { err.textContent = "The amount this period isn't a valid amount."; f.elements.period.focus(); return; }
      const data = {
        company,
        purposeId: f.elements.purposeId.value || null,
        typeId: f.elements.typeId.value || null,
        potId: f.elements.potId.value || null,
        dueDay: Number(f.elements.dueDay.value),
        usualAmount: usual,
        note: f.elements.note.value.trim(),
        paid
      };
      const override = period != null && period !== usual ? period : null;
      d.querySelector("[data-save]").disabled = true;
      try {
        if (isNew) {
          await addDocOffline(billsCol(), { ...data, periodAmount: override, createdAt: serverTimestamp() });
        } else {
          await writeOffline(updateDoc(billDoc(bill.id), { ...data, periodAmount: override === null ? deleteField() : override }));
        }
        close();
      } catch (ex) {
        err.textContent = "Couldn't save: " + (ex && ex.message || ex);
        d.querySelector("[data-save]").disabled = false;
      }
    });

    const del = d.querySelector("[data-del]");
    if (del) del.addEventListener("click", async () => {
      const ok = await confirmDialog(`Delete ${bill.company}? This can't be undone.`, "Delete", "Keep");
      if (!ok) return;
      deleteDoc(billDoc(bill.id)).catch(showError);
      close();
    });

    openSheet = d;
    d.showModal();
    if (isNew) f.elements.company.focus();
  }

  // Firestore only confirms a write once it reaches the server; offline we
  // don't want to wait, so a short wait is treated as "saved on the phone".
  const writeOffline = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 600))]);
  const addDocOffline = (c, data) => writeOffline(addDoc(c, data));

  // ---------- Bill settings (your lists) ----------
  $("[data-bills-settings]").addEventListener("click", () => metaLoaded && openSettings());

  function openSettings() {
    let tab = 0;
    const d = document.createElement("dialog");
    d.className = "sheet lists-sheet";
    d.setAttribute("aria-label", "Bill settings");
    d.innerHTML = `
      <div class="sheet-grip"></div>
      <h2>Bill settings</h2>
      <div class="segmented" role="tablist">
        ${LISTS.map((l, i) => `<button type="button" role="tab" data-tab="${i}">${l.label}</button>`).join("")}
      </div>
      <div class="list-items"></div>
      <form class="list-add"><input type="text" autocomplete="off" aria-label="New item"><button type="submit" class="add-btn" aria-label="Add">${icon("plus")}</button></form>
      <p class="list-hint">Items in use can be renamed but not deleted — the bills using them update automatically.</p>
      <div class="sheet-buttons"><button type="button" class="btn-ghost" data-done>Done</button></div>`;
    root.appendChild(d);
    const itemsEl = d.querySelector(".list-items");
    const addForm = d.querySelector(".list-add");
    const addInput = addForm.querySelector("input");

    const saveList = (key, items) => updateDoc(billsMeta(), { [key]: items }).catch(showError);

    const draw = () => {
      const L = LISTS[tab];
      d.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.tab) === tab)));
      addInput.placeholder = L.add;
      const items = meta[L.key] || [];
      itemsEl.replaceChildren(...items.map((item) => {
        const used = bills.filter((b) => b[L.field] === item.id).length;
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = `<span class="li-name"></span><span class="li-used"></span>
          <button type="button" class="square-btn" data-rename aria-label="Rename">${icon("pen")}</button>
          <button type="button" class="square-btn" data-remove aria-label="Delete"${used ? " disabled" : ""}>${icon("x")}</button>`;
        row.querySelector(".li-name").textContent = item.name;
        row.querySelector(".li-used").textContent = used ? `${used} bill${used > 1 ? "s" : ""}` : "";
        row.querySelector("[data-rename]").addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "text"; input.value = item.name; input.className = "li-edit"; input.setAttribute("aria-label", "New name");
          row.querySelector(".li-name").replaceWith(input);
          input.focus(); input.select();
          const commit = () => {
            const name = input.value.trim();
            if (name && name !== item.name) {
              saveList(L.key, items.map((i) => (i.id === item.id ? { ...i, name } : i)));
            } else draw();
          };
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
          input.addEventListener("blur", commit, { once: true });
        });
        row.querySelector("[data-remove]").addEventListener("click", async () => {
          if (bills.some((b) => b[L.field] === item.id)) return;
          const ok = await confirmDialog(`Delete “${item.name}” from ${L.label.toLowerCase()}s?`, "Delete", "Keep");
          if (ok) saveList(L.key, items.filter((i) => i.id !== item.id));
        });
        return row;
      }));
    };

    d.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = Number(b.dataset.tab); draw(); }));
    addForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = addInput.value.trim();
      if (!name) return;
      const L = LISTS[tab];
      if ((meta[L.key] || []).some((i) => i.name.toLowerCase() === name.toLowerCase())) { addInput.select(); return; }
      saveList(L.key, [...(meta[L.key] || []), newListItem(name)]);
      addInput.value = "";
    });
    d.querySelector("[data-done]").addEventListener("click", () => d.close());
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    d.addEventListener("close", () => { d.remove(); redrawSettings = null; if (openSheet === d) openSheet = null; });
    redrawSettings = draw;
    draw();
    openSheet = d;
    d.showModal();
  }

  // ---------- New period ----------
  $("[data-new-period]").addEventListener("click", async () => {
    if (!metaLoaded) return;
    const ok = await confirmDialog(
      "Reset all bills to unpaid at their usual amounts? Notes are kept.",
      "Reset", "Cancel", "Start new period");
    if (ok) resetPeriod();
  });

  let prompted = false;
  async function maybePromptNewPeriod() {
    if (prompted) return;
    const current = isoDate(periodStartFor());
    if (!meta.periodStart || meta.periodStart >= current) return;
    const key = `pv-bills-prompt-${current}`;
    try { if (sessionStorage.getItem(key)) return; } catch {}
    prompted = true;
    const ok = await confirmDialog(
      `A new period has started: ${periodLabel()}. Reset all bills to unpaid at their usual amounts? Notes are kept.`,
      "Reset", "Not yet", "New period");
    if (ok) resetPeriod();
    else { try { sessionStorage.setItem(key, "1"); } catch {} } // ask again next time you open the app
  }

  async function resetPeriod() {
    const batch = writeBatch(db);
    bills.forEach((b) => batch.update(billDoc(b.id), { paid: false, periodAmount: deleteField() }));
    batch.update(billsMeta(), { periodStart: isoDate(periodStartFor()) });
    writeOffline(batch.commit()).catch(showError);
  }

  const billDoc = (id) => fsDoc(billsCol(), id);

  // Leaving Bills: stop live updates and close any open pop-up
  return () => {
    stops.forEach((s) => { try { s(); } catch {} });
    stops = [];
    if (openSheet && openSheet.open) openSheet.close();
  };
}
