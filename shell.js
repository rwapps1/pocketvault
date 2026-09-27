// shell.js — draws the parts every page shares (icons, menu bar, date)
// BEFORE the first frame is painted, so moving between pages never shows
// an empty screen. It's a plain script at the end of <body> on purpose:
// it runs straight away, while the Firebase code loads in the background.
// Event handling (taps, sign-out, lock) lives in app.js.

(function () {
  // ---- Slide direction for page transitions ----
  // Pages are ordered like the menu bar. Moving right slides the new page in
  // from the right; moving left (or back to the vault) slides it from the left.
  var ORDER = { home: 0, bills: 1, investments: 2, holidays: 3 };
  var here = document.body.getAttribute("data-page");
  window.addEventListener("pageswap", function () {
    try { sessionStorage.setItem("pv-from", here); } catch (e) {}
  });
  window.addEventListener("pagereveal", function (e) {
    if (!e.viewTransition) return;
    var from = null;
    try { from = sessionStorage.getItem("pv-from"); } catch (err) {}
    if (from == null || !(from in ORDER) || from === here) return;
    e.viewTransition.types.add(ORDER[here] > ORDER[from] ? "forward" : "backward");
  });

  // ---- ONE icon set: used by the boxes, the menu bar and page headers ----
  var PATHS = {
    vault: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4.5"/><path d="M12 7.5v2"/><path d="M3 8h1.5M3 16h1.5"/>',
    bills: '<rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M3.5 7l8.5 6 8.5-6"/><path d="M15 16h3"/>',
    investments: '<ellipse cx="9" cy="17" rx="6" ry="2.2"/><path d="M3 17v2.5c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V17"/><ellipse cx="9" cy="12" rx="6" ry="2.2"/><path d="M3 12v2.5c0 .9 1.6 1.7 3.8 2"/><path d="M15 14.5V12"/><path d="M16 8l3-3 2 2"/><path d="M13 4h6v6"/>',
    holidays: '<path d="M7 15a5 5 0 0 1 10 0"/><path d="M12 5v2M5 8l1.4 1.4M19 8l-1.4 1.4M3 15h2M19 15h2"/><path d="M2 18.5c1.7 0 1.7-1 3.3-1s1.7 1 3.4 1 1.7-1 3.3-1 1.7 1 3.3 1 1.7-1 3.4-1 1.6 1 3.3 1"/><path d="M5 21.5c1.3 0 1.3-.8 2.6-.8s1.3.8 2.6.8 1.3-.8 2.6-.8 1.3.8 2.6.8 1.3-.8 2.6-.8"/>',
    vacant: '<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    back: '<path d="M15 18l-6-6 6-6"/>'
  };
  var THIN = { eye: 1, eyeOff: 1, back: 1 };

  function icon(name, strokeWidth) {
    var sw = strokeWidth || (THIN[name] ? 1.8 : 1.4);
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (PATHS[name] || "") + "</svg>";
  }
  window.PV = { icon: icon };

  // ---- Hide amounts, before anything is shown ----
  var hidden = false;
  try { hidden = localStorage.getItem("pv-hide-amounts") === "1"; } catch (e) {}
  document.documentElement.classList.toggle("pv-hide", hidden);

  // ---- Icons ----
  var els = document.querySelectorAll("[data-icon]");
  for (var i = 0; i < els.length; i++) els[i].innerHTML = icon(els[i].getAttribute("data-icon"));

  var eye = document.getElementById("eye-btn");
  if (eye) {
    eye.innerHTML = icon(hidden ? "eyeOff" : "eye");
    eye.setAttribute("aria-pressed", String(hidden));
    eye.setAttribute("aria-label", hidden ? "Show amounts" : "Hide amounts");
  }

  // ---- Date heading (home) ----
  var day = document.getElementById("day-text");
  if (day) {
    var now = new Date();
    day.textContent = now.toLocaleDateString("en-GB", { weekday: "long" });
    document.getElementById("date-text").textContent =
      now.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  }

  // ---- Bottom menu bar ----
  var current = document.body.getAttribute("data-page");
  var TABS = [
    ["home", "./", "Vault", "vault"],
    ["bills", "bills.html", "Bills", "bills"],
    ["investments", "investments.html", "Invest", "investments"],
    ["holidays", "holidays.html", "Holidays", "holidays"]
  ];
  var html = "";
  for (var t = 0; t < TABS.length; t++) {
    html += '<a class="tab" href="' + TABS[t][1] + '" data-go="' + TABS[t][0] + '"' +
      (TABS[t][0] === current ? ' aria-current="page"' : "") + ">" +
      (TABS[t][0] === current ? '<i class="tab-ind" aria-hidden="true"></i>' : "") +
      icon(TABS[t][3], 1.7) + "<span>" + TABS[t][2] + "</span></a>";
  }
  html += '<button class="tab" type="button" id="account-tab" aria-haspopup="dialog">' +
    '<span class="initial" id="account-initial">R</span><span>Account</span></button>';
  var nav = document.createElement("nav");
  nav.className = "tabbar";
  nav.setAttribute("aria-label", "Main");
  nav.innerHTML = html;
  document.body.appendChild(nav);
})();
