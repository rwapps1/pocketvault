// home.js — the vault (home screen): date, deposit boxes, live summaries, opening animation

import { initPage, open } from "./app.js";

// ---------- Opening animation: once per app session ----------
const INTRO_KEY = "pv-intro-done";
let introDone = false;
try { introDone = sessionStorage.getItem(INTRO_KEY) === "1"; } catch {}

let splash = null;
if (!introDone) {
  splash = document.createElement("div");
  splash.id = "pv-splash";
  splash.setAttribute("aria-hidden", "true");
  splash.innerHTML = `
    <svg viewBox="0 0 512 512">
      <rect width="512" height="512" rx="112" fill="#1E2329"/>
      <path d="M128 150 H384 V296 Q384 388 256 424 Q128 388 128 296 Z" fill="#C9CED4"/>
      <path d="M150 174 H362" stroke="#1E2329" stroke-width="7" stroke-dasharray="14 12" stroke-linecap="round" fill="none"/>
      <g class="dial">
        <circle cx="256" cy="298" r="78" fill="#2B323A" stroke="#C9A04E" stroke-width="10"/>
        <path d="M256 238 L256 228 M286 246 L291 237.4 M308 268 L316.6 263 M316 298 L326 298 M308 328 L316.6 333 M286 350 L291 358.6 M256 358 L256 368 M226 350 L221 358.6 M204 328 L195.4 333 M196 298 L186 298 M204 268 L195.4 263 M226 246 L221 237.4" stroke="#C9A04E" stroke-width="6" stroke-linecap="round"/>
        <circle cx="256" cy="298" r="34" fill="#C9A04E"/>
        <path d="M256 298 L256 270" stroke="#1E2329" stroke-width="8" stroke-linecap="round"/>
      </g>
      <path d="M246 196 L266 196 L256 210 Z" fill="#C9A04E"/>
    </svg>`;
  document.body.appendChild(splash);
}

// Date heading, icons and menu bar are drawn by shell.js.

initPage("home");

// ---------------------------------------------------------------------
// Live box summaries. Each mini app adds its loader here as it's built.
// A loader returns null (box keeps its description) or an object:
//   { figure, line, line2, tone: "pos"|"neg", tally: [done, total] }
// Anything that is money should be marked amount: true so the eye
// button can blur it. Until the apps exist every box shows its description.
// ---------------------------------------------------------------------
const summaries = {
  // bills:       async () => ({ line: "8 of 12 paid", tally: [8, 12] }),
  // investments: async () => ({ figure: "£12,345", line: "▲ 4.2% overall", tone: "pos" }),
  // holidays:    async () => ({ line: "Next: Crete", line2: "£840 / £2,400", amount2: true }),
};

// Next bill due strip — filled by the Bills app later; hidden until then.
async function loadNextDue() { return null; } // { what: "Council tax · Thu 1 Oct", amount: "£182.00" }

function renderBox(key, s) {
  const box = document.querySelector(`[data-box="${key}"]`);
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
    for (let i = 0; i < total; i++) {
      const notch = document.createElement("i");
      if (i < done) notch.className = "on";
      t.appendChild(notch);
    }
    body.appendChild(t);
  }
}

open.then(async () => {
  if (splash) {
    splash.classList.add("go");
    setTimeout(() => document.getElementById("boxes").classList.add("intro"), 600);
    splash.addEventListener("animationend", (e) => { if (e.target === splash) splash.remove(); });
    setTimeout(() => splash && splash.remove(), 2000); // safety net
    try { sessionStorage.setItem(INTRO_KEY, "1"); } catch {}
  }

  for (const [key, load] of Object.entries(summaries)) {
    try { renderBox(key, await load()); } catch { /* keep default text */ }
  }
  try {
    const due = await loadNextDue();
    if (due) {
      document.getElementById("next-due-what").textContent = due.what;
      document.getElementById("next-due-amount").textContent = due.amount;
      document.getElementById("next-due").hidden = false;
    }
  } catch {}
});
