// investments-data.js — Investments rules shared by the Investments app and
// the vault: where the data lives, how each pot's share of a pie is worked
// out, XIRR, the ISA allowance and Premium Bonds. No screen code here.
//
// All amounts are kept in pence, so sums never go wrong.

import { col, doc } from "./app.js";

// ---------- Where the data lives ----------
//   pocketvault/{you}/meta/invest   your pies, their pots, usual amounts, ISA allowance
//   pocketvault/{you}/invest/{id}   one document per transaction or value update:
//     { kind: "tx", type: "deposit"|"withdraw", pieId, date, amount, split: { potId: pence }, at }
//     { kind: "tx", type: "move", pieId, date, amount, from: potId, to: potId, at }
//     { kind: "value", pieId, date, value, at }        (id: v_{pieId}_{date})
//   pocketvault/{you}/pb/{id}       Premium Bonds: { type: "deposit"|"withdraw"|"prize", date, amount, reinvested, at }
export const investMeta = () => doc("meta", "invest");
export const investCol = () => col("invest");
export const pbCol = () => col("pb");
export const valueId = (pieId, date) => `v_${pieId}_${date}`;

export const DEFAULT_ISA = 2000000; // £20,000
export const emptyMeta = () => ({ pies: [], isaLimit: DEFAULT_ISA });
export const newId = () => Math.random().toString(36).slice(2, 10);

// ---------- Dates ("YYYY-MM-DD") ----------
export const todayIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MON_T = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "29 SEP" (this year) or "29 SEP 25"
export function shortDate(iso, now = new Date()) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MON[m - 1]}${y === now.getFullYear() ? "" : " " + String(y).slice(2)}`;
}
// "27 Sep" or "27 Sep 2025"
export function niceDate(iso, now = new Date()) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MON_T[m - 1]}${y === now.getFullYear() ? "" : " " + y}`;
}

// UK tax year for ISAs and Premium Bond prizes: 6 April to 5 April,
// named by the year it starts in (6 Apr 2026 – 5 Apr 2027 → 2026).
export function taxYearOfDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return m > 4 || (m === 4 && d >= 6) ? y : y - 1;
}
export const taxYearName = (ty) => `${String(ty).slice(2)}/${String(ty + 1).slice(2)}`;

// ---------- Money ----------
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0, minimumFractionDigits: 0 });
export const money = (p) => gbp.format((p || 0) / 100);                 // £1,234.56
export const money0 = (p) => gbp0.format(Math.round((p || 0) / 100));   // £1,235
export const signed0 = (p) => (p < 0 ? "−" : "+") + money0(Math.abs(p));
export const pctText = (x) => (x == null || !isFinite(x) ? "—" : (x < 0 ? "−" : "+") + Math.abs(x * 100).toFixed(1) + "%");
export const rateText = (x) => (x == null || !isFinite(x) ? "—" : (x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(1) + "%");
// "£1,234.50", "1234.5", "150" → pence; null if blank or not an amount
export function parseMoney(text) {
  const clean = String(text || "").replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean) && !/^\.\d{1,2}$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}
export const moneyInput = (p) => (p == null ? "" : ((p || 0) / 100).toFixed(2));

// ---------- Pies and pots ----------
export const usualTotal = (pie) => (pie.pots || []).reduce((s, p) => s + (p.usual || 0), 0);
export const potsOf = (meta, pieId) => ((meta.pies || []).find((p) => p.id === pieId) || {}).pots || [];

// Event order: by date; on the same day, money in/out comes before a value
// update (a value entered that day is taken to include that day's money).
function orderEvents(list) {
  return list.slice().sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 :
    (a.kind === "value") - (b.kind === "value") || (a.at || 0) - (b.at || 0));
}

