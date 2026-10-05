/* App shell: page registry, hash router, navigation, shared data (tools, tested settings, ...) and live refresh. */
(function () {
  "use strict";
  const { html, $, $$, U, store, api, toast, esc } = App;

  const GROUPS = [
    ["CNC Router", ["cnc", "spoil", "holes"]],
    ["Machining", ["drilltap", "manual"]],
    ["Fabrication", ["weight", "cutlist", "bend", "convert"]],
    ["FRC Engineering", ["drive", "elevator", "arm", "flywheel", "belts", "elec", "pneu", "budget"]],
    ["Our Shop", ["tools", "tested", "joblog", "inventory", "maint"]],
    ["Guides", ["safety", "omio", "trouble", "materials", "links"]],
    ["Settings", ["settings"]],
  ];
  const DATA_PAGES = new Set(["tools", "tested", "joblog", "inventory", "maint"]);

  // ------------------------------------------------------------------ shared data
  App.load = async () => {
    const d = await api("GET", "/api/state");
    App.data = d;
    App.rev = d.rev;
    if (!store.get("units")) U.sys = d.settings.units === "mm" ? "met" : "imp";
    return d;
  };
  App.machine = () => (App.data && App.data.settings) || {};
  App.toolById = id => (App.data.tools || []).find(t => t.id === +id);
  App.reload = async () => { await App.load(); updateBadges(); if (DATA_PAGES.has(currentId())) App.rerender(); };
  App.save = async (entity, id, body) => {
    const r = id ? await api("PUT", `/api/${entity}/${id}`, body) : await api("POST", `/api/${entity}`, body);
    await App.reload();
    return r;
  };
  App.remove = async (entity, id) => { const r = await api("DELETE", `/api/${entity}/${id}`); await App.reload(); return r; };

  /** Page form values: defaults, overridden by whatever this browser remembered. */
  App.pageVals = (id, specs) => {
    const vals = App.defaultsOf(specs);
    const saved = store.get("vals:" + id, {});
    for (const s of specs) if (saved[s.id] !== undefined && saved[s.id] !== null && typeof saved[s.id] === typeof vals[s.id]) vals[s.id] = saved[s.id];
    return vals;
  };
  App.persist = (id, vals) => store.set("vals:" + id, vals);

  // ------------------------------------------------------------------ routing
  const currentId = () => {
    const h = location.hash.replace(/^#\/?/, "").split("?")[0];
    return App.pages[h] ? h : "cnc";
  };
  App.rerender = () => show();
  App.go = id => { location.hash = "#/" + id; };

  /** Someone else may have edited shared data since this page last loaded: check the revision counter (cheap) and reload if so. */
  async function freshen() {
    try {
      const { rev } = await api("GET", "/api/rev");
      if (rev !== App.rev) { await App.load(); updateBadges(); }
    } catch (e) { /* a network blip shouldn't stop navigation */ }
  }

  async function show() {
    const id = currentId(), page = App.pages[id], main = $("#main");
    if (App.lastId !== undefined && App.lastId !== id) await freshen();
    $$("#nav a").forEach(a => a.removeAttribute("aria-current"));
    const link = $(`#nav a[data-id="${id}"]`);
    if (link) link.setAttribute("aria-current", "page");
    document.title = page.title + " · Shop Toolkit";
    closeMenu();
    const scroll = window.scrollY;
    main.innerHTML = "";
    try {
      await page.render(main);
    } catch (e) {
      console.error(e);
      main.innerHTML = html`<section class="card"><h2>Something went wrong</h2><p>${e.message}</p><p><button class="btn" id="retry">Try again</button></p></section>`.s;
      $("#retry").onclick = () => show();
    }
    if (App.lastId !== id) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); } else window.scrollTo(0, scroll);
    App.lastId = id;
  }

  // ------------------------------------------------------------------ navigation
  function buildNav() {
    const nav = $("#nav");
    nav.innerHTML = GROUPS.map(([g, ids]) => html`<div class="navgroup"><h3>${g}</h3>${ids.filter(i => App.pages[i]).map(i => html`<a href="#/${i}" data-id="${i}">${App.pages[i].title}<span class="badge" data-badge="${i}" hidden></span></a>`)}</div>`.s).join("");
    $("#nav").insertAdjacentHTML("beforeend", html`<div class="navfoot">No login: anyone on the team can edit shared data. Backups are automatic.</div>`.s);
  }
  function setBadge(id, n, bad) {
    const b = $(`[data-badge="${id}"]`);
    if (!b) return;
    b.hidden = !n;
    b.textContent = n || "";
    b.classList.toggle("bad", !!bad);
  }
  function updateBadges() {
    if (!App.data) return;
    const low = App.data.inventory.filter(i => i.min_qty > 0 && i.qty <= i.min_qty).length;
    setBadge("inventory", low, true);
    setBadge("maint", (App.data.maintenance || []).filter(m => App.maintStatus(m).overdue).length, true);
  }
  /** days since last done / due state for a maintenance task */
  App.maintStatus = m => {
    if (!m.interval_days) return { due: null, overdue: false, text: m.last_done ? "As needed" : "As needed" };
    if (!m.last_done) return { due: null, overdue: true, text: "Never done" };
    const due = new Date(m.last_done + "T00:00:00");
    due.setDate(due.getDate() + m.interval_days);
    const days = Math.round((due - new Date(new Date().toDateString())) / 86400000);
    return { due, days, overdue: days < 0, text: days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}` };
  };
  function closeMenu() { document.body.classList.remove("menu"); $("#menuBtn").setAttribute("aria-expanded", "false"); }

  function setupChrome() {
    $("#menuBtn").addEventListener("click", () => {
      const open = document.body.classList.toggle("menu");
      $("#menuBtn").setAttribute("aria-expanded", open);
    });
    $("#scrim").addEventListener("click", closeMenu);
    const seg = $("#unitSeg");
    const mark = () => $$("button", seg).forEach(b => { const on = b.dataset.u === U.sys; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    seg.addEventListener("click", e => {
      const b = e.target.closest("button[data-u]");
      if (!b) return;
      U.set(b.dataset.u); mark(); show();
    });
    mark();
    App.markUnits = mark;
    // search
    const input = $("#search"), out = $("#searchOut");
    const run = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { out.hidden = true; out.innerHTML = ""; return; }
      const hits = Object.values(App.pages).filter(p => (p.title + " " + (p.keywords || "")).toLowerCase().includes(q)).slice(0, 8);
      out.hidden = false;
      out.innerHTML = hits.length ? hits.map(p => html`<a href="#/${p.id}">${p.title}</a>`.s).join("") : '<div class="mut pad">No match</div>';
    };
    input.addEventListener("input", run);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { const a = $("a", out); if (a) { location.hash = a.getAttribute("href"); input.value = ""; run(); input.blur(); } }
      if (e.key === "Escape") { input.value = ""; run(); input.blur(); }
    });
    out.addEventListener("click", () => { input.value = ""; out.hidden = true; });
    document.addEventListener("keydown", e => {
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
    });
  }

  // ------------------------------------------------------------------ live refresh (other people editing)
  async function poll() {
    if (document.hidden || $("#dlg").open) return;
    try {
      const { rev } = await api("GET", "/api/rev");
      if (rev !== App.rev) {
        const prev = App.rev;
        await App.reload();
        if (prev !== undefined && DATA_PAGES.has(currentId())) toast("Updated: someone changed shared data");
      }
    } catch (e) { /* offline blips are fine */ }
  }

  async function boot() {
    U.sys = store.get("units") === "met" ? "met" : store.get("units") === "imp" ? "imp" : "imp";
    setupChrome();
    $("#main").innerHTML = '<section class="card"><p class="mut">Loading…</p></section>';
    try {
      await App.load();
    } catch (e) {
      $("#main").innerHTML = html`<section class="card"><h2>Can't reach the server</h2><p>${e.message}</p><p><button class="btn pri" id="retry">Try again</button></p></section>`.s;
      $("#retry").onclick = () => location.reload();
      return;
    }
    App.markUnits();
    buildNav();
    updateBadges();
    window.addEventListener("hashchange", show);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    setInterval(poll, 30000);
    await show();
  }
  App.boot = boot;
  document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 0));
})();
