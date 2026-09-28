// vault.js — the home screen: date, deposit boxes, live summaries

import { getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { billsCol, amountThisPeriod, money, nextDue as findNextDue, ordinal } from "./bills-data.js";

// Bills are read once per visit to the vault (from the phone's copy when offline).
let billsOnce = null;
const loadBills = () => (billsOnce ||= getDocs(billsCol()).then((s) => s.docs.map((d) => d.data())));

export function mount(root, { open }) {
  const now = new Date();
  root.querySelector("[data-day]").textContent = now.toLocaleDateString("en-GB", { weekday: "long" });
  root.querySelector("[data-date]").textContent = now.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

  let alive = true;
  billsOnce = null; // fresh figures each time the vault is shown
  open.then(async () => {
    for (const [key, load] of Object.entries(summaries)) {
      if (!alive) return;
      try { renderBox(root, key, await load()); } catch { /* keep default text */ }
    }
    try {
      const due = await loadNextDue();
      if (due && alive) {
        root.querySelector("[data-next-due-what]").textContent = due.what;
        root.querySelector("[data-next-due-amount]").textContent = due.amount;
        root.querySelector("[data-next-due]").hidden = false;
      }
    } catch {}
  });

  return () => { alive = false; };
}

// ---------------------------------------------------------------------
// Live box summaries. Each mini app adds its loader here as it's built.
// A loader returns null (box keeps its description) or an object:
//   { figure, line, line2, tone: "pos"|"neg", tally: [done, total],
//     amount1 / amount2: true if that line is money (blurred by the eye) }
// ---------------------------------------------------------------------
const summaries = {
  bills: async () => {
    const bills = await loadBills();
    if (!bills.length) return null;
    const paid = bills.filter((b) => b.paid).length;
    return { line: paid === bills.length ? "All paid" : `${paid} of ${bills.length} paid`, tally: [paid, bills.length] };
  },
  // investments: async () => ({ figure: "£12,345", line: "▲ 4.2% overall", tone: "pos" }),
  // holidays:    async () => ({ line: "Next: Crete", line2: "£840 / £2,400", amount2: true }),
};

// Next unpaid bill from today onwards (hidden when everything's paid).
async function loadNextDue() {
  const next = findNextDue(await loadBills());
  if (!next) return null;
  return { what: `${next.company} · ${next.dueDay}${ordinal(next.dueDay)}`, amount: money(amountThisPeriod(next)) };
}

function renderBox(root, key, s) {
  const box = root.querySelector(`[data-box="${key}"]`);
  if (!box || !s) return;
  const body = box.querySelector(".box-body");
  const title = body.querySelector(".box-title");
  body.replaceChildren(title);
  const add = (cls, text, isAmount) => {
    const el = document.createElement("span");
    el.className = cls + (isAmount ? " amt" : "");
    el.textContent = text;
    body.appendChild(el);
  };
  if (s.figure) add("box-figure", s.figure, true);
  if (s.line) add(`box-line ${s.tone || ""}`, s.line, s.amount1);
  if (s.line2) add("box-line", s.line2, s.amount2);
  if (s.tally) {
    const [done, total] = s.tally;
    const t = document.createElement("div");
    t.className = "tally";
    t.classList.toggle("dense", total > 16);
    for (let i = 0; i < total; i++) {
      const notch = document.createElement("i");
      if (i < done) notch.className = "on";
      t.appendChild(notch);
    }
    body.appendChild(t);
  }
}
