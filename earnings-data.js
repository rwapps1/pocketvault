// earnings-data.js — Earnings rules shared by the Earnings app and the vault:
// where the data lives, UK tax years (April to March, by month), and the
// yearly projection. Amounts are whole pounds, gross (before tax).

import { col } from "./app.js";

// pocketvault/{you}/earnings/{YYYY-MM}  — one document per month
//   { year, month (1–12), amount (whole pounds, gross) }
export const earningsCol = () => col("earnings");
export const monthId = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Tax year is named by the year it starts in: April 2026 – March 2027 → 2026.
export const taxYearOf = (year, month) => (month >= 4 ? year : year - 1);
export const currentTaxYear = (d = new Date()) => taxYearOf(d.getFullYear(), d.getMonth() + 1);
export const taxYearLabel = (ty) => `${String(ty).slice(2)}/${String(ty + 1).slice(2)}`;

// The twelve months of a tax year, April first.
export function monthsOfTaxYear(ty) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const month = ((3 + i) % 12) + 1;           // 4,5,…,12,1,2,3
    out.push({ year: month >= 4 ? ty : ty + 1, month });
  }
  return out;
}

// Totals for one tax year from a list of entries.
export function summarise(entries, ty) {
  const inYear = entries.filter((e) => taxYearOf(e.year, e.month) === ty);
  const total = inYear.reduce((s, e) => s + (e.amount || 0), 0);
  const count = inYear.length;
  const average = count ? Math.round(total / count) : 0;
  const projected = count === 12 ? total : Math.round((total * 12) / count || 0);
  return { total, count, average, projected, complete: count === 12 };
}

const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const pounds = (n) => gbp0.format(n || 0);

// "4,300", "£4300", "4300" → 4300; null if blank, not a number, or has pence
export function parsePounds(text) {
  const clean = String(text || "").replace(/[£,\s]/g, "");
  if (!/^\d+$/.test(clean)) return null;
  return parseInt(clean, 10);
}
