(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const IN = 25.4;
  const S = { data: null, tab: "calc", unit: "mm", job: { tool: 0, mat: 0, op: "slot", total: 6, cool: "air", agg: 100, stick: 0 } };
  try {
    S.unit = localStorage.getItem("unit") || "";
    Object.assign(S.job, JSON.parse(localStorage.getItem("job") || "{}"));
  } catch (e) {}
  const saveJob = () => { try { localStorage.setItem("job", JSON.stringify(S.job)); } catch (e) {} };
  const hashTab = location.hash.slice(1);

  const DEFAULTS = {
    tools: { kind: "flat", nominal_mm: 3, actual_mm: 3, flutes: 1, flute_len_mm: 12, overall_mm: 40, shank_mm: 3, mat: "carbide", feed_factor: 1 },
    materials: { heat: "metal", sfm_carbide: 500, sfm_hss: 200, fz_ratio: 0.015, kc: 700, doc_slot: 0.3, doc_side: 1, woc: 0.15, plunge: 0.3 },
    recipes: { op: "profile", rating: 3, rpm: 0, feed_mm: 0, plunge_mm: 0, doc_mm: 0, woc_mm: 0 },
  };
  const HELP = {
    nominal_mm: "Size printed on the tool.", actual_mm: "Measured cutting diameter. Used for all calculations and CAM.",
    feed_factor: "Scale chipload for this tool. Use below 1 for flimsy or cheap tools.", flute_len_mm: "Deepest you can cut with this tool.",
    sfm_carbide: "Surface speed for carbide tools (feet/min).", sfm_hss: "Surface speed for HSS tools (feet/min).",
    fz_ratio: "Chipload per tooth as a fraction of tool diameter.", kc: "Specific cutting force; drives spindle load and deflection estimates.",
    doc_slot: "Depth per pass when slotting, as a multiple of tool diameter.", doc_side: "Depth per pass for side cuts, × diameter.",
    woc: "Radial engagement for side cuts, × diameter.", plunge: "Plunge feed as a fraction of cutting feed.",
    rating: "How well this setting worked (5 = perfect).",
  };
  const TABS = [["calc", "Calculator"], ["tools", "Tools"], ["materials", "Materials"], ["recipes", "Saved settings"], ["settings", "Machine"]];
  const KINDS = ["flat", "ball", "face", "bull", "other"];
  const FIELDS = {
    tools: [
      ["name", "Name", "text", 2], ["vendor", "Vendor", "text"], ["kind", "Type", "select", KINDS],
      ["nominal_mm", "Nominal dia (mm)", "number"], ["actual_mm", "Actual cutting dia (mm)", "number"], ["flutes", "Flutes", "number"],
      ["flute_len_mm", "Flute length (mm)", "number"], ["overall_mm", "Overall length (mm)", "number"], ["shank_mm", "Shank dia (mm)", "number"],
      ["mat", "Tool material", "select", ["carbide", "hss"]], ["coating", "Coating", "text"], ["feed_factor", "Feed factor (1 = normal)", "number"],
      ["notes", "Notes", "textarea", 2],
    ],
    materials: [
      ["name", "Name", "text", 2], ["heat", "Class", "select", ["metal", "plastic", "wood"]],
      ["sfm_carbide", "Carbide SFM", "number"], ["sfm_hss", "HSS SFM", "number"],
      ["fz_ratio", "Chipload / tool dia", "number"], ["kc", "Cutting force kc (N/mm²)", "number"],
      ["doc_slot", "Slot depth (× dia)", "number"], ["doc_side", "Side depth (× dia)", "number"],
      ["woc", "Side width (× dia)", "number"], ["plunge", "Plunge factor (× feed)", "number"],
      ["notes", "Notes", "textarea", 2],
    ],
    recipes: [
      ["tool_id", "Tool", "ref:tools"], ["material_id", "Material", "ref:materials"],
      ["op", "Operation", "select", Object.keys(Calc.OPS)], ["rating", "Rating (1-5)", "number"],
      ["rpm", "RPM", "number"], ["feed_mm", "Feed (mm/min)", "number"], ["plunge_mm", "Plunge (mm/min)", "number"],
      ["doc_mm", "Depth/pass (mm)", "number"], ["woc_mm", "Width of cut (mm)", "number"],
      ["notes", "Notes", "textarea", 2],
    ],
  };

  // ---------- formatting ----------
  const n = (x, d) => (+x).toFixed(d).replace(/\.0+$|(\.\d*?)0+$/, "$1");
  const inch = () => S.unit === "in";
  const L = mm => (inch() ? n(mm / IN, 4) + " in" : n(mm, 2) + " mm");
  const L2 = mm => (inch() ? n(mm, 2) + " mm" : n(mm / IN, 4) + " in");
  const F = v => (inch() ? n(v / IN, 1) + " in/min" : Math.round(v) + " mm/min");
  const F2 = v => (inch() ? Math.round(v) + " mm/min" : n(v / IN, 1) + " in/min");
  const toMm = x => (inch() ? x * IN : x);
  const fromMm = x => (inch() ? x / IN : x);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const byId = (list, id) => list.find(x => x.id === +id);

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2500);
  }
  async function api(method, path, body) {
    let r;
    try { r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Error("Can't reach the server"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && path !== "/api/login" && S.data && S.data.admin) { S.data.admin = false; chrome(); throw new Error("Session expired. Log in again."); }
      throw new Error(j.error || r.statusText);
    }
    return j;
  }
  async function load() {
    S.data = await api("GET", "/api/state");
    if (S.unit !== "mm" && S.unit !== "in") S.unit = S.data.settings.units;
    const d = S.data;
    if (!["calc", "tools", "materials", "recipes", "settings"].includes(S.tab)) S.tab = "calc";
    if (!byId(d.tools, S.job.tool)) {
      const pref = d.tools.find(t => /thrifty bot 5/i.test(t.name)) || d.tools[0];
      S.job.tool = pref ? pref.id : 0;
    }
    if (!byId(d.materials, S.job.mat)) S.job.mat = d.materials[0] ? d.materials[0].id : 0;
  }
  async function reload() { await load(); chrome(); render(); }

  // ---------- chrome ----------
  function chrome() {
    $("#tabs").innerHTML = TABS.map(([k, l]) => `<button data-t="${k}" class="${S.tab === k ? "on" : ""}">${l}</button>`).join("");
    document.querySelectorAll("#unitSeg button").forEach(b => b.classList.toggle("on", b.dataset.u === S.unit));
    const a = $("#authBtn");
    a.textContent = S.data.admin ? "Log out" : "Admin login";
    a.title = S.data.admin_configured ? "" : "ADMIN_PASSWORD is not set on the server";
  }
  $("#tabs").addEventListener("click", e => { const t = e.target.dataset.t; if (t) { S.tab = t; history.replaceState(null, "", "#" + t); chrome(); render(); } });
  $("#unitSeg").addEventListener("click", e => {
    const u = e.target.dataset.u; if (!u) return;
    S.unit = u; try { localStorage.setItem("unit", u); } catch (x) {}
    chrome(); render();
  });
  $("#authBtn").addEventListener("click", async () => {
    if (S.data.admin) { await api("POST", "/api/logout", {}); toast("Logged out"); return reload(); }
    await login();
  });
  async function login() {
    const pw = prompt("Admin password:"); if (pw === null) return false;
    try { await api("POST", "/api/login", { password: pw }); toast("Logged in"); await reload(); return true; }
    catch (e) { toast(e.message); return false; }
  }
  async function needAdmin() {
    if (S.data.admin) return true;
    return login();
  }

  // ---------- render ----------
  function render() {
    const v = $("#view");
    v.onclick = null;
    v.className = S.tab === "calc" ? "" : "one";
    ({ calc: viewCalc, tools: viewList, materials: viewList, recipes: viewList, settings: viewSettings })[S.tab](v);
  }

  function opts(list, sel, label = x => x.name) {
    return list.map(x => `<option value="${x.id}" ${x.id === +sel ? "selected" : ""}>${esc(label(x))}</option>`).join("");
  }

  function viewCalc(v) {
    const d = S.data, j = S.job;
    if (!d.tools.length || !d.materials.length) { v.innerHTML = `<section>Add at least one tool and one material first.</section>`; return; }
    const sizes = d.tools.slice().sort((x, y) => x.actual_mm - y.actual_mm);
    v.innerHTML = `
      <section>
        <h2>Pick material &amp; endmill</h2>
        <label>Material</label><select id="jMat">${opts(d.materials, j.mat)}</select>
        <label>Endmill size</label><select id="jTool">${opts(sizes, j.tool, t => `${t.actual_mm} mm - ${t.name} (${t.flutes}F)`)}</select>
        <div id="toolInfo" class="mut"></div>
        <details style="margin-top:10px"><summary>More options (operation, depth, stick-out, cooling)</summary>
        <label>Operation</label><select id="jOp">${Object.entries(Calc.OPS).map(([k, o]) => `<option value="${k}" ${k === j.op ? "selected" : ""}>${o.label}</option>`).join("")}</select>
        <div class="row">
          <div><label>Total depth (${S.unit})</label><input id="jTotal" type="number" step="any" min="0" value="${n(fromMm(j.total), 4)}"></div>
          <div><label>Stick-out (${S.unit}, 0 = auto)</label><input id="jStick" type="number" step="any" min="0" value="${n(fromMm(j.stick), 4)}"></div>
        </div>
        <label>Cooling</label>
        <select id="jCool"><option value="flood">Flood / mist</option><option value="air">Air blast</option><option value="none">None</option></select>
        <label>Aggressiveness: <b id="aggV"></b></label>
        <input id="jAgg" type="range" min="50" max="130" value="${j.agg}">
        <div class="mut">Lower it if the cut sounds rough or the machine flexes.</div>
        </details>
      </section>
      <section>
        <h2>Result</h2>
        <div class="res" id="res"></div>
        <div id="notes"></div>
        <div class="bar" style="margin-top:12px">
          <button id="copyBtn">Copy CAM settings</button>
          <button id="saveRecipe" class="pri">Save as known-good</button>
        </div>
        <h2 style="margin-top:14px">Saved settings for this tool &amp; material</h2>
        <div id="saved" class="tw"></div>
      </section>`;
    $("#jCool").value = j.cool;
    const on = (id, fn) => $(id).addEventListener("input", fn);
    on("#jTool", e => { j.tool = +e.target.value; saveJob(); update(); });
    on("#jMat", e => { j.mat = +e.target.value; saveJob(); update(); });
    on("#jOp", e => { j.op = e.target.value; saveJob(); update(); });
    on("#jTotal", e => { j.total = toMm(+e.target.value || 0); saveJob(); update(); });
    on("#jStick", e => { j.stick = toMm(+e.target.value || 0); saveJob(); update(); });
    on("#jCool", e => { j.cool = e.target.value; saveJob(); update(); });
    on("#jAgg", e => { j.agg = +e.target.value; saveJob(); update(); });
    $("#copyBtn").onclick = copyCam;
    $("#saveRecipe").onclick = saveCurrent;
    update();
  }

  let LAST = null;
  function update() {
    const d = S.data, j = S.job;
    const tool = byId(d.tools, j.tool), mat = byId(d.materials, j.mat);
    $("#aggV").textContent = j.agg + "%";
    const under = tool.nominal_mm - tool.actual_mm;
    $("#toolInfo").textContent = `${tool.mat}, ${tool.flutes} flute${tool.flutes > 1 ? "s" : ""}, flute length ${tool.flute_len_mm} mm` +
      (under > 0.05 ? `, undersized by ${n(under, 2)} mm (nominal ${tool.nominal_mm} mm)` : "");
    const r = Calc.compute(tool, mat, j.op, { agg: j.agg / 100, total_mm: j.total, stick_mm: j.stick, cool: j.cool }, d.settings);
    LAST = { tool, mat, r };
    const k = (t, v, s, c = "") => `<div class="k ${c}"><small>${t}</small><b>${v}</b><i>${s}</i></div>`;
    const chip = inch() ? n(r.fz / IN, 5) + " in/tooth" : n(r.fz, 4) + " mm/tooth";
    $("#res").innerHTML =
      k("Spindle", Math.round(r.rpm).toLocaleString() + " rpm", Math.round(r.sfm) + " SFM", "main") +
      k("Cutting feed", F(r.feed), F2(r.feed), "main") +
      k("Plunge", F(r.plunge), F2(r.plunge)) +
      k("Ramp feed", F(r.ramp), F2(r.ramp)) +
      k("Chipload", chip, r.thin > 1.01 ? `incl. chip-thin ×${n(r.thin, 2)}` : "per tooth") +
      k("Depth / pass", L(r.doc), (r.passes ? `${r.passes} pass${r.passes > 1 ? "es" : ""} · ` : "") + `limited by ${r.docLimit}`) +
      k("Width of cut", r.ae > 0 ? L(r.ae) : "-", Math.round(r.aeFrac * 100) + "% of dia") +
      k("Removal rate", n(r.mrr_mm3min / 1000, 2) + " cm³/min", "") +
      k("Spindle load", `${Math.round(r.power_w)} W`, `of ${Math.round(r.avail_w)} W available · ${n(r.torque_nm, 2)} N·m`) +
      k("Tool deflection", inch() ? n(r.defl_mm / IN * 1000, 2) + " thou" : n(r.defl_mm * 1000, 1) + " µm", `${n(r.force_n, 0)} N peak · stick-out ${L(r.stick_mm)}`);
    $("#notes").innerHTML = r.notes.map(x => `<div class="note ${x.level === "info" ? "" : x.level}">${esc(x.text)}</div>`).join("");
    renderSaved();
  }

  function renderSaved() {
    const d = S.data, j = S.job, r = LAST.r;
    const list = d.recipes.filter(x => x.tool_id === +j.tool && x.material_id === +j.mat);
    const box = $("#saved");
    if (!list.length) { box.innerHTML = `<div class="mut">Nothing saved yet. Dial in a cut, then use “Save as known-good”.</div>`; return; }
    box.innerHTML = `<table><tr><th>Op</th><th>RPM</th><th>Feed</th><th>Depth</th><th>Width</th><th>vs calc</th><th>Notes</th></tr>` +
      list.map(x => `<tr><td>${esc(x.op)} <span class="stars">${"★".repeat(x.rating)}</span></td><td>${Math.round(x.rpm)}</td><td>${F(x.feed_mm)}</td>
        <td>${x.doc_mm ? L(x.doc_mm) : "-"}</td><td>${x.woc_mm ? L(x.woc_mm) : "-"}</td>
        <td>${x.op === j.op && r.feed ? Math.round((x.feed_mm / r.feed - 1) * 100) + "% feed" : ""}</td><td>${esc(x.notes)}</td></tr>`).join("") + `</table>`;
  }

  function copyCam() {
    const { tool, mat, r } = LAST;
    const txt = [`Tool: ${tool.name}`, `CAM diameter: ${tool.actual_mm} mm (${n(tool.actual_mm / IN, 4)} in), ${tool.flutes} flute`,
      `Material: ${mat.name}`, `Spindle: ${Math.round(r.rpm)} rpm`,
      `Cutting feed: ${Math.round(r.feed)} mm/min (${n(r.feed / IN, 1)} in/min)`, `Plunge: ${Math.round(r.plunge)} mm/min (${n(r.plunge / IN, 1)} in/min)`,
      `Ramp: ${Math.round(r.ramp)} mm/min`, `Depth/pass: ${n(r.doc, 2)} mm (${n(r.doc / IN, 4)} in)`,
      `Width of cut: ${n(r.ae, 2)} mm`].join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Copied"), () => prompt("Copy:", txt));
  }
  async function saveCurrent() {
    if (!(await needAdmin())) return;
    const { tool, mat, r } = LAST;
    edit("recipes", { tool_id: tool.id, material_id: mat.id, op: S.job.op, rpm: Math.round(r.rpm), feed_mm: Math.round(r.feed),
      plunge_mm: Math.round(r.plunge), doc_mm: +n(r.doc, 3), woc_mm: +n(r.ae, 3), rating: 3, notes: "" }, true);
  }

  // ---------- list views ----------
  const COLS = {
    tools: [["Name", t => esc(t.name)], ["Nominal", t => t.nominal_mm + " mm"], ["Actual", t => `<b>${t.actual_mm} mm</b>`], ["Fl", t => t.flutes],
      ["Mat", t => t.mat], ["Flute len", t => t.flute_len_mm + " mm"], ["Feed ×", t => t.feed_factor], ["Notes", t => esc(t.notes)]],
    materials: [["Name", m => esc(m.name)], ["Class", m => m.heat], ["SFM carb", m => m.sfm_carbide], ["SFM HSS", m => m.sfm_hss],
      ["Chip/dia", m => m.fz_ratio], ["kc", m => m.kc], ["Slot D×", m => m.doc_slot], ["Side D×", m => m.doc_side], ["WOC×", m => m.woc], ["Notes", m => esc(m.notes)]],
    recipes: [["Tool", r => esc((byId(S.data.tools, r.tool_id) || {}).name || "?")], ["Material", r => esc((byId(S.data.materials, r.material_id) || {}).name || "?")],
      ["Op", r => r.op], ["RPM", r => Math.round(r.rpm)], ["Feed", r => F(r.feed_mm)], ["Plunge", r => F(r.plunge_mm)],
      ["Depth", r => (r.doc_mm ? L(r.doc_mm) : "-")], ["Width", r => (r.woc_mm ? L(r.woc_mm) : "-")], ["Rating", r => `<span class="stars">${"★".repeat(r.rating)}</span>`], ["Notes", r => esc(r.notes)]],
  };
  const TITLE = { tools: "Tools", materials: "Materials", recipes: "Saved settings" };

  function viewList(v) {
    const t = S.tab, d = S.data;
    const extra = t === "tools" ? `<button id="imp">Import Fusion .tools</button><input id="impf" type="file" accept=".tools,.json,.zip" hidden>` : "";
    v.innerHTML = `<section>
      <div class="bar"><h2>${TITLE[t]} (${d[t].length})</h2><div>${extra}<button id="add" class="pri">Add</button></div></div>
      ${t === "tools" ? `<div class="mut" style="margin-bottom:8px">The calculator uses the <b>actual</b> cutting diameter, so undersized tools get correct speeds, chipload and engagement.</div>` : ""}
      ${t === "recipes" ? `<div class="mut" style="margin-bottom:8px">Settings you've proven on the machine. Shown next to the calculated values.</div>` : ""}
      <div class="tw"><table><tr>${COLS[t].map(c => `<th>${c[0]}</th>`).join("")}<th></th></tr>
      ${d[t].map(r => `<tr>${COLS[t].map(c => `<td>${c[1](r)}</td>`).join("")}<td class="act"><button data-e="${r.id}">Edit</button><button data-c="${r.id}">Copy</button><button class="del" data-d="${r.id}">Delete</button></td></tr>`).join("")}
      </table></div></section>`;
    $("#add").onclick = async () => { if (await needAdmin()) edit(t, {}, true); };
    v.onclick = async e => {
      const b = e.target.closest("button"); if (!b) return;
      const id = b.dataset.e || b.dataset.c || b.dataset.d; if (!id) return;
      if (!(await needAdmin())) return;
      const row = byId(d[t], id);
      if (b.dataset.e) edit(t, row, false);
      else if (b.dataset.c) edit(t, { ...row, name: row.name ? row.name + " copy" : row.name }, true);
      else if (confirm(`Delete “${row.name || "this saved setting"}”` + (t !== "recipes" ? " and its saved settings" : "") + "?")) {
        try { await api("DELETE", `/api/${t}/${id}`); toast("Deleted"); await reload(); } catch (x) { toast(x.message); }
      }
    };
    if (t === "tools") {
      $("#imp").onclick = async () => { if (await needAdmin()) $("#impf").click(); };
      $("#impf").onchange = ev => ev.target.files[0] && importTools(ev.target.files[0]);
    }
  }

  function edit(table, row, isNew) {
    const f = $("#dlgForm");
    const d = S.data;
    if (isNew) row = { ...DEFAULTS[table], ...row };
    const cells = FIELDS[table].map(([k, label, type, extra]) => {
      const val = row[k] !== undefined ? row[k] : "";
      let input;
      if (type === "select") input = `<select name="${k}">${extra.map(o => `<option ${o === val ? "selected" : ""}>${o}</option>`).join("")}</select>`;
      else if (type === "textarea") input = `<textarea name="${k}" rows="2">${esc(val)}</textarea>`;
      else if (type.startsWith("ref:")) {
        const list = d[type.slice(4)];
        input = `<select name="${k}">${opts(list, val || (list[0] && list[0].id))}</select>`;
      } else input = `<input name="${k}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${esc(val)}">`;
      const span = extra === 2 ? ' style="grid-column:1/-1"' : "";
      return `<div${span}><label>${label}</label>${input}${HELP[k] ? `<div class="mut">${esc(HELP[k])}</div>` : ""}</div>`;
    }).join("");
    f.innerHTML = `<h2>${isNew ? "Add" : "Edit"} ${table.slice(0, -1)}</h2><div class="row">${cells}</div>
      <div class="dact"><button value="cancel" type="button" id="dc">Cancel</button><button class="pri" value="ok" id="dok">Save</button></div>`;
    const dlg = $("#dlg"); dlg.showModal();
    $("#dc").onclick = () => dlg.close();
    f.onsubmit = async ev => {
      ev.preventDefault();
      const body = {};
      FIELDS[table].forEach(([k, , type]) => { const el = f.elements[k]; body[k] = type === "number" || type.startsWith("ref:") ? +el.value : el.value; });
      try {
        await (isNew ? api("POST", `/api/${table}`, body) : api("PUT", `/api/${table}/${row.id}`, body));
        dlg.close(); toast("Saved"); await reload();
      } catch (x) { toast(friendly(table, x.message)); }
    };
  }
  function friendly(table, msg) {
    const f = (FIELDS[table] || []).find(x => msg.startsWith(x[0] + ":"));
    return f ? f[1] + msg.slice(f[0].length) : msg;
  }

  // ---------- machine settings ----------
  function viewSettings(v) {
    const s = S.data.settings;
    const rows = [["min_rpm", "Minimum spindle RPM"], ["max_rpm", "Maximum spindle RPM"], ["max_feed_mm", "Maximum cutting feed (mm/min)"],
      ["spindle_w", "Spindle power (W)"], ["defl_limit_mm", "Allowed tool deflection (mm)"]];
    v.innerHTML = `<section><h2>Machine limits</h2><div class="row">${rows.map(([k, l]) => `<div><label>${l}</label><input name="${k}" type="number" step="any" value="${s[k]}"></div>`).join("")}
      <div><label>Default units</label><select name="units"><option>mm</option><option>in</option></select></div></div>
      <div class="mut" style="margin-top:8px">Spindle power is used to cap depth of cut (power falls with RPM). Deflection is estimated from cutting force and stick-out; 0.02 mm is a good finish limit.</div>
      <div class="dact"><button id="ex">Download backup (JSON)</button><button id="sv" class="pri">Save</button></div></section>`;
    $("#ex").onclick = async () => {
      if (!(await needAdmin())) return;
      try {
        const r = await fetch("/api/export"); if (!r.ok) throw new Error("Export failed");
        const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "cnc-data.json"; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (x) { toast(x.message); }
    };
    $("select[name=units]", v).value = s.units;
    $("#sv").onclick = async () => {
      if (!(await needAdmin())) return;
      const b = {}; v.querySelectorAll("input,select").forEach(el => { b[el.name] = el.name === "units" ? el.value : +el.value; });
      try { await api("PUT", "/api/settings", b); toast("Saved"); await reload(); } catch (x) { toast(x.message); }
    };
  }

  // ---------- Fusion .tools import ----------
  // Minimal ZIP reader (stored/deflate) so no external library is needed.
  async function readZipJson(file) {
    const buf = await file.arrayBuffer(), v = new DataView(buf), u8 = new Uint8Array(buf), td = new TextDecoder();
    let e = buf.byteLength - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("not a zip");
    let p = v.getUint32(e + 16, true);
    const count = v.getUint16(e + 10, true);
    for (let i = 0; i < count && v.getUint32(p, true) === 0x02014b50; i++) {
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true),
        el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (!name.endsWith(".json")) continue;
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return td.decode(data);
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    throw new Error("no json in zip");
  }

  async function importTools(file) {
    try {
      if (file.size > 5e6) throw new Error("too big");
      const txt = file.name.endsWith(".json") ? await file.text() : await readZipJson(file);
      const data = JSON.parse(txt).data;
      if (!Array.isArray(data)) throw new Error("bad format");
      const have = new Set(S.data.tools.map(t => t.name.toLowerCase()));
      const rows = data.filter(t => t && t.geometry && t.geometry.DC > 0).map(t => {
        const g = t.geometry, k = t.unit === "inches" ? IN : 1;
        const dia = +(g.DC * k).toFixed(3);
        return { name: String(t.description || "Tool").trim().slice(0, 120) || "Tool", kind: t.type === "face mill" ? "face" : "flat", nominal_mm: dia,
          actual_mm: dia, flutes: Math.min(12, Math.max(1, g.NOF || 1)), flute_len_mm: +((g.LCF || 10) * k).toFixed(2), overall_mm: +((g.OAL || 0) * k).toFixed(1),
          shank_mm: 0, mat: t.BMC === "hss" ? "hss" : "carbide" };
      }).filter(r => !have.has(r.name.toLowerCase()));
      if (!rows.length) return toast("Nothing new to import");
      if (!confirm(`Import ${rows.length} new tool(s)?\n\n${rows.map(r => r.name).join("\n")}\n\nFusion stores the nominal size; edit each tool's actual diameter if it runs undersized.`)) return;
      await api("POST", "/api/tools", rows); toast("Imported"); await reload();
    } catch (e) { toast("Could not read that tool file"); }
  }

  if (hashTab) S.tab = hashTab;
  load().then(() => { chrome(); render(); }).catch(e => { $("#view").innerHTML = `<section>Failed to load: ${esc(e.message)}</section>`; });
})();
