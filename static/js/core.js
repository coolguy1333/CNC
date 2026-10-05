/* Shared UI plumbing: safe HTML templating, units, storage, API client, form widgets, dialogs.
 * Nothing here builds markup from untrusted text without escaping: use the `html` tag, which escapes every
 * interpolated value unless it was produced by another `html` call or `raw()`. */
(function () {
  "use strict";
  const App = (window.App = window.App || { pages: {}, order: [], data: null, vals: {} });

  // ------------------------------------------------------------------ safe html
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = s => new Raw(String(s));
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
  const toHtml = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(toHtml).join("") : v == null || v === false ? "" : esc(v));
  const html = (strs, ...vals) => new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? toHtml(vals[i]) : ""), ""));
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const setHtml = (el, h) => { el.innerHTML = h instanceof Raw ? h.s : esc(h); };

  // ------------------------------------------------------------------ numbers and units
  /** Trimmed fixed-point: fmt(1.50) -> "1.5". Non-finite values show a dash. */
  const fmt = (x, dp = 2) => {
    if (x === null || x === undefined || !isFinite(x)) return "–";
    const k = Math.pow(10, dp);
    const r = Math.round(x * k) / k || 0;
    const s = r.toFixed(dp);
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  };
  const group = n => Math.round(n).toLocaleString("en-US");
  /** Number for an input box: short, but precise enough that typing it back changes nothing visible. */
  const fmtInput = x => fmt(x, Math.abs(x) >= 100 ? 2 : Math.abs(x) >= 10 ? 3 : 4);

  // Canonical units: mm, kg, N, N·m, m/s, mm/min, kPa, m. The toggle only changes what people see and type.
  const KINDS = {
    len: { imp: ["in", 25.4, 4], met: ["mm", 1, 3] },
    longlen: { imp: ["ft", 304.8, 3], met: ["m", 1000, 3] },
    mass: { imp: ["lb", 0.45359237, 3], met: ["kg", 1, 3] },
    force: { imp: ["lbf", 4.4482216152605, 2], met: ["N", 1, 1] },
    torque: { imp: ["in·lb", 0.1129848290276, 2], met: ["N·m", 1, 3] },
    speed: { imp: ["ft/s", 0.3048, 2], met: ["m/s", 1, 2] },
    feed: { imp: ["in/min", 25.4, 1], met: ["mm/min", 1, 0] },
    press: { imp: ["psi", 6.894757293168, 1], met: ["kPa", 1, 0] },
  };
  const U = {
    sys: "imp",
    isImp() { return this.sys === "imp"; },
    unit(kind) { return KINDS[kind][this.sys][0]; },
    factor(kind) { return KINDS[kind][this.sys][1]; },
    dp(kind) { return KINDS[kind][this.sys][2]; },
    show(kind, canon) { return canon / this.factor(kind); },
    parse(kind, shown) { return shown * this.factor(kind); },
    fmt(kind, canon, dp) { return fmt(this.show(kind, canon), dp == null ? this.dp(kind) : dp) + " " + this.unit(kind); },
    /** both systems at once, e.g. "68 in/min (1727 mm/min)" */
    both(kind, canon, dpImp, dpMet) {
      const [i, m] = [KINDS[kind].imp, KINDS[kind].met];
      const a = fmt(canon / i[1], dpImp == null ? i[2] : dpImp) + " " + i[0], b = fmt(canon / m[1], dpMet == null ? m[2] : dpMet) + " " + m[0];
      return this.isImp() ? [a, b] : [b, a];
    },
    set(sys) { this.sys = sys === "met" ? "met" : "imp"; store.set("units", this.sys); },
  };

  // ------------------------------------------------------------------ storage (every access guarded: private windows throw)
  const store = {
    get(key, def) { try { const v = localStorage.getItem("shop:" + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(key, val) { try { localStorage.setItem("shop:" + key, JSON.stringify(val)); } catch (e) { /* ignore */ } },
    del(key) { try { localStorage.removeItem("shop:" + key); } catch (e) { /* ignore */ } },
  };

  // ------------------------------------------------------------------ toast, clipboard, api
  let toastTimer;
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("bad", !!bad);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 5000 : 2500);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.className = "offscreen";
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (x) { /* ignore */ }
      ta.remove();
      toast(ok ? "Copied" : "Couldn't copy. Select the text and copy it.", !ok);
    }
  }
  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new Error("Can't reach the server. Check your connection."); }
    let text;
    try { text = await r.text(); } catch (e) { throw new Error("The connection dropped. Try again."); }
    let j = {};
    if (text) {
      try { j = JSON.parse(text); } catch (e) { if (r.ok) throw new Error("The server sent something unexpected. Reload the page and try again."); }
    }
    if (!r.ok) throw new Error(j.error || (r.status === 429 ? "Slow down a little." : "Request failed (" + r.status + ")"));
    return j;
  }
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------------ result widgets
  const tile = (label, value, sub, cls) => html`<div class="tile ${cls || ""}"><small>${label}</small><b>${value}</b>${sub ? html`<i>${sub}</i>` : ""}</div>`;
  const tiles = list => html`<div class="tiles">${list}</div>`;
  const note = (level, text) => html`<div class="note ${level || "info"}">${text}</div>`;
  const kvTable = rows => html`<table class="kv"><tbody>${rows.map(([k, v]) => html`<tr><th scope="row">${k}</th><td>${v}</td></tr>`)}</tbody></table>`;
  const table = (heads, rows, cls) => html`<div class="tw"><table class="${cls || ""}"><thead><tr>${heads.map(h => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map(r => html`<tr>${r.map(c => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;

  // ------------------------------------------------------------------ form fields
  // spec: {id, label, type: num|int|text|select|seg|check|textarea|date|<unit kind>, unit, hint, min, max, step, options, show, def, wide}
  const isKind = t => Object.prototype.hasOwnProperty.call(KINDS, t);
  function fieldHtml(f, vals) {
    const id = "f_" + f.id, v = vals[f.id];
    const hidden = f.show && !f.show(vals);
    if (f.hidden) return "";   // remembered with the page's values, never shown
    const label = typeof f.label === "function" ? f.label(vals) : f.label;
    const hint = typeof f.hint === "function" ? f.hint(vals) : f.hint;
    const opts = typeof f.options === "function" ? f.options(vals) : f.options;
    let input, unit = "";
    if (f.type === "select") {
      input = html`<select id="${id}" data-f="${f.id}">${opts.map(([val, label]) => html`<option value="${val}"${String(val) === String(v) ? " selected" : ""}>${label}</option>`)}</select>`;
    } else if (f.type === "seg") {
      input = html`<div class="seg" role="group" aria-label="${label}" data-f="${f.id}">${opts.map(([val, label]) => html`<button type="button" aria-pressed="${String(val) === String(v)}" data-v="${val}" class="${String(val) === String(v) ? "on" : ""}">${label}</button>`)}</div>`;
    } else if (f.type === "check") {
      input = html`<label class="check"><input type="checkbox" id="${id}" data-f="${f.id}"${v ? " checked" : ""}> <span>${f.checkLabel || label}</span></label>`;
    } else if (f.type === "textarea") {
      input = html`<textarea id="${id}" data-f="${f.id}" rows="${f.rows || 2}" maxlength="${f.max || 1000}">${v == null ? "" : v}</textarea>`;
    } else if (f.type === "text" || f.type === "date") {
      input = html`<input id="${id}" data-f="${f.id}" type="${f.type === "date" ? "date" : "text"}" value="${v == null ? "" : v}"${f.max ? html` maxlength="${f.max}"` : ""}${f.placeholder ? html` placeholder="${f.placeholder}"` : ""} autocomplete="off">`;
    } else {
      const kind = isKind(f.type);
      const shown = v == null || v === "" || !isFinite(v) ? "" : kind ? fmtInput(U.show(f.type, v)) : fmt(v, f.dp == null ? 6 : f.dp);
      unit = kind ? U.unit(f.type) : typeof f.unit === "function" ? f.unit(vals) : f.unit || "";
      input = html`<input id="${id}" data-f="${f.id}" type="number" inputmode="decimal" step="${f.step || "any"}"${f.min != null ? html` min="${kind ? fmt(U.show(f.type, f.min), 6) : f.min}"` : ""}${f.max != null ? html` max="${kind ? fmt(U.show(f.type, f.max), 6) : f.max}"` : ""} value="${shown}">`;
    }
    const cls = "field" + (f.wide || f.type === "seg" || f.type === "textarea" ? " wide" : "") + (f.type === "check" ? " checkrow" : "");
    return html`<div class="${cls}" data-for="${f.id}"${hidden ? " hidden" : ""}>${f.type === "check" || f.type === "seg" ? (f.type === "seg" ? html`<span class="lbl">${label}</span>` : "") : html`<label for="${id}">${label}</label>`}<div class="${unit ? "withunit" : ""}">${input}${unit ? html`<span class="unit">${unit}</span>` : ""}</div>${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
  }
  const sameValue = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b || (a == null && b == null));
  const isLive = (f, vals) => !f.show || f.show(vals);
  const moreSummary = (label, changed) => html`${label}${changed ? html` <span class="badge info">${changed} changed</span>` : ""}`;
  /**
   * The form. Fields marked `adv` go under a "More options" fold so the page only asks for what matters.
   * The fold opens by itself when one of them is not at its default, unless `opts.open` says otherwise.
   * opts.label renames it; opts.badge === false hides the "N changed" count (for prefilled dialogs).
   */
  function fieldsHtml(specs, vals, opts = {}) {
    const grid = list => html`<div class="fields">${list.map(f => fieldHtml(f, vals))}</div>`;
    const adv = specs.filter(f => f.adv);
    if (!adv.length) return grid(specs);
    const live = adv.filter(f => isLive(f, vals));
    const changed = live.filter(f => !sameValue(vals[f.id], f.def)).length;
    const open = opts.open != null ? opts.open : changed > 0;
    const label = opts.label || "More options", badge = opts.badge !== false;
    return html`${grid(specs.filter(f => !f.adv))}<details class="more" data-more data-label="${label}" data-badge="${badge ? 1 : 0}"${live.length ? "" : " hidden"}${open ? " open" : ""}><summary>${moreSummary(label, badge ? changed : 0)}</summary>${grid(adv)}</details>`;
  }

  /** Read one control into `vals` (canonical units). Returns the field id, or null. */
  function readControl(target, specs, vals) {
    const holder = target.closest("[data-f]");
    if (!holder) return null;
    const spec = specs.find(s => s.id === holder.dataset.f);
    if (!spec) return null;
    let v;
    if (spec.type === "seg") {
      const b = target.closest("button[data-v]");
      if (!b) return null;
      v = b.dataset.v;
    } else if (spec.type === "check") v = holder.checked;
    else v = holder.value;
    if (spec.type === "select" || spec.type === "seg") {
      if (spec.number) v = +v;
    } else if (spec.type === "text" || spec.type === "textarea" || spec.type === "date") {
      v = String(v);
    } else if (spec.type !== "check") {
      const n = v === "" ? NaN : parseFloat(v);
      v = isFinite(n) ? (isKind(spec.type) ? U.parse(spec.type, n) : n) : null;
    }
    vals[spec.id] = v;
    return spec.id;
  }
  /** Bind a container's controls to `vals`; onChange(id) fires after each edit. Re-binding a container replaces the old listeners. */
  function bindForm(root, specs, vals, onChange) {
    const refresh = () => {
      specs.forEach(s => { const w = $(`[data-for="${s.id}"]`, root); if (w && s.show) w.hidden = !s.show(vals); });
      const fold = $("details[data-more]", root);
      if (fold) {
        const adv = specs.filter(f => f.adv && isLive(f, vals));
        fold.hidden = !adv.length;
        $("summary", fold).innerHTML = moreSummary(fold.dataset.label, fold.dataset.badge === "1" ? adv.filter(f => !sameValue(vals[f.id], f.def)).length : 0).s;
      }
    };
    const apply = e => {
      const id = readControl(e.target, specs, vals);
      if (id == null) return;
      const spec = specs.find(s => s.id === id);
      if (spec.type === "seg") {
        $$("button", e.target.closest("[data-f]")).forEach(b => { const on = b.dataset.v === String(vals[id]); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      }
      refresh();
      onChange && onChange(id);
    };
    if (root._bound) for (const [type, fn] of root._bound) root.removeEventListener(type, fn);
    const handlers = [
      ["input", e => { if (!e.target.matches("select, button")) apply(e); }],
      ["change", e => { if (e.target.matches("select, input[type=checkbox], input[type=date]")) apply(e); }],
      ["click", e => { if (e.target.closest(".seg button")) apply(e); }],
    ];
    for (const [type, fn] of handlers) root.addEventListener(type, fn);
    root._bound = handlers;
    refresh();
    return { refresh };
  }
  const defaultsOf = specs => Object.fromEntries(specs.map(s => [s.id, s.def]));
  const isNumericSpec = f => f.type === "num" || f.type === "int" || isKind(f.type);
  /**
   * Checks the visible number boxes before a page calculates.
   * A blank box is `null`. Boxes whose default is 0 (or that say `optional`) mean "off / automatic", so blank is 0;
   * any other blank box, a negative number (unless `allowNegative`), or a value outside min/max stops the calculation with a plain message.
   * Returns {issues: [text], bad: [ids of the boxes at fault], vals: cleaned copy}.
   */
  function checkVals(specs, vals) {
    const clean = Object.assign({}, vals), issues = [], bad = [];
    for (const f of specs) {
      if (!isNumericSpec(f) || (f.show && !f.show(vals))) continue;
      const v = vals[f.id], n = issues.length;
      if (v == null) { if (f.def === 0 || f.optional) clean[f.id] = 0; else issues.push(`Fill in “${f.label}”.`); }
      else if (!isFinite(v)) issues.push(`“${f.label}” isn't a usable number.`);
      else if (v < 0 && !f.allowNegative) issues.push(`“${f.label}” can't be negative.`);
      else if (f.min != null && v < f.min - 1e-12) issues.push(`“${f.label}” must be at least ${isKind(f.type) ? U.fmt(f.type, f.min) : fmt(f.min, 4)}.`);
      else if (f.max != null && v > f.max + 1e-12) issues.push(`“${f.label}” must be at most ${isKind(f.type) ? U.fmt(f.type, f.max) : fmt(f.max, 4)}.`);
      if (issues.length > n) bad.push(f.id);
    }
    return { issues, vals: clean, bad };
  }

  // ------------------------------------------------------------------ dialogs
  /**
   * Modal form. fields: specs, values: starting values (canonical). onSubmit(values) may throw to show an error inline.
   */
  function openForm({ title, fields, values, submit, intro, onSubmit, extra, fold }) {
    const dlg = $("#dlg"), form = $("#dlgForm");
    const vals = Object.assign(defaultsOf(fields), values || {});
    dlg.setAttribute("aria-labelledby", "dlgTitle");
    const more = (extra || []).map((x, i) => html`<button type="button" class="btn ${x.cls || ""}" data-x="${i}">${x.label}</button>`);
    form.innerHTML = html`<h2 id="dlgTitle">${title}</h2>${intro ? html`<p class="mut">${intro}</p>` : ""}${fieldsHtml(fields, vals, Object.assign({ open: false, badge: false }, fold))}<div class="err" role="alert" hidden></div><div class="dact">${more.length ? html`<span class="xtra">${more}</span>` : ""}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn pri" type="submit">${submit || "Save"}</button></div>`.s;
    bindForm(form, fields, vals);
    const err = $(".err", form);
    $("[data-cancel]", form).onclick = () => dlg.close();
    // extra buttons (copy, delete): onClick(values) may return false to keep the dialog open, or throw to show a message
    $$("[data-x]", form).forEach(b => {
      b.onclick = async () => {
        err.hidden = true;
        try { if ((await extra[+b.dataset.x].onClick(vals)) !== false) dlg.close(); }
        catch (e) { err.textContent = e.message; err.hidden = false; }
      };
    });
    form.onsubmit = async ev => {
      ev.preventDefault();
      const btn = $("button[type=submit]", form);
      btn.disabled = true; err.hidden = true;
      try { await onSubmit(vals); dlg.close(); }
      catch (e) { err.textContent = friendlyError(e.message, fields); err.hidden = false; }
      finally { btn.disabled = false; }
    };
    dlg.showModal();
    const first = $("input:not([type=hidden]), select, textarea", form);
    if (first) first.focus();
  }
  function friendlyError(msg, specs) {
    const m = /^(\w+):\s*(.*)$/.exec(msg);
    if (!m) return msg;
    const f = (specs || []).find(s => s.id === m[1] || s.serverName === m[1]);
    return f ? `${f.label}: ${m[2]}` : msg;
  }
  const confirmDialog = msg => Promise.resolve(window.confirm(msg));

  /** Keep what matters in view: every warning, plus the first few tips. The rest sit behind one "more tips" line. */
  function foldNotes(root, max = 2) {
    const notes = $$(".note", root).filter(n => !n.closest("details"));
    if (notes.length <= max) return;
    const keep = new Set(notes.filter(n => n.classList.contains("bad") || n.classList.contains("warn")));
    for (const n of notes) { if (keep.size >= max) break; keep.add(n); }
    const hide = notes.filter(n => !keep.has(n));
    if (!hide.length) return;
    const d = document.createElement("details");
    d.className = "more tips";
    const sm = document.createElement("summary");
    sm.textContent = hide.length === 1 ? "1 more tip" : hide.length + " more tips";
    d.append(sm);
    hide[0].before(d);
    hide.forEach(n => d.append(n));
  }

  // ------------------------------------------------------------------ page registry and the standard "form + results" page
  App.register = def => { App.pages[def.id] = def; };
  /**
   * Draw a form into `el` and keep `vals` in step with it. `key` names this form so the page can remember whether
   * "More options" was left open. onChange(id, redraw) runs after every edit. Returns {draw, openMore}.
   */
  function mountForm(el, specs, vals, key, onChange) {
    const moreKey = "more:" + key;
    el.addEventListener("click", e => {
      const sm = e.target.closest("details[data-more] > summary");
      if (sm) store.set(moreKey, !sm.parentElement.open);   // the click is about to flip it (written now, so a quick reload can't lose it)
    });
    const draw = () => {
      el.innerHTML = fieldsHtml(specs, vals, { open: store.get(moreKey, null) }).s;
      bindForm(el, specs, vals, id => onChange(id, draw));
    };
    draw();
    return { draw, openMore() { const d = $("details[data-more]", el); if (d) d.open = true; } };
  }

  /**
   * cfg: {id, title, keywords, intro, fields | ()=>fields, init(vals), onChange(id, vals) -> "redraw"?, compute(vals) -> html, after(out, vals, root), extra: html}
   */
  function calcPage(cfg) {
    App.register({
      id: cfg.id, title: cfg.title, keywords: cfg.keywords || "",
      render(root) {
        const specs = typeof cfg.fields === "function" ? cfg.fields() : cfg.fields;
        const vals = App.pageVals(cfg.id, specs);
        if (cfg.init) cfg.init(vals);
        root.innerHTML = html`<h1>${cfg.title}</h1>${cfg.intro ? html`<p class="mut lead">${cfg.intro}</p>` : ""}
          <div class="two"><section class="card"><div id="form"></div></section><section class="card" id="out" aria-live="polite"></section></div>${cfg.extra || ""}`.s;
        let form;
        const update = () => {
          App.persist(cfg.id, vals);
          const out = $("#out", root);
          const chk = checkVals(specs, vals);
          setHtml(out, chk.issues.length ? raw(chk.issues.map(t => note("info", t)).join("")) : cfg.compute(chk.vals) || "");
          if (chk.issues.length) {
            if (chk.bad.some(id => (specs.find(f => f.id === id) || {}).adv)) form.openMore();   // the problem is in a tucked-away box: show it
          } else {
            foldNotes(out);
            if (cfg.after) cfg.after(out, chk.vals, root);
          }
        };
        form = mountForm($("#form", root), specs, vals, cfg.id, (id, redraw) => { if (cfg.onChange && cfg.onChange(id, vals) === "redraw") redraw(); update(); });
        update();
      },
    });
  }

  Object.assign(App, { calcPage, mountForm, checkVals, foldNotes, Raw, raw, esc, html, $, $$, setHtml, fmt, fmtInput, group, KINDS, U, store, toast, copyText, api, download, tile, tiles, note, kvTable, table,
    fieldHtml, fieldsHtml, readControl, bindForm, defaultsOf, openForm, friendlyError, confirmDialog, isKind });
})();
