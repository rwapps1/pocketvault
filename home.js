// home.js — home screen: greeting, account menu and live tile summaries

import {
  ready, OWNER_NAME, greeting, longDate,
  wireAccountMenu, registerSW
} from "./app.js";

document.getElementById("greeting-text").textContent = `${greeting()}, ${OWNER_NAME}`;
document.getElementById("today-text").textContent = longDate();

wireAccountMenu();
registerSW();

// ---------------------------------------------------------------------
// Live tile summaries.
// Each mini app adds its own loader here as it gets built. A loader
// returns null (tile keeps its default description) or an object that
// fills the tile's lines. Until then every tile shows its description.
// ---------------------------------------------------------------------
const summaries = {
  // bills:       async () => ({ line: "8 of 12 paid", progress: 0.66 }),
  // investments: async () => ({ figure: "£12,345", line: "+4.2% overall", tone: "pos" }),
  // holidays:    async () => ({ line: "Next: Crete · 12 Jun", line2: "£840 of £2,400" }),
};

function renderTile(key, s) {
  const tile = document.querySelector(`[data-tile="${key}"]`);
  if (!tile || !s) return;
  const body = tile.querySelector(".tile-body");
  const title = body.querySelector(".tile-title").outerHTML;
  const parts = [title];
  if (s.figure) parts.push(`<span class="tile-figure"></span>`);
  if (s.line) parts.push(`<span class="tile-line ${s.tone || ""}" data-l="1"></span>`);
  if (s.line2) parts.push(`<span class="tile-line" data-l="2"></span>`);
  if (typeof s.progress === "number") parts.push(`<div class="bar"><span></span></div>`);
  body.innerHTML = parts.join("");
  // Set text safely (no HTML from data)
  if (s.figure) body.querySelector(".tile-figure").textContent = s.figure;
  if (s.line) body.querySelector('[data-l="1"]').textContent = s.line;
  if (s.line2) body.querySelector('[data-l="2"]').textContent = s.line2;
  if (typeof s.progress === "number") {
    const pct = Math.max(0, Math.min(1, s.progress)) * 100;
    requestAnimationFrame(() => { body.querySelector(".bar > span").style.width = `${pct}%`; });
  }
}

ready.then(async () => {
  for (const [key, load] of Object.entries(summaries)) {
    try { renderTile(key, await load()); } catch (e) { /* keep default text */ }
  }
});