// Works out one pie from its transactions and value updates.
// Each pot owns "units" of the pie, bought and sold at the pie's value at
// the time (last value entered plus money added since), so each pot gets
// exactly its share of the growth, even when money goes in at different
// times or growth is taken out.
export function computePie(pie, events) {
  const mine = orderEvents(events.filter((e) => e.pieId === pie.id));
  const units = {}, pots = {};
  (pie.pots || []).forEach((p) => { units[p.id] = 0; pots[p.id] = { in: 0, out: 0 }; });
  const ensure = (id) => { if (!(id in units)) { units[id] = 0; pots[id] = { in: 0, out: 0 }; } };
  let total = 0, est = 0;           // units in issue, estimated pie value (pence)
  let deposits = 0, withdrawals = 0;
  let valueDate = null, lastTx = null, firstTx = null;
  const flows = [];                 // for XIRR: money you put in is negative
  const price = () => (total > 1e-9 && est > 0 ? est / total : 1);

  for (const e of mine) {
    if (e.kind === "value") {
      est = e.value; valueDate = e.date;
      if (est <= 0) { for (const k in units) units[k] = 0; total = 0; }
      continue;
    }
    lastTx = e.date; if (!firstTx) firstTx = e.date;
    const pr = price();
    if (e.type === "deposit" || e.type === "withdraw") {
      const sign = e.type === "deposit" ? 1 : -1;
      for (const [potId, amt] of Object.entries(e.split || {})) {
        if (!amt) continue;
        ensure(potId);
        units[potId] += (sign * amt) / pr; total += (sign * amt) / pr;
        if (sign > 0) pots[potId].in += amt; else pots[potId].out += amt;
      }
      est += sign * e.amount;
      if (sign > 0) deposits += e.amount; else withdrawals += e.amount;
      flows.push({ date: e.date, amount: -sign * e.amount });
    } else if (e.type === "move" && e.from && e.to && e.from !== e.to) {
      ensure(e.from); ensure(e.to);
      const u = e.amount / pr;
      units[e.from] -= u; units[e.to] += u;
      pots[e.from].out += e.amount; pots[e.to].in += e.amount;
    }
  }
  const value = Math.round(est);
  for (const id in pots) {
    const v = total > 1e-9 ? Math.round((units[id] * est) / total) : 0;
    pots[id].value = Math.abs(v) < 1 ? 0 : v;
    pots[id].net = pots[id].in - pots[id].out;
    pots[id].gain = pots[id].value - pots[id].net;
  }
  const paidIn = deposits - withdrawals;
  const asOf = [valueDate, lastTx].filter(Boolean).sort().pop() || null;
  const stale = !!(valueDate && lastTx && lastTx > valueDate) || (!valueDate && !!lastTx);
  return {
    id: pie.id, value, paidIn, deposits, withdrawals, gain: value - paidIn,
    pots, valueDate, lastTx, firstTx, asOf, stale, hasValue: !!valueDate, flows
  };
}

