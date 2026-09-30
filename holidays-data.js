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
//       costs: [ { id, type, name, currency "GBP"|"EUR", amount, rate (£ per €1),
//                  when "advance"|"arrival", supplierPaid,
//                  split "equal"|"custom", shares { payerId: amount } (custom only),
//                  received { payerId: true } } ] }
export const holMeta = () => doc("meta", "holidays");
export const holCol = () => col("holidays");
export const newId = () => Math.random().toString(36).slice(2, 10);

export const COST_TYPES = [
  ["taxis", "UK taxis"], ["flights", "Flights"], ["transfer", "Transfer"],
  ["hotel", "Hotel"], ["tax", "Local tax"], ["other", "Other"]
];
export const typeLabel = (type) => (COST_TYPES.find(([k]) => k === type) || [0, "Cost"])[1];
// The name shown on the list, e.g. "Hotel deposit"; defaults to the type
export const typeName = (c) => (c.name && c.name.trim()) || (c.type === "other" ? "Other" : typeLabel(c.type));

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

// Older trips (version 18) kept costs as several payments each. Turn each
// payment into its own cost so nothing is lost.
export function normalizeTrip(trip) {
  if (!(trip.costs || []).some((c) => Array.isArray(c.payments))) return trip;
  const costs = [];
  for (const c of trip.costs || []) {
    if (!Array.isArray(c.payments)) { costs.push(c); continue; }
    const base = c.type === "other" ? c.name || "Other" : typeLabel(c.type);
    for (const p of c.payments) {
      const full = /full/i.test(p.label || "") || c.payments.length === 1;
      const cost = {
        id: c.payments.length === 1 ? c.id : p.id, type: c.type, name: full ? (c.type === "other" ? base : "") : `${base} ${String(p.label || "").toLowerCase()}`,
        currency: p.currency || "GBP", amount: p.amount || 0, rate: p.rate || null,
        when: p.status === "arrival" ? "arrival" : "advance", supplierPaid: p.status === "paid",
        split: p.split === "person" ? "equal" : "custom", received: p.received || {}
      };
      if (cost.split === "custom") cost.shares = p.split === "custom" ? p.shares || {} : sharesOf(trip, { amount: p.amount, split: "payer" });
      costs.push(cost);
    }
  }
  return { ...trip, costs };
}

// { payerId: amount } for one cost. Equal = per person, so someone paying
// for two people pays two shares.
export function sharesOf(trip, cost) {
  const payers = payersOf(trip);
  if (cost.split === "custom") {
    const s = {};
    payers.forEach((p) => { s[p.id] = (cost.shares || {})[p.id] || 0; });
    for (const [id, v] of Object.entries(cost.shares || {})) if (!(id in s) && v) s[id] = v; // someone no longer paying
    return s;
  }
  const weights = payers.map((p) => (cost.split === "payer" ? 1 : p.for.length));
  const alloc = allocate(cost.amount || 0, weights);
  return Object.fromEntries(payers.map((p, i) => [p.id, alloc[i]]));
}

// ---------- Totals for a trip (all in pence) ----------
export function tripTotals(trip) {
  let total = 0, supplier = 0, received = 0, arrivalGBP = 0;
  const arrival = { GBP: 0, EUR: 0 };
  const byPayer = {};
  for (const c of trip.costs || []) {
    const g = toGBP(c.amount || 0, c);
    total += g;
    if (c.supplierPaid) supplier += g;
    else if (c.when === "arrival") { arrival[c.currency] = (arrival[c.currency] || 0) + (c.amount || 0); arrivalGBP += g; }
    for (const [id, v] of Object.entries(sharesOf(trip, c))) {
      if (!v) continue;
      const b = (byPayer[id] ||= { total: 0, received: 0 });
      const sg = toGBP(v, c);
      b.total += sg;
      if ((c.received || {})[id]) { b.received += sg; received += sg; }
    }
  }
  return { total, supplier, received, arrival, arrivalGBP, byPayer };
}

// The next cost still to pay a supplier: ones paid in advance first, then on arrival.
export function nextPayment(trip) {
  const open = (trip.costs || []).filter((c) => !c.supplierPaid);
  return open.find((c) => c.when !== "arrival") || open[0] || null;
}

export function sortTrips(trips, today = todayIso()) {
  const upcoming = trips.filter((t) => tripPhase(t, today) !== "past")
    .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const past = trips.filter((t) => tripPhase(t, today) === "past")
    .sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return { upcoming, past };
}
