// bills-data.js — Bills rules shared by the Bills app and the vault's
// summary: where the data lives, the 28th-to-27th period, bill order,
// amounts in pence, and the starting lists.

import { col, doc } from "./app.js";

// ---------- Where the data lives ----------
//   pocketvault/{you}/bills/{billId}   one document per bill
//   pocketvault/{you}/meta/bills       your lists + when the period was last reset
export const billsCol = () => col("bills");
export const billsMeta = () => doc("meta", "bills");

// A bill:
//   company, purposeId, typeId, potId, dueDay (1–31),
//   usualAmount (pence), note, paid (this period),
//   periodAmount (pence, only when this period differs from usual)

export const PERIOD_START_DAY = 28;

const id = () => Math.random().toString(36).slice(2, 10);
export const newListItem = (name) => ({ id: id(), name });

export function defaultMeta(periodStartIso) {
  const list = (names) => names.map(newListItem);
  return {
    purposes: list(["Finance", "Communications & TV", "Insurance", "Health", "Entertainment", "Utility"]),
    types: list(["Direct Debit", "Standing Order", "Card Payment", "Manual Bank Transfer"]),
    pots: list(["Bills", "Emma's Loan", "Main Account"]),
    periodStart: periodStartIso
  };
}

// ---------- The period: 28th to the 27th ----------
export function periodStartFor(date = new Date()) {
  const y = date.getFullYear(), m = date.getMonth();
  return date.getDate() >= PERIOD_START_DAY ? new Date(y, m, PERIOD_START_DAY) : new Date(y, m - 1, PERIOD_START_DAY);
}
export function periodEndFor(start) {
  return new Date(start.getFullYear(), start.getMonth() + 1, PERIOD_START_DAY - 1);
}
export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function periodLabel(start = periodStartFor()) {
  const f = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${f(start)} – ${f(periodEndFor(start))}`;
}

// Position of a due day within the period: 28th → 0, 31st → 3, 1st → 4 … 27th → 30
export const periodPos = (day) => (day - PERIOD_START_DAY + 31) % 31;

export function sortBills(bills) {
  return bills.slice().sort((a, b) =>
    periodPos(a.dueDay) - periodPos(b.dueDay) ||
    String(a.company).localeCompare(String(b.company), "en-GB", { sensitivity: "base" }));
}

export function ordinal(n) {
  const s = n % 100;
  if (s >= 11 && s <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
}

// ---------- Amounts (kept in pence, so sums never go wrong) ----------
export const amountThisPeriod = (b) =>
  Number.isInteger(b.periodAmount) ? b.periodAmount : (b.usualAmount || 0);

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const money = (pence) => gbp.format((pence || 0) / 100);

// "£1,234.50", "1234.5", "150" → pence; null if not a valid amount
export function parseMoney(text) {
  const clean = String(text || "").replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}
export const moneyInput = (pence) => (pence == null ? "" : ((pence || 0) / 100).toFixed(2));

// ---------- For the vault ----------
// Next unpaid bill from today onwards in the period (or the earliest unpaid).
export function nextDue(bills, today = new Date()) {
  const unpaid = sortBills(bills.filter((b) => !b.paid));
  if (!unpaid.length) return null;
  const todayPos = periodPos(today.getDate());
  return unpaid.find((b) => periodPos(b.dueDay) >= todayPos) || unpaid[0];
}