// XIRR: the yearly rate that makes all the money in and out (plus what it's
// worth now) balance, allowing for the date of each payment. Returns a
// fraction (0.078 = 7.8% a year) or null if it can't be worked out.
export function xirr(flows) {
  const fs = flows.filter((f) => f.amount);
  if (!fs.some((f) => f.amount < 0) || !fs.some((f) => f.amount > 0)) return null;
  const t0 = fs.reduce((m, f) => (f.date < m ? f.date : m), fs[0].date);
  const ts = fs.map((f) => ({ t: daysBetween(t0, f.date) / 365, a: f.amount }));
  const npv = (r) => ts.reduce((s, f) => s + f.a / Math.pow(1 + r, f.t), 0);
  const dnpv = (r) => ts.reduce((s, f) => s - (f.t * f.a) / Math.pow(1 + r, f.t + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 60; i++) {
    const v = npv(r), d = dnpv(r);
    if (!isFinite(v) || !isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }
  // Fall back to halving the interval
  let lo = -0.9999, hi = 100, flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7 || hi - lo < 1e-10) return mid;
    if (fm * flo < 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export const MIN_XIRR_DAYS = 90; // shorter than ~3 months gives silly yearly figures

// XIRR for one or more worked-out pies, up to the latest date among them.
export function xirrFor(pies) {
  const valued = pies.filter((p) => p.hasValue && p.flows.length);
  if (!valued.length) return { rate: null, reason: "no-value" };
  const end = valued.map((p) => p.asOf).sort().pop();
  const first = valued.map((p) => p.firstTx).sort()[0];
  if (daysBetween(first, end) < MIN_XIRR_DAYS) return { rate: null, reason: "too-soon" };
  const flows = valued.flatMap((p) => p.flows);
  flows.push({ date: end, amount: valued.reduce((s, p) => s + p.value, 0) });
  return { rate: xirr(flows), reason: null };
}

// ---------- The whole T212 account ----------
export function computeAll(meta, events) {
  const pies = (meta.pies || []).map((p) => computePie(p, events));
  const value = pies.reduce((s, p) => s + p.value, 0);
  const paidIn = pies.reduce((s, p) => s + p.paidIn, 0);
  const valueDates = pies.filter((p) => p.hasValue).map((p) => p.valueDate).sort();
  return {
    pies, value, paidIn, gain: value - paidIn,
    valueDate: valueDates.length ? valueDates[valueDates.length - 1] : null,
    stale: pies.some((p) => p.stale),
    xirr: xirrFor(pies)
  };
}

// ISA allowance used in a tax year. Trading 212's ISA is flexible: money
// taken out can be put back in the same tax year without using more allowance.
export function isaUsed(events, ty) {
  let dep = 0, wd = 0;
  for (const e of events) {
    if (e.kind !== "tx" || taxYearOfDate(e.date) !== ty) continue;
    if (e.type === "deposit") dep += e.amount;
    else if (e.type === "withdraw") wd += e.amount;
  }
  return Math.max(0, dep - wd);
}

// ---------- Premium Bonds ----------
// Held = deposits − withdrawals + prizes you reinvested. Paid-out prizes
// count towards the rate but not the amount held.
export function pbSummary(entries, today = todayIso()) {
  const list = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)));
  const change = (e) => (e.type === "deposit" ? e.amount : e.type === "withdraw" ? -e.amount : e.reinvested ? e.amount : 0);
  const held = list.reduce((s, e) => s + change(e), 0);
  const prizes = list.filter((e) => e.type === "prize");
  const ty = taxYearOfDate(today);
  const prizesTY = prizes.filter((e) => taxYearOfDate(e.date) === ty);
  const sum = (a) => a.reduce((s, e) => s + e.amount, 0);

  // Rate over the last 12 months (or since the first deposit, if sooner):
  // prizes ÷ average amount held, as a yearly figure.
  let rate = null;
  const first = list.find((e) => e.type === "deposit");
  if (first) {
    const back = new Date(dayNum(today) * 86400000 - 365 * 86400000);
    const yearAgo = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}-${String(back.getUTCDate()).padStart(2, "0")}`;
    const start = first.date > yearAgo ? first.date : yearAgo;
    const days = daysBetween(start, today);
    if (days >= MIN_XIRR_DAYS) {
      let bal = 0, area = 0, cursor = start;
      for (const e of list) {
        if (e.date > today) break;
        if (e.date > cursor) { area += bal * daysBetween(cursor, e.date); cursor = e.date; }
        bal += change(e);
      }
      area += bal * daysBetween(cursor, today);
      const avg = area / days;
      const won = sum(prizes.filter((e) => e.date > start && e.date <= today));
      if (avg > 0) rate = (won / avg) * (365 / days);
    }
  }
  return {
    held, prizesTY: sum(prizesTY), countTY: prizesTY.length, prizesAll: sum(prizes), count: prizes.length,
    since: first ? first.date : null, rate, ty
  };
}
