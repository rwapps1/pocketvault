// holidays-data.js — Holidays rules shared by the Holidays app and the vault:
// where the data lives, who pays for whom, how each payment is split, and
// the totals. No screen code here.
//
// Amounts are whole pence / cents, so sums never go wrong.

import { col, doc } from "./app.js";

// ---------- Where the data lives ----------
//   pocketvault/{you}/meta/holidays     { people: [{ id, name }], rates: { EUR: 0.8346 } }
//   pocketvault/{you}/holidays/{tripId} one document per holiday:
//     { location, start "YYYY-MM-DD", end "YYYY-MM-DD" | "",
//       travellers: [ { personId, payerId } ],        // who's going, who pays for them
//       costs: [ { id, type, name, payments: [ {
//          id, label, currency "GBP"|"EUR", amount, rate (£ per €1),
//          status "paid"|"due"|"arrival", date,
//          split "person"|"payer"|"custom", shares { payerId: amount } (custom only),
//          received { payerId: true } } ] } ] }
export const holMeta = () => doc("meta", "holidays");
export const holCol = () => col("holidays");
export const newId = () => Math.random().toString(36).slice(2, 10);

export const COST_TYPES = [
  ["taxis", "UK taxis"], ["flights", "Flights"], ["transfer", "Transfer"],
  ["hotel", "Hotel"], ["tax", "Local tax"], ["other", "Other"]
];
export const typeName = (c) => (c.type === "other" ? c.name || "Other" : (COST_TYPES.find(([k]) => k === c.type) || [0, "Cost"])[1]);
export const PAYMENT_LABELS = ["Paid in full", "Deposit", "Balance", "Instalment"];

// ---------- Dates ----------
export const todayIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parts = (iso) => iso.split("-").map(Number);
export function niceDate(iso, withYear = true) {
  const [y, m, d] = parts(iso);
  return `${d} ${MON[m - 1]}${withYear ? " " + y : ""}`;
}
// "Mon 14 – Mon 21 Jun 2027 · 7 nights"
export function tripDates(t) {
  if (!t.start) return "";
  const [y1, m1, d1] = parts(t.start);
  const wd = (iso) => DAY[new Date(dayNum(iso) * 86400000).getUTCDay()];
  if (!t.end) return `${wd(t.start)} ${d1} ${MON[m1 - 1]} ${y1}`;
  const [y2, m2, d2] = parts(t.end);
  const n = daysBetween(t.start, t.end);
  const left = y1 !== y2 ? `${wd(t.start)} ${d1} ${MON[m1 - 1]} ${y1}` : m1 !== m2 ? `${wd(t.start)} ${d1} ${MON[m1 - 1]}` : `${wd(t.start)} ${d1}`;
  return `${left} – ${wd(t.end)} ${d2} ${MON[m2 - 1]} ${y2}${n > 0 ? ` · ${n} night${n > 1 ? "s" : ""}` : ""}`;
}
// Where a trip is: "upcoming", "now" (away), or "past"
export function tripPhase(t, today = todayIso()) {
  const end = t.end || t.start;
  if (end && end < today) return "past";
  if (t.start && t.start <= today) return "now";
  return "upcoming";
}
export const daysToGo = (t, today = todayIso()) => (t.start ? daysBetween(today, t.start) : null);

// ---------- Money ----------
const fmt = {
  GBP: new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }),
  EUR: new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" })
};
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0, minimumFractionDigits: 0 });
export const money = (v, cur = "GBP") => (fmt[cur] || fmt.GBP).format((v || 0) / 100);
export const pounds0 = (p) => gbp0.format(Math.round((p || 0) / 100));
export const SYMBOL = { GBP: "£", EUR: "€" };
export function parseMoney(text) {
  const clean = String(text || "").replace(/[£€,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean) && !/^\.\d{1,2}$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}
export const moneyInput = (v) => (v == null ? "" : ((v || 0) / 100).toFixed(2));
// Value of an amount in pence
export const toGBP = (amount, pay) => (pay.currency === "EUR" ? Math.round(amount * (pay.rate || 0)) : amount);

// ---------- Who pays ----------
// Payers in the order they first appear, each with the people they pay for.
export function payersOf(trip) {
  const out = [];
  for (const t of trip.travellers || []) {
    let p = out.find((x) => x.id === t.payerId);
    if (!p) { p = { id: t.payerId, for: [] }; out.push(p); }
    p.for.push(t.personId);
  }
  return out;
}

// Split an amount by weights; the odd penny/cent goes to the first payers.
function allocate(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map(Math.floor);
  let left = amount - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

// { payerId: amount } for one payment
export function sharesOf(trip, pay) {
  const payers = payersOf(trip);
  if (pay.split === "custom") {
    const s = {};
    payers.forEach((p) => { s[p.id] = (pay.shares || {})[p.id] || 0; });
    for (const [id, v] of Object.entries(pay.shares || {})) if (!(id in s) && v) s[id] = v; // someone no longer paying
    return s;
  }
  const weights = payers.map((p) => (pay.split === "payer" ? 1 : p.for.length));
  const alloc = allocate(pay.amount || 0, weights);
  return Object.fromEntries(payers.map((p, i) => [p.id, alloc[i]]));
}

// ---------- Totals for a trip (all in pence) ----------
export function tripTotals(trip) {
  let total = 0, supplier = 0, received = 0;
  const arrival = { GBP: 0, EUR: 0 };
  const byPayer = {};
  const payments = [];
  for (const c of trip.costs || []) {
    for (const p of c.payments || []) {
      const g = toGBP(p.amount || 0, p);
      total += g;
      if (p.status === "paid") supplier += g;
      if (p.status === "arrival") arrival[p.currency] = (arrival[p.currency] || 0) + (p.amount || 0);
      const shares = sharesOf(trip, p);
      let inCount = 0, owed = 0;
      for (const [id, v] of Object.entries(shares)) {
        if (!v) continue;
        owed++;
        const b = (byPayer[id] ||= { total: 0, received: 0 });
        const sg = toGBP(v, p);
        b.total += sg;
        if ((p.received || {})[id]) { b.received += sg; received += sg; inCount++; }
      }
      payments.push({ cost: c, pay: p, gbp: g, inCount, owed });
    }
  }
  const arrivalGBP = (trip.costs || []).flatMap((c) => c.payments || []).filter((p) => p.status === "arrival")
    .reduce((s, p) => s + toGBP(p.amount || 0, p), 0);
  return { total, supplier, received, arrival, arrivalGBP, byPayer, payments };
}

// The next payment still to be made to a supplier: dated ones first, then on arrival.
export function nextPayment(trip) {
  const open = [];
  for (const c of trip.costs || []) for (const p of c.payments || []) {
    if (p.status === "paid") continue;
    open.push({ cost: c, pay: p, key: p.status === "due" && p.date ? p.date : (trip.start || "9999") + "z" });
  }
  open.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return open[0] || null;
}

export function sortTrips(trips, today = todayIso()) {
  const upcoming = trips.filter((t) => tripPhase(t, today) !== "past")
    .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const past = trips.filter((t) => tripPhase(t, today) === "past")
    .sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return { upcoming, past };
}
