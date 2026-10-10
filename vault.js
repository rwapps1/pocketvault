// vault.js — the home screen: date, deposit boxes, live summaries

import { col } from "./app.js";
import { getDocs, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { billsCol, amountThisPeriod, money, nextDue as findNextDue, ordinal } from "./bills-data.js";
import { earningsCol, summarise, currentTaxYear, taxYearLabel, pounds } from "./earnings-data.js";
import { holCol, sortTrips, tripPhase, daysToGo, niceDate } from "./holidays-data.js";
import { investMeta, investCol, pbCol, emptyMeta, computeAll, pbSummary, money0 } from "./investments-data.js";

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
    const left = bills.filter((b) => !b.paid).reduce((sum, b) => sum + amountThisPeriod(b), 0);
    return left === 0
      ? { figure: money(0), line: "All paid", tone: "pos", tally: [paid, bills.length] }
      : { figure: money(left), line: "left to pay", tally: [paid, bills.length] };
  },
  earnings: async () => {
    const snap = await getDocs(earningsCol());
    const ty = currentTaxYear();
    const all = snap.docs.map((d) => d.data());
    const s = summarise(all, ty);
    if (s.count) return { figure: pounds(s.projected), line: `projected ${taxYearLabel(ty)}` };
    // New tax year with nothing entered yet: show last year's total instead
    const last = summarise(all, ty - 1);
    if (last.count) return { figure: pounds(last.total), line: `${taxYearLabel(ty - 1)} total` };
    return null;
  },
  investments: async () => {
    // Total current value: Trading 212 pies (latest values entered) + Premium Bonds held
    const [m, inv, pb] = await Promise.all([getDoc(investMeta()), getDocs(investCol()), getDocs(pbCol())]);
    const meta = m.exists() ? { ...emptyMeta(), ...m.data() } : emptyMeta();
    const events = inv.docs.map((d) => d.data()).filter((e) => e && e.date && e.pieId);
    const bonds = pb.docs.map((d) => d.data()).filter((e) => e && e.date && e.type);
    if (!meta.pies.length && !bonds.length) return null;
    const total = computeAll(meta, events).value + pbSummary(bonds).held;
    return { figure: money0(total), line: "current value" };
  },
  credentials: async () => {
    // Just the number of accounts — the details stay encrypted
    const snap = await getDocs(col("credentials"));
    const n = snap.docs.length;
    return n ? { line: `${n} account${n === 1 ? "" : "s"}` } : null;
  },
  holidays: async () => {
    // Next trip and a countdown
    const snap = await getDocs(holCol());
    const trips = snap.docs.map((d) => d.data()).filter((t) => t && t.location && t.start);
    const next = sortTrips(trips).upcoming[0];
    if (!next) return null;
    if (tripPhase(next) === "now") return { figure: "Away now", line: next.location };
    const n = daysToGo(next);
    return { figure: n === 0 ? "Today!" : `${n} day${n === 1 ? "" : "s"}`, line: `${next.location} · ${niceDate(next.start, false)}` };
  },
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
